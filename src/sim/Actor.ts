/**
 * Personagem headless. Porte de `PlayerBase` sem nada de Phaser: só posição,
 * vida, rank, aura e a máquina de estados do ataque. Todo o visual (Graphics,
 * partículas, tweens, tint) ficou no cliente.
 *
 * Os temporizadores do original eram `scene.time.delayedCall`; aqui são
 * instantes absolutos em ms (`World.now`) comparados a cada tick, para que a
 * simulação dependa só do relógio da sala.
 */
import {
    RANKS, RankKey, RankConfig, AURA_KILL_VALUES, Team,
    WORLD_WIDTH, WORLD_HEIGHT, HIT_INVULN_MS,
    levelFromXp, rankKeyForLevel, XP_PER_LEVEL, MAX_LEVEL,
} from "./constants.js";
import { clamp } from "./mathx.js";

export class Actor {
    readonly id: string;
    team: Team;
    isBot: boolean;
    name: string;

    /** sessionId do cliente que controla este ator (vazio se for bot). */
    sessionId = "";

    x = 0;
    y = 0;

    /**
     * Última posição em que o personagem cabia sem encostar em parede.
     *
     * Serve de rede quando a separação entre personagens ou o clamp da borda
     * empurram alguém para dentro do cenário: em vez de aceitar a posição
     * inválida, o `World` devolve para cá.
     */
    lastValidX = 0;
    lastValidY = 0;
    vx = 0;
    vy = 0;
    flipX = false;

    rankKey: RankKey = "PAWN";
    maxHealth = RANKS.PAWN.health;
    currentHealth = RANKS.PAWN.health;
    aura = 0;

    /**
     * Experiência acumulada. Só o servidor escreve aqui — o cliente não tem
     * mensagem para mexer em XP, nível ou rank.
     */
    xp = 0;

    alive = true;
    /** Instante a partir do qual pode renascer. */
    respawnAt = 0;

    /**
     * Placar da sessão. Sobrevive à morte e à promoção de propósito: só some
     * quando o ator sai da sala. Ver `World.applyDamage`.
     */
    kills = 0;
    deaths = 0;

    // --- ataque ---
    attacking = false;
    /** Instante em que o dano do golpe em curso será aplicado. */
    attackHitAt = 0;
    /**
     * Potência do golpe em curso, de 0 (toque no botão) a 1 (carga cheia).
     *
     * Substituiu o antigo booleano `charged`. Quem a calcula é o servidor, a
     * partir do próprio relógio (`World.releaseAttack`) — o cliente só informa
     * que apertou e que soltou, então não há valor de carga vindo da rede para
     * alguém inflar.
     */
    chargePower = 0;
    /** Instante a partir do qual pode atacar ou carregar de novo. */
    attackReadyAt = 0;
    /**
     * Para qual lado sai a perna do L do cavalo: -1 ou 1.
     *
     * O lado é medido na PERPENDICULAR ao golpe (ver `attackSideFor`), não no
     * eixo Y do mundo. Enquanto o golpe só saía em X as duas coisas eram a
     * mesma; com o golpe direcional, o Y do mundo mandaria a perna para o lado
     * errado nas diagonais.
     */
    atkSide = 1;

    /**
     * Direção do golpe em curso, em RADIANOS. Contínua em 360°: é o ângulo do
     * vetor de mira (`attackAimAngle`), sem encaixe em direção nenhuma.
     *
     * Congelada em `beginAttack`, pelo mesmo motivo de `atkSide`: o cliente
     * desenha esta direção durante todo o golpe, então mudá-la no meio faria o
     * dano sair de onde não apareceu.
     */
    atkAngle = 0;
    /** Alvos já atingidos pelo golpe atual — evita dano duplo. */
    hitThisAttack = new Set<string>();

    // --- carga ---
    charging = false;
    chargeStartedAt = 0;
    /** 0..1, só para o cliente desenhar o brilho dos outros jogadores. */
    chargeRatio = 0;

    invulnUntil = 0;

    // --- dash / esquiva ---
    /**
     * Teto de tempo do dash em curso (`World.now`); 0 = não está em dash.
     *
     * Quem determina a distância é `dashRemaining`; este prazo só existe para
     * o dash não ficar preso quando o personagem trava contra outro ou contra
     * a borda e o resto nunca é consumido.
     */
    dashUntil = 0;

