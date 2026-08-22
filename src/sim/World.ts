/**
 * Simulação autoritativa da arena. O cliente só manda entrada e desenha o que
 * volta — nenhuma decisão de posição, dano, morte ou promoção nasce lá.
 *
 * Ordem de cada tick (espelha o `update` + `postupdate` da cena original):
 *   1. entrada / IA  -> define velocidade
 *   2. integra a velocidade
 *   3. resolve colisões entre personagens
 *   4. prende ao mapa (o clamp é a última palavra sobre a posição)
 *   5. aplica os golpes cujo windup venceu
 *   6. processa respawn de bots
 *
 * Diferenças deliberadas em relação ao cliente offline, todas anotadas no ponto
 * onde acontecem: velocidade zerada durante o golpe, `atkSide` congelado no
 * início do ataque, respawn por zona de time e alvo definido pelo time real.
 */
import { Actor } from "./Actor.js";
import { resolveCollisions } from "./CollisionResolver.js";
import {
    rectangleOverlapsEllipse, circleOverlapsEllipse, diamondOverlapsEllipse, Rect,
} from "./geometry.js";
import { angleBetween, clamp, distance, randInt } from "./mathx.js";
import {
    ATTACK_MOVE_FACTOR, BOT_ATTACK_COOLDOWN_MS, BOT_ATTACK_RANGE_SLACK,
    BOT_ATTACK_RATE_PER_SECOND, BOT_EDGE_MARGIN, BOT_RESPAWN_DELAY_MS,
    BOT_SPEED_FACTOR, DAMAGE_CHARGED, DAMAGE_NORMAL, HUMAN_RESPAWN_DELAY_MS,
    INPUT_TIMEOUT_MS, KNOCKBACK_DECAY_MS, KNOCKBACK_MIN_SPEED,
    BOT_CHARGE_HOLD_MS, RESPAWN_INVULN_MS, Team, WORLD_HEIGHT, WORLD_WIDTH,
    BOT_DASH_COOLDOWN_MS, BOT_DODGE_CHANCE, BOT_DODGE_RANGE_SLACK, BOT_DODGE_REACTION_MS,
    DASH_COOLDOWN_MS, DASH_DISTANCE, DASH_INVULN_MS, DASH_SPEED, DASH_TIMEOUT_MS,
    attackHalfBand, attackReach, knockbackSpeed,
    attackRecoveryMs, attackWindupMs, chargeAreaMult, chargeDamage, chargePower,
} from "./constants.js";

/** Evento de combate emitido para o cliente reagir (som, shake, feedback). */
export interface KillEvent {
    killerId: string;
    victimId: string;
}

export class World {
    readonly actors = new Map<string, Actor>();

    /** Relógio da sala em ms. Só avança dentro de `tick`. */
    now = 0;

    /** Mortes ocorridas no tick corrente; a sala consome e limpa. */
    kills: KillEvent[] = [];

    private nextBotId = 0;

    // -----------------------------------------------------------------------
    // CICLO DE VIDA DOS PERSONAGENS
    // -----------------------------------------------------------------------

    addPlayer(sessionId: string, team: Team, name: string): Actor {
        const actor = new Actor(sessionId, team, false, name);
        actor.sessionId = sessionId;
        actor.lastInputAt = this.now;
        this.placeAtSpawn(actor);
        this.actors.set(actor.id, actor);
        return actor;
    }

    addBot(team: Team): Actor {
        const id = "bot_" + (this.nextBotId++);
        const actor = new Actor(id, team, true, "Bot " + this.nextBotId);
        actor.wanderTimer = randInt(1000, 3000);
        this.placeAtSpawn(actor);
        this.actors.set(id, actor);
        return actor;
    }

    remove(id: string): void {
        this.actors.delete(id);
    }

    /** Um bot qualquer do time, ou undefined. Usado para abrir vaga a humanos. */
    findBot(team: Team): Actor | undefined {
        for (const actor of this.actors.values()) {
            if (actor.isBot && actor.team === team) return actor;
        }
        return undefined;
    }

    countTeam(team: Team, humansOnly = false): number {
        let n = 0;
        for (const actor of this.actors.values()) {
            if (actor.team !== team) continue;
            if (humansOnly && actor.isBot) continue;
            n++;
        }
        return n;
    }

