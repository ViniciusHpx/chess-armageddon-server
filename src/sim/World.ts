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
    ATTACK_WINDUP_MS, BOT_ATTACK_COOLDOWN_MS, BOT_ATTACK_RANGE_SLACK,
    BOT_ATTACK_RATE_PER_SECOND, BOT_EDGE_MARGIN, BOT_RESPAWN_DELAY_MS,
    BOT_SPEED_FACTOR, DAMAGE_CHARGED, DAMAGE_NORMAL, HUMAN_RESPAWN_DELAY_MS,
    INPUT_TIMEOUT_MS, RESPAWN_INVULN_MS, Team, WORLD_HEIGHT, WORLD_WIDTH,
    attackHalfBand, attackReach,
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

        const elapsed = this.now - actor.chargeStartedAt;
        const charged = elapsed >= actor.rank.chargeTime;

        actor.charging = false;
        actor.chargeRatio = 0;
        this.beginAttack(actor, charged);
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
            else this.stepPlayer(actor);
        }

        for (const actor of this.actors.values()) {
            if (!actor.alive) continue;
            actor.x += actor.vx * dt;
            actor.y += actor.vy * dt;
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
                actor.charged = false;
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

    private stepPlayer(actor: Actor): void {
        if (actor.charging) {
            const elapsed = this.now - actor.chargeStartedAt;
            actor.chargeRatio = clamp(elapsed / actor.rank.chargeTime, 0, 1);
        }

        // Durante o golpe o personagem fica parado. No cliente offline a
        // velocidade anterior persistia e o boneco deslizava por 200 ms.
        if (actor.attacking || actor.frozen) {
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

        const speed = actor.rank.speed;
        actor.vx = actor.inputDx * speed;
        actor.vy = actor.inputDy * speed;

        if (actor.inputDx !== 0) actor.flipX = actor.inputDx < 0;
    }

    private stepBot(actor: Actor, deltaMs: number): void {
        if (actor.attacking) {
            actor.vx = 0;
            actor.vy = 0;
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

        const speed = actor.rank.speed * BOT_SPEED_FACTOR;
        actor.vx = Math.cos(moveAngle) * speed;
        actor.vy = Math.sin(moveAngle) * speed;

        if (actor.vx < 0) actor.flipX = true;
        else if (actor.vx > 0) actor.flipX = false;

        actor.attackCooldown -= deltaMs;
        if (actor.attackCooldown > 0 || nearest === undefined) return;
        if (!this.botCanHit(actor, nearest)) return;

        // Taxa por segundo convertida na chance desta janela de `deltaMs`.
        // Manter a conversão aqui (e não uma constante por tick) é o que torna
        // a agressividade independente de TICK_MS.
        const chance = 1 - Math.exp(-BOT_ATTACK_RATE_PER_SECOND * (deltaMs / 1000));
        if (Math.random() >= chance) return;

        actor.flipX = nearest.x < actor.x;
        this.beginAttack(actor, false);
        actor.attackCooldown = BOT_ATTACK_COOLDOWN_MS;
    }

    /**
     * O golpe do bot tem chance real de acertar este alvo?
     *
     * Reproduz de forma barata o que `executeAttackHit` testaria: distância
     * dentro do alcance do rank e — para os golpes retos — alvo na faixa à
     * frente. Não é exato de propósito; errar às vezes é o esperado.
     */
    private botCanHit(actor: Actor, target: Actor): boolean {
        // Bater em quem acabou de renascer ou de levar dano só gasta o cooldown.
        if (target.isInvulnerable(this.now)) return false;

        const from = actor.ellipseCenter();
        const to = target.ellipseCenter();
        const dx = to.x - from.x;
        const dy = to.y - from.y;

        const reach = actor.collisionRx + attackReach(actor.rank)
            + target.collisionRx + BOT_ATTACK_RANGE_SLACK;
        // Compara os quadrados: evita a raiz quadrada a cada tick por bot.
        if (dx * dx + dy * dy > reach * reach) return false;

        // `Infinity` nos golpes radiais passa direto, sem ramificação extra.
        return Math.abs(dy) <= attackHalfBand(actor.rank) + target.collisionRy;
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

    private beginAttack(actor: Actor, charged: boolean): void {
        if (actor.attacking || !actor.alive) return;

        actor.attacking = true;
        actor.charged = charged;
        actor.attackHitAt = this.now + ATTACK_WINDUP_MS;
        actor.hitThisAttack.clear();
        actor.vx = 0;
        actor.vy = 0;

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

        const mult = attacker.charged ? 2 : 1;
        const damage = attacker.charged ? DAMAGE_CHARGED : DAMAGE_NORMAL;
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
        const killed = target.takeDamage(damage, this.now);
        if (!killed) return;

        attacker.addAuraFromKill(target);
        attacker.promote();
        attacker.kills++;
        target.deaths++;
        this.kill(target);
        this.kills.push({ killerId: attacker.id, victimId: target.id });
    }

    private kill(actor: Actor): void {
        actor.alive = false;
        actor.currentHealth = 0;
        actor.aura = 0;
        actor.vx = 0;
        actor.vy = 0;
        actor.inputDx = 0;
        actor.inputDy = 0;
        actor.cancelAttack();
        actor.respawnAt = this.now + (actor.isBot ? BOT_RESPAWN_DELAY_MS : HUMAN_RESPAWN_DELAY_MS);
    }

    private respawn(actor: Actor): void {
        actor.resetToPawn();
        actor.aura = 0;
        actor.alive = true;
        actor.vx = 0;
        actor.vy = 0;
        actor.inputDx = 0;
        actor.inputDy = 0;
        actor.cancelAttack();
        this.placeAtSpawn(actor);
        actor.invulnUntil = this.now + RESPAWN_INVULN_MS;
        if (actor.isBot) actor.attackCooldown = 0;
    }
}