    /**
     * Distância que ainda falta percorrer no dash, em px.
     *
     * Contar distância em vez de só cronometrar é o que faz o dash render
     * exatamente DASH_DISTANCE nos dois lados: o servidor integra em ticks de
     * 50 ms e o cliente em quadros de ~16 ms, e a diferença de alinhamento
     * dava ~20 px de resto sistemático a cada dash para a reconciliação
     * desfazer.
     */
    dashRemaining = 0;
    /** Instante a partir do qual pode dar outro dash. */
    dashReadyAt = 0;
    /**
     * Quanto a separação corpo-a-corpo moveu este ator no tick corrente.
     *
     * Escrito pelo `CollisionResolver` e lido pelo `World` para saber se um
     * dash esbarrou em alguém (empurrão contra o sentido do dash). Zerado a
     * cada tick pelo próprio resolver.
     */
    separationX = 0;
    separationY = 0;
    /**
     * Dash de travessia em curso (só o cavalo — ver `canPhaseDash`).
     *
     * Enquanto está de pé, a máscara do cenário NÃO vale para este ator: ele
     * está dentro da estrutura por projeto. O ponto de chegada já foi validado
     * antes de o dash começar, e a borda do mapa continua valendo.
     */
    dashPhasing = false;
    /**
     * Ponto de chegada aprovado para a travessia, guardado no início do dash.
     *
     * O dash é um movimento contínuo, mas empurrão de golpe ou separação podem
     * desviá-lo no meio do voo. Se a posição final sair inválida, é para AQUI
     * que o cavalo vai — o ponto que passou pela `canStand` com a elipse
     * inteira. Assim ele nunca termina (nem meio) dentro da estrutura.
     */
    dashTargetX = 0;
    dashTargetY = 0;
    /** Direção do dash, unitária. Congelada no início: virar no meio do dash
     *  quebraria a previsão do cliente, que só sabe a direção do começo. */
    dashDirX = 0;
    dashDirY = 0;
    /**
     * `attackHitAt` do golpe inimigo para o qual este bot já sorteou reação.
     * Guardar a chave é o que garante UM sorteio por golpe. Ver BOT_DODGE_CHANCE.
     */
    dodgeRolledFor = 0;

    /**
     * Empurrão em curso, em px/s. Somado à velocidade na hora de integrar (e
     * não em `stepPlayer`/`stepBot`), para continuar valendo mesmo enquanto o
     * alvo está atacando ou congelado — quem levou o golpe é empurrado de
     * qualquer jeito.
     */
    knockbackVx = 0;
    knockbackVy = 0;

    // --- entrada (humanos) ---
    inputDx = 0;
    inputDy = 0;

    /**
     * Vetor de MIRA do ataque, independente do de movimento: é ele que deixa o
     * jogador andar para um lado e bater para outro.
     *
     * Chega no mesmo pacote `"i"` do movimento, e por isso é lido do mesmo
     * jeito que `requestDash` lê a direção — "a última entrada recebida". Não
     * precisa ser unitário; quem decide o que ele significa é `attackAimAngle`,
     * que aplica a zona morta e devolve o ângulo CONTÍNUO do vetor. Neutro
     * (zerado) significa "sem mira", e aí o golpe sai para onde a peça olha.
     *
     * Os BOTS escrevem aqui também (`World.aimAt`): a direção do golpe deles
     * sai do mesmo vetor, pela mesma função, sem caminho paralelo.
     */
    aimDx = 0;
    aimDy = 0;

    /**
     * O cliente pode ARMAR uma direção nova?
     *
     * Uma direção vale por UM golpe: `beginAttack` a consome e fecha esta
     * porta; ela só reabre quando chega um pacote com a mira dentro da zona
     * morta, isto é, com o controle de volta ao centro. No intervalo, uma mira
     * fora da zona morta é ignorada (ver `World.setInput`) — é o que impede
     * transformar um arraste parado em golpe atrás de golpe.
     *
     * Começa aberta: quem nunca atacou não tem nada a renovar. Não vale para
     * bots, que não passam por `setInput` (a mira deles é decidida em
     * `World.aimAt`, uma vez por golpe).
     */
    aimReady = true;

    /**
     * Botão de ataque SEGURADO.
     *
     * É o que sustenta o ataque contínuo: enquanto estiver de pé,
     * `World.stepPlayer` tenta desferir o golpe todo tick, e quem dá o ritmo é
     * o `attackReadyAt` que já existia (piso: `ATTACK_INTERVAL`). Só o jogador
     * escreve aqui — bots decidem cada golpe em `stepBot`.
     */
    attackHeld = false;
    /**
     * Sequência do último pacote de entrada processado.
     *
     * Vai de volta ao cliente no schema (`ActorState.ack`) para ele saber até
     * onde o servidor já andou e reaplicar sozinho o que mandou depois disso.
     * Sem isto o cliente reconciliaria contra uma posição de um RTT atrás e o
     * boneco viveria sendo puxado para trás.
     */
    inputSeq = 0;
    /** Instante do último pacote de entrada. Ver INPUT_TIMEOUT_MS. */
    lastInputAt = 0;
    /** Cliente desconectado esperando reconexão: congela o personagem. */
    frozen = false;