    /**
     * Posiciona no lado do próprio time. O original espalhava todo mundo pelo
     * mapa inteiro; com times de verdade isso fazia o jogador renascer dentro
     * do inimigo.
     */
    private placeAtSpawn(actor: Actor): void {
        const margin = 200;
        const minX = actor.team === "ally" ? margin : Math.round(WORLD_WIDTH * 0.7);
        const maxX = actor.team === "ally" ? Math.round(WORLD_WIDTH * 0.3) : WORLD_WIDTH - margin;

        actor.x = randInt(minX, maxX);
        actor.y = randInt(margin, WORLD_HEIGHT - margin);
        actor.clampToWorld();
    }

    // -----------------------------------------------------------------------
    // ENTRADA DOS CLIENTES
    // -----------------------------------------------------------------------

    /**
     * Vetor de movimento normalizado. Nunca confie no módulo enviado.
     *
     * `seq` é o contador do cliente; volta em `ActorState.ack` para ele
     * reconciliar a previsão. Pacote com seq menor ou igual ao já processado é
     * reordenação (ou cliente adulterado) e o vetor é ignorado — mas o
     * `lastInputAt` ainda conta, senão INPUT_TIMEOUT_MS mataria o movimento.
     */
    setInput(actor: Actor, dx: number, dy: number, seq: number): void {
        actor.lastInputAt = this.now;

        if (!Number.isFinite(seq) || seq <= actor.inputSeq) return;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;

        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 1) {
            dx /= len;
            dy /= len;
        }
        actor.inputDx = clamp(dx, -1, 1);
        actor.inputDy = clamp(dy, -1, 1);
        actor.inputSeq = seq;
    }

    startCharge(actor: Actor): void {
        if (!actor.alive || actor.attacking || actor.charging) return;
        // Recuperação do golpe anterior. É aqui que o spam morre: mesmo um
        // cliente adulterado mandando "a" a 60 Hz não começa carga nenhuma
        // enquanto este prazo não vence.
        if (this.now < actor.attackReadyAt) return;
        actor.charging = true;
        actor.chargeStartedAt = this.now;
        actor.chargeRatio = 0;
    }

    /**
     * O servidor mede a carga pelo próprio relógio. O cliente informa apenas
     * "soltei o botão" — não pode alegar que carregou.
     */
    releaseAttack(actor: Actor): void {
        if (!actor.alive || !actor.charging) return;

        // A potência sai do relógio da sala contra o `chargeTime` do rank, e o
        // clamp dentro de `chargePower` é o teto absoluto: segurar dez segundos
        // dá exatamente o mesmo golpe que segurar o tempo do rank.
        const elapsed = this.now - actor.chargeStartedAt;
        const power = chargePower(elapsed, actor.rank.chargeTime);

        actor.charging = false;
        actor.chargeRatio = 0;
        this.beginAttack(actor, power);
    }

    /**
     * Pedido de dash. O cliente manda só o pedido — sem direção, sem duração e
     * sem tempo. Aqui é que se decide se pode e para onde.
     *
     * A direção sai da ÚLTIMA entrada recebida deste ator (ou do lado para onde
     * ele olha, se estiver parado). Deixar o cliente informar o vetor abriria a
     * porta para dash em direção arbitrária, e o cooldown vive aqui pelo mesmo
     * motivo: mensagem repetida em rajada simplesmente cai neste `return`.
     *
     * @returns true se o dash começou.
     */
    requestDash(actor: Actor): boolean {
        if (!actor.alive || actor.frozen) return false;
        if (this.now < actor.dashReadyAt) return false;
        // Durante o golpe não: o dash viraria um jeito de arrastar a hitbox do
        // ataque para cima do alvo depois do windup já ter começado.
        if (actor.attacking) return false;

        let dx = actor.inputDx;
        let dy = actor.inputDy;
        if (dx === 0 && dy === 0) {
            dx = actor.flipX ? -1 : 1;
            dy = 0;
        }

        const length = Math.hypot(dx, dy) || 1;
        this.startDash(actor, dx / length, dy / length);
        return true;
    }

    /** Início do dash em si. Usado pelo pedido do jogador e pela IA. */
    private startDash(actor: Actor, dirX: number, dirY: number): void {
        actor.dashDirX = dirX;
        actor.dashDirY = dirY;
        actor.dashUntil = this.now + DASH_TIMEOUT_MS;
        actor.dashRemaining = DASH_DISTANCE;
        // O cooldown conta do INÍCIO do dash, não do fim: assim mexer na
        // duração não muda a cadência da habilidade.
        actor.dashReadyAt = this.now +
            (actor.isBot ? BOT_DASH_COOLDOWN_MS : DASH_COOLDOWN_MS);

        // Nunca encurta uma invulnerabilidade maior já em curso (dano recente,
        // respawn) — só estende, se o dash der mais.
        actor.invulnUntil = Math.max(actor.invulnUntil, this.now + DASH_INVULN_MS);

        // Carga em curso é cancelada: sair rolando com o golpe engatilhado
        // deixaria o alcance carregado de graça depois da esquiva.
        if (actor.charging) {
            actor.charging = false;
            actor.chargeRatio = 0;
        }

        if (dirX !== 0) actor.flipX = dirX < 0;
    }

    /** Renascer é pedido pelo cliente (botão RENASCER), com carência mínima. */
    requestRespawn(actor: Actor): void {
        if (actor.alive || this.now < actor.respawnAt) return;
        this.respawn(actor);
    }

    // -----------------------------------------------------------------------
    // TICK
    // -----------------------------------------------------------------------

    tick(deltaMs: number): void {
        this.now += deltaMs;
        const dt = deltaMs / 1000;

        for (const actor of this.actors.values()) {
            if (!actor.alive) continue;
            if (actor.isBot) this.stepBot(actor, deltaMs);
            else this.stepPlayer(actor, deltaMs);
        }

        for (const actor of this.actors.values()) {
            if (!actor.alive) continue;
            actor.x += (actor.vx + actor.knockbackVx) * dt;
            actor.y += (actor.vy + actor.knockbackVy) * dt;
            this.decayKnockback(actor, deltaMs);
        }

        resolveCollisions(this.actors.values());

        for (const actor of this.actors.values()) {
            if (actor.alive) actor.clampToWorld();
        }

        // Golpes cujo windup venceu neste tick.
        for (const actor of this.actors.values()) {
            if (actor.attacking && this.now >= actor.attackHitAt) {
                if (actor.alive) this.executeAttackHit(actor);
                actor.attacking = false;
                actor.chargePower = 0;
                actor.hitThisAttack.clear();
            }
        }

        // Bots renascem sozinhos; humanos esperam o botão RENASCER.
        for (const actor of this.actors.values()) {
            if (!actor.alive && actor.isBot && this.now >= actor.respawnAt) {
                this.respawn(actor);
            }
        }
    }

    private stepPlayer(actor: Actor, deltaMs: number): void {
        if (actor.charging) {
            const elapsed = this.now - actor.chargeStartedAt;
            actor.chargeRatio = clamp(elapsed / actor.rank.chargeTime, 0, 1);
        }

        if (actor.frozen) {
            actor.vx = 0;
            actor.vy = 0;
            return;
        }

        // Cliente calado: para de andar. Sem isto, uma aba em segundo plano
        // (o Phaser pausa o loop e ninguém mais envia nada) deixa o boneco
        // correndo com o último vetor até bater na borda do mapa.
        if (this.now - actor.lastInputAt > INPUT_TIMEOUT_MS) {
            actor.inputDx = 0;
            actor.inputDy = 0;
        }

        // Dash manda na velocidade enquanto dura: a entrada do jogador não
        // desvia nem freia o impulso. Como só troca `vx`/`vy`, o resto do tick
        // (colisão entre personagens, clamp do mapa) continua valendo — nada de
        // teleporte nem de atravessar quem estiver no caminho.
        if (actor.isDashing(this.now)) {
            const speed = actor.consumeDashSpeed(deltaMs / 1000, DASH_SPEED);
            actor.vx = actor.dashDirX * speed;
            actor.vy = actor.dashDirY * speed;
            return;
        }

        // Durante o golpe anda devagar em vez de parar. Ver ATTACK_MOVE_FACTOR.
        const speed = actor.rank.speed * (actor.attacking ? ATTACK_MOVE_FACTOR : 1);
        actor.vx = actor.inputDx * speed;
        actor.vy = actor.inputDy * speed;

        if (actor.inputDx !== 0) actor.flipX = actor.inputDx < 0;
    }

    private stepBot(actor: Actor, deltaMs: number): void {
        if (actor.isDashing(this.now)) {
            const speed = actor.consumeDashSpeed(deltaMs / 1000, DASH_SPEED);
            actor.vx = actor.dashDirX * speed;
            actor.vy = actor.dashDirY * speed;
            return;
        }

        const nearest = this.findNearestOpponent(actor);
        let moveAngle: number;

        if (nearest) {
            moveAngle = angleBetween(actor.x, actor.y, nearest.x, nearest.y);
        } else {
            actor.wanderTimer -= deltaMs;
            if (actor.wanderTimer <= 0) {
                actor.wanderAngle = Math.random() * Math.PI * 2;
                actor.wanderTimer = randInt(1000, 3000);
            }
            moveAngle = actor.wanderAngle;
        }

        // Evasão de bordas.
        const m = BOT_EDGE_MARGIN;
        if (actor.x < m && Math.cos(moveAngle) < 0) moveAngle = 0;
        else if (actor.x > WORLD_WIDTH - m && Math.cos(moveAngle) > 0) moveAngle = Math.PI;

        if (actor.y < m && Math.sin(moveAngle) < 0) moveAngle = Math.PI / 2;
        else if (actor.y > WORLD_HEIGHT - m && Math.sin(moveAngle) > 0) moveAngle = -Math.PI / 2;

        const speed = actor.rank.speed * BOT_SPEED_FACTOR *
            (actor.attacking ? ATTACK_MOVE_FACTOR : 1);
        actor.vx = Math.cos(moveAngle) * speed;
        actor.vy = Math.sin(moveAngle) * speed;

        if (actor.vx < 0) actor.flipX = true;
        else if (actor.vx > 0) actor.flipX = false;

        // Golpe em curso: só o movimento acima continua, nada de encadear
        // carga ou novo ataque antes de o atual terminar.
        if (actor.attacking) return;

        if (this.tryBotDodge(actor, nearest)) return;

        if (actor.charging) {
            this.stepBotCharge(actor, nearest);
            return;
        }

        actor.attackCooldown -= deltaMs;
        if (actor.attackCooldown > 0 || nearest === undefined) return;

        // Os dois extremos da escala: o golpe que sai agora e o que sairia com
        // a carga cheia. É o que a decisão de carregar compara.
        const alcancaNormal = this.botCanHit(actor, nearest, chargeAreaMult(0));
        const alcancaCarregado = this.botCanHit(actor, nearest, chargeAreaMult(1));
        if (!alcancaNormal && !alcancaCarregado) return;

        // Taxa por segundo convertida na chance desta janela de `deltaMs`.
        // Manter a conversão aqui (e não uma constante por tick) é o que torna
        // a agressividade independente de TICK_MS.
        const chance = 1 - Math.exp(-BOT_ATTACK_RATE_PER_SECOND * (deltaMs / 1000));
        if (Math.random() >= chance) return;

        actor.flipX = nearest.x < actor.x;

        if (this.botShouldCharge(nearest, alcancaNormal, alcancaCarregado)) {
            this.startCharge(actor);
            return;
        }

        this.beginAttack(actor, 0);
        actor.attackCooldown = BOT_ATTACK_COOLDOWN_MS;
    }

    /**
     * O bot esquiva de um golpe que está vindo?
     *
     * Quatro filtros, nesta ordem porque ficam cada vez mais caros: cooldown,
     * existe golpe inimigo em curso, o atacante está perto o bastante para
     * acertar, e o tempo de reação já passou. Só então rola o dado — UMA vez
     * por golpe, com a chave `attackHitAt` do atacante guardada em
     * `dodgeRolledFor`. Sorteando a cada tick, os 200 ms de windup dariam ~4
     * sorteios e qualquer chance viraria quase certeza: o bot esquivaria de
     * tudo e pareceria ler pensamento.
     *
     * A esquiva sai na direção oposta à do atacante — o mesmo vetor que o
     * empurrão do golpe usaria.
     */
    private tryBotDodge(actor: Actor, threat: Actor | undefined): boolean {
        if (this.now < actor.dashReadyAt) return false;
        if (threat === undefined || !threat.attacking) return false;

        // Já sorteou por este golpe: não tenta de novo nos ticks seguintes.
        if (actor.dodgeRolledFor === threat.attackHitAt) return false;

        const janela = attackWindupMs(threat.chargePower);
        const elapsed = janela - (threat.attackHitAt - this.now);
        if (elapsed < BOT_DODGE_REACTION_MS) return false;

        const from = threat.ellipseCenter();
        const to = actor.ellipseCenter();
        const dx = to.x - from.x;
        const dy = to.y - from.y;

        const mult = chargeAreaMult(threat.chargePower);
        const perigo = (threat.collisionRx + attackReach(threat.rank) * mult + actor.collisionRx)
            * BOT_DODGE_RANGE_SLACK;
        if (dx * dx + dy * dy > perigo * perigo) return false;

        // Percebeu o golpe: gasta o sorteio deste ataque, acertando ou não.
        actor.dodgeRolledFor = threat.attackHitAt;
        if (Math.random() >= BOT_DODGE_CHANCE) return false;

        const length = Math.hypot(dx, dy);
        if (length < 1e-3) {
            this.startDash(actor, threat.flipX ? -1 : 1, 0);
        } else {
            this.startDash(actor, dx / length, dy / length);
        }
        return true;
    }

    /**
     * Vale a pena carregar em vez de bater logo?
     *
     * Carregar NÃO rende mais dano por segundo — o ciclo normal (cooldown 700
     * + windup 200) tira ~28/s, e o carregado, com a espera do `chargeTime`,
     * fica em torno de ~26/s. Ou seja, carregar é ferramenta de situação, não
     * a jogada padrão. As duas situações em que compensa:
     *
     *   1. FINALIZAÇÃO — a vida do alvo está na janela em que o carregado mata
     *      e o normal não. Abater promove e dá aura, o que vale bem mais que a
     *      diferença de dano.
     *   2. APROXIMAÇÃO — o alvo está fora do alcance normal mas dentro do
     *      carregado (que dobra o alcance). Aqui carregar é de graça: não
     *      existia golpe possível de qualquer forma.
     */
    private botShouldCharge(
        target: Actor, alcancaNormal: boolean, alcancaCarregado: boolean,
    ): boolean {
        if (!alcancaCarregado) return false;

        const finaliza = target.currentHealth > DAMAGE_NORMAL
            && target.currentHealth <= DAMAGE_CHARGED;

        return finaliza || !alcancaNormal;
    }

    /** Bot com carga em curso: persegue enquanto carrega e escolhe quando soltar. */
    private stepBotCharge(actor: Actor, nearest: Actor | undefined): void {
        const elapsed = this.now - actor.chargeStartedAt;
        actor.chargeRatio = clamp(elapsed / actor.rank.chargeTime, 0, 1);

        // Alvo morreu ou sumiu: não há o que finalizar, desiste sem gastar golpe.
        if (nearest === undefined) {
            actor.charging = false;
            actor.chargeRatio = 0;
            return;
        }

        if (elapsed < actor.rank.chargeTime) return;

        // Carga pronta: solta assim que o alvo estiver ao alcance dobrado, ou
        // desiste de esperar depois de BOT_CHARGE_HOLD_MS.
        const esperouDemais = elapsed - actor.rank.chargeTime >= BOT_CHARGE_HOLD_MS;
        if (!this.botCanHit(actor, nearest, chargeAreaMult(1)) && !esperouDemais) return;

        actor.flipX = nearest.x < actor.x;
        this.releaseAttack(actor);
        actor.attackCooldown = BOT_ATTACK_COOLDOWN_MS;
    }

    /**
     * O golpe do bot tem chance real de acertar este alvo?
     *
     * Reproduz de forma barata o que `executeAttackHit` testaria: distância
     * dentro do alcance do rank e — para os golpes retos — alvo na faixa à
     * frente. Não é exato de propósito; errar às vezes é o esperado.
     *
     * @param mult Multiplicador de área a testar — `chargeAreaMult(0)` para o
     *        golpe leve, `chargeAreaMult(1)` para a carga cheia. É o mesmo
     *        fator que `executeAttackHit` aplica às dimensões da forma.
     */
    private botCanHit(actor: Actor, target: Actor, mult: number): boolean {
        // Bater em quem acabou de renascer ou de levar dano só gasta o cooldown.
        if (target.isInvulnerable(this.now)) return false;

        const from = actor.ellipseCenter();
        const to = target.ellipseCenter();
        const dx = to.x - from.x;
        const dy = to.y - from.y;

        const reach = actor.collisionRx + attackReach(actor.rank) * mult
            + target.collisionRx + BOT_ATTACK_RANGE_SLACK;
        // Compara os quadrados: evita a raiz quadrada a cada tick por bot.
        if (dx * dx + dy * dy > reach * reach) return false;

        // `Infinity` nos golpes radiais passa direto, sem ramificação extra.
        return Math.abs(dy) <= attackHalfBand(actor.rank) * mult + target.collisionRy;
    }

    // -----------------------------------------------------------------------
    // COMBATE
    // -----------------------------------------------------------------------

    private opponentsOf(actor: Actor): Actor[] {
        const out: Actor[] = [];
        for (const other of this.actors.values()) {
            if (other.alive && other.team !== actor.team) out.push(other);
        }
        return out;
    }

    private findNearestOpponent(actor: Actor): Actor | undefined {
        let nearest: Actor | undefined;
        let nearestDist = Infinity;
        for (const other of this.opponentsOf(actor)) {
            const d = distance(actor.x, actor.y, other.x, other.y);
            if (d < nearestDist) {
                nearestDist = d;
                nearest = other;
            }
        }
        return nearest;
    }

    private beginAttack(actor: Actor, power: number): void {
        if (actor.attacking || !actor.alive) return;
        if (this.now < actor.attackReadyAt) return;

        actor.attacking = true;
        actor.chargePower = power;
        // Golpe mais carregado demora mais para sair: é essa janela que o alvo
        // tem para esquivar do golpe pesado.
        actor.attackHitAt = this.now + attackWindupMs(power);
        actor.attackReadyAt = actor.attackHitAt + attackRecoveryMs(power);
        actor.hitThisAttack.clear();

        // A perna do L do cavalo aponta para o inimigo mais próximo. Fica
        // congelada aqui: o cliente desenha esse mesmo lado durante todo o
        // golpe, então recalcular no impacto (como no offline) faria o dano
        // sair de um lugar diferente do que apareceu na tela.
        const nearest = this.findNearestOpponent(actor);
        actor.atkSide = nearest && nearest.y > actor.y ? 1 : -1;
    }

    /**
     * Aplica o dano do golpe. A geometria tem de bater exatamente com o que o
     * cliente desenha em `ArenaActor.drawAttackVisual()`.
     */
    private executeAttackHit(attacker: Actor): void {
        const atk = attacker.rank.attack;
        const center = attacker.ellipseCenter();
        const dir = attacker.flipX ? -1 : 1;
        const startX = center.x + dir * attacker.collisionRx;
        const startY = center.y;

        // Área e dano saem da mesma potência; os dois já vêm com teto embutido
        // (AREA_MULT_MAX e DAMAGE_MAX). A geometria abaixo não mudou: continua
        // recebendo um multiplicador, que agora é fracionário.
        const mult = chargeAreaMult(attacker.chargePower);
        const damage = chargeDamage(attacker.chargePower);
        const targets = this.opponentsOf(attacker);

        const hits = (test: (t: Actor) => boolean) => {
            for (const target of targets) {
                if (attacker.hitThisAttack.has(target.id)) continue;
                if (test(target)) this.applyDamage(attacker, target, damage);
            }
        };

        switch (atk.type) {
            case "rectangle": {
                const w = atk.length * mult;
                const h = atk.width * mult;
                const rect: Rect = { x: dir === 1 ? startX : startX - w, y: startY - h / 2, w, h };
                hits((t) => {
                    const c = t.ellipseCenter();
                    return rectangleOverlapsEllipse(rect, c.x, c.y, t.collisionRx, t.collisionRy);
                });
                break;
            }

            case "circle": {
                const radius = atk.radius * mult;
                hits((t) => {
                    const c = t.ellipseCenter();
                    return circleOverlapsEllipse(center.x, center.y, radius, c.x, c.y, t.collisionRx, t.collisionRy);
                });
                break;
            }

            case "lshape": {
                const forwardLength = atk.forwardLength * mult;
                const sideLength = atk.sideLength * mult;
                const width = atk.width * mult;

                const forwardX = dir === 1 ? startX : startX - forwardLength;
                const forwardRect: Rect = {
                    x: forwardX, y: startY - width / 2, w: forwardLength, h: width,
                };

                const forwardEndX = startX + dir * forwardLength;
                const sideRect: Rect = {
                    x: forwardEndX - width / 2,
                    y: startY + (attacker.atkSide * sideLength) / 2 - sideLength / 2,
                    w: width,
                    h: sideLength,
                };

                hits((t) => {
                    const c = t.ellipseCenter();
                    return rectangleOverlapsEllipse(forwardRect, c.x, c.y, t.collisionRx, t.collisionRy)
                        || rectangleOverlapsEllipse(sideRect, c.x, c.y, t.collisionRx, t.collisionRy);
                });
                break;
            }

            case "diamond": {
                const radius = atk.radius * mult;
                hits((t) => {
                    const c = t.ellipseCenter();
                    return diamondOverlapsEllipse(center.x, center.y, radius, c.x, c.y, t.collisionRx, t.collisionRy);
                });
                break;
            }
        }
    }

    private applyDamage(attacker: Actor, target: Actor, damage: number): void {
        attacker.hitThisAttack.add(target.id);

        // Golpe que não conecta não empurra. Sem esta guarda, quem acabou de
        // renascer (ou de levar dano) seria arrastado pelo mapa sem perder
        // vida — `takeDamage` recusa o dano, mas o empurrão passaria.
        if (target.isInvulnerable(this.now)) return;

        const killed = target.takeDamage(damage, this.now);

        // Cada alvo é empurrado na SUA direção (do atacante para ele), então
        // um golpe que pega três inimigos os espalha em leque, não em bloco.
        // Vem antes do abate: `kill()` zera o empurrão de quem morreu.
        this.pushBack(attacker, target);

        if (!killed) return;

        attacker.addAuraFromKill(target);
        attacker.promote();
        attacker.kills++;
        target.deaths++;
        this.kill(target);
        this.kills.push({ killerId: attacker.id, victimId: target.id });
    }

    /** Empurra `target` para longe de `attacker`, com a força do golpe atual. */
    private pushBack(attacker: Actor, target: Actor): void {
        const from = attacker.ellipseCenter();
        const to = target.ellipseCenter();
        let dx = to.x - from.x;
        let dy = to.y - from.y;
        let length = Math.hypot(dx, dy);

        // Centros praticamente coincidentes: sem direção definida, empurra
        // para onde o atacante está olhando.
        if (length < 1e-3) {
            dx = attacker.flipX ? -1 : 1;
            dy = 0;
            length = 1;
        }

        const speed = knockbackSpeed(attacker.chargePower, target.rank.mass);
        target.knockbackVx = (dx / length) * speed;
        target.knockbackVy = (dy / length) * speed;
    }

    /** Decaimento exponencial: independe do tamanho do tick. */
    private decayKnockback(actor: Actor, deltaMs: number): void {
        if (actor.knockbackVx === 0 && actor.knockbackVy === 0) return;

        const decay = Math.exp(-deltaMs / KNOCKBACK_DECAY_MS);
        actor.knockbackVx *= decay;
        actor.knockbackVy *= decay;

        if (Math.hypot(actor.knockbackVx, actor.knockbackVy) < KNOCKBACK_MIN_SPEED) {
            actor.knockbackVx = 0;
            actor.knockbackVy = 0;
        }
    }

    private kill(actor: Actor): void {
        actor.alive = false;
        actor.currentHealth = 0;
        actor.aura = 0;
        actor.vx = 0;
        actor.vy = 0;
        actor.knockbackVx = 0;
        actor.knockbackVy = 0;
        actor.inputDx = 0;
        actor.inputDy = 0;
        actor.cancelAttack();
        actor.cancelDash();
        actor.respawnAt = this.now + (actor.isBot ? BOT_RESPAWN_DELAY_MS : HUMAN_RESPAWN_DELAY_MS);
    }

    private respawn(actor: Actor): void {
        actor.resetToPawn();
        actor.aura = 0;
        actor.alive = true;
        actor.vx = 0;
        actor.vy = 0;
        actor.knockbackVx = 0;
        actor.knockbackVy = 0;
        actor.inputDx = 0;
        actor.inputDy = 0;
        actor.cancelAttack();
        actor.cancelDash();
        this.placeAtSpawn(actor);
        actor.invulnUntil = this.now + RESPAWN_INVULN_MS;
        if (actor.isBot) actor.attackCooldown = 0;
    }
}