    // --- IA: navegação (bots) ---
    /**
     * Rota atual, como pares x,y de mundo. Vazia = indo direto no alvo.
     *
     * Guardada achatada num array só para não criar um objeto por waypoint a
     * cada recálculo.
     */
    path: number[] = [];
    pathIndex = 0;
    /** Onde o alvo estava quando a rota foi traçada; ver BOT_REPATH_TARGET_MOVE. */
    pathTargetX = 0;
    pathTargetY = 0;
    /** Instante do último cálculo de rota (`World.now`). */
    pathAt = 0;

    /** Posição na última checagem de progresso, para detectar bot travado. */
    progressX = 0;
    progressY = 0;
    progressAt = 0;

    /**
     * Até quando o bot está saindo de um canto (`World.now`), e para que lado.
     *
     * O lado alterna a cada travada: se contornar por um lado não resolveu, a
     * tentativa seguinte vai pelo outro, em vez de insistir no mesmo.
     */
    unstickUntil = 0;
    unstickSide = 1;
    /** Direção escolhida para sair da quina (absoluta, em radianos). */
    unstickAngle = 0;

    // --- IA (bots) ---
    wanderAngle = Math.random() * Math.PI * 2;
    wanderTimer = 0;
    attackCooldown = 0;

    constructor(id: string, team: Team, isBot: boolean, name: string) {
        this.id = id;
        this.team = team;
        this.isBot = isBot;
        this.name = name;
    }

    get rank(): RankConfig {
        return RANKS[this.rankKey];
    }

    get collisionRx(): number {
        return 50 * (this.rank.size.width / 128);
    }

    get collisionRy(): number {
        return 25 * (this.rank.size.height / 128);
    }

    get mass(): number {
        return this.rank.mass || 1;
    }

    /**
     * Centro da elipse de colisão, em coordenadas de mundo.
     *
     * No cliente isso saía de `body.center`. Reproduzindo a conta de
     * `applyRankPhysics` (origem do sprite em 0.5; offsetY = (altura -
     * collisionRx) + collisionRy/3; altura do corpo = collisionRy*2):
     *
     *   centerX = x
     *   centerY = y + altura/2 - collisionRx + collisionRy * 4/3
     *
     * O cliente usa a MESMA fórmula em `ArenaActor.getEllipseCenter()`.
     */
    ellipseCenter(): { x: number; y: number } {
        return {
            x: this.x,
            y: this.y + this.rank.size.height / 2 - this.collisionRx + (this.collisionRy * 4) / 3,
        };
    }

    /**
     * Coloca o personagem numa posição e a assume como válida.
     *
     * Escrever `x`/`y` na mão deixa `lastValid*` para trás, e no tick seguinte
     * o `World` devolveria o personagem para a posição antiga ao ver que a
     * nova encosta em parede. Spawn, respawn e testes usam isto.
     */
    teleport(x: number, y: number): void {
        this.x = x;
        this.y = y;
        this.lastValidX = x;
        this.lastValidY = y;
    }

    setRank(key: RankKey): void {
        this.rankKey = key;
    }

    /** Nível atual, derivado do rank — não é guardado em lugar nenhum. */
    get level(): number {
        return this.rank.index + 1;
    }

    /**
     * Soma XP e sobe o rank se a XP total já der para isso.
     *
     * Ponto único de progressão: a XP não é gasta, o nível é recalculado da
     * total, e subir mais de um nível de uma vez (se um dia um abate valer
     * muito) simplesmente funciona.
     *
     * @returns true se o nível mudou — o chamador usa para feedback.
     */
    addExperience(amount: number): boolean {
        if (!(amount > 0)) return false;

        this.xp += amount;
        const nivel = levelFromXp(this.xp);
        if (nivel <= this.level) return false;

        this.applyLevel(nivel);
        return true;
    }

    /**
     * Vira a peça do nível pedido: rank, vida máxima e vida cheia.
     *
     * É o corpo do que `addExperience` já fazia ao subir de nível, isolado
     * para que a promoção de debug (`debugCycleRank`) passe EXATAMENTE por
     * aqui em vez de repetir os mesmos três passos. Todo o resto — velocidade,
     * forma do golpe, alcance, massa, raio da elipse, sprite — deriva de
     * `rankKey` sozinho, dos dois lados.
     */
    private applyLevel(nivel: number): void {
        this.setRank(rankKeyForLevel(nivel));
        this.maxHealth = this.rank.health;
        this.currentHealth = this.maxHealth;
    }

    /**
     * FERRAMENTA DE DEBUG: avança uma peça, e da rainha volta ao peão.
     *
     * Não existe atalho de XP aqui: a XP é levada ao PISO do nível de destino
     * (a mesma conta de `resetProgressOnDeath`) e a peça é trocada pelo mesmo
     * `applyLevel` da promoção normal. Assim o estado continua coerente — quem
     * for jogado de volta a peão volta com 0 de XP e torna a subir matando,
     * como qualquer um. Nada no caminho normal de XP é afrouxado.
     */
    debugCycleRank(): void {
        const alvo = this.level >= MAX_LEVEL ? 1 : this.level + 1;
        this.xp = (alvo - 1) * XP_PER_LEVEL;
        this.applyLevel(alvo);
    }

    /**
     * Perda ao morrer: **o rank fica, a barra volta a zero**.
     *
     * A XP não vai para 0 absoluto, e sim para o piso do nível atual — que é
     * exatamente a XP mínima para ser o rank que já se é. Zerar de verdade
     * faria o rank cair no primeiro `addExperience`; deixar a XP intacta
     * tornaria a morte grátis. O piso é o meio-termo: quem morre perde só o
     * progresso rumo à próxima peça.
     *
     * Exemplo: cavalo (nível 3) com 220 XP morre e renasce cavalo com 200.
     */
    resetProgressOnDeath(): void {
        this.xp = (this.level - 1) * XP_PER_LEVEL;
        this.maxHealth = this.rank.health;
        this.currentHealth = this.maxHealth;
    }

    isInvulnerable(now: number): boolean {
        return now < this.invulnUntil;
    }

    isDashing(now: number): boolean {
        return now < this.dashUntil && this.dashRemaining > 0;
    }

    /**
     * Velocidade do dash neste passo, já limitada pelo que falta percorrer, e
     * desconta essa fatia. O último passo sai mais devagar em vez de passar do
     * alvo.
     */
    consumeDashSpeed(dtSeconds: number, fullSpeed: number): number {
        if (dtSeconds <= 0) return 0;
        const speed = Math.min(fullSpeed, this.dashRemaining / dtSeconds);
        this.dashRemaining -= speed * dtSeconds;
        return speed;
    }

    /** Fração do cooldown do dash que ainda falta, 0..1 (0 = pronto). */
    dashCooldownRatio(now: number, total: number): number {
        const falta = this.dashReadyAt - now;
        if (falta <= 0) return 0;
        return clamp(falta / total, 0, 1);
    }

    /** @returns true se o golpe matou. */
    takeDamage(amount: number, now: number): boolean {
        if (!this.alive || this.isInvulnerable(now)) return false;

        this.currentHealth -= amount;
        if (this.currentHealth <= 0) {
            this.currentHealth = 0;
            return true;
        }

        this.invulnUntil = now + HIT_INVULN_MS;
        return false;
    }

    addAuraFromKill(victim: Actor): void {
        this.aura += AURA_KILL_VALUES[victim.rank.key] ?? 10;
    }

    /** Esquece a rota atual: o próximo passo decide de novo o que fazer. */
    clearPath(): void {
        this.path.length = 0;
        this.pathIndex = 0;
    }

    /** Corta um dash em curso (morte, respawn). Não mexe no cooldown. */
    cancelDash(): void {
        this.dashPhasing = false;
        this.dashUntil = 0;
        this.dashRemaining = 0;
        this.dashDirX = 0;
        this.dashDirY = 0;
    }

    /** Cancela ataque e carga em curso. */
    cancelAttack(): void {
        this.attacking = false;
        this.attackHitAt = 0;
        this.chargePower = 0;
        this.charging = false;
        this.chargeRatio = 0;
        this.hitThisAttack.clear();
    }

    /** Mantém o sprite inteiro dentro do mapa (era `clampToWorldBounds`). */
    clampToWorld(): void {
        const halfW = this.rank.size.width / 2;
        const halfH = this.rank.size.height / 2;
        this.x = clamp(this.x, halfW, WORLD_WIDTH - halfW);
        this.y = clamp(this.y, halfH, WORLD_HEIGHT - halfH);
    }
}
