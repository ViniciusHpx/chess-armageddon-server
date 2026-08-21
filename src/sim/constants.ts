/**
 * Constantes da simulação, portadas de `chess-armageddon/src/constants/Hierarchy.js`.
 *
 * ESTE ARQUIVO É A FONTE DE VERDADE. O cliente tem uma cópia em
 * `src/constants/Hierarchy.js` usada apenas para desenhar (textura, tamanho,
 * forma do ataque). Se mudar um valor aqui, espelhe lá.
 */

export type AttackConfig =
    | { type: "rectangle"; length: number; width: number }
    | { type: "circle"; radius: number }
    | { type: "lshape"; forwardLength: number; sideLength: number; width: number }
    | { type: "diamond"; radius: number };

export interface RankConfig {
    key: string;
    /** Índice enviado no schema (uint8) — a ordem NÃO pode mudar. */
    index: number;
    speed: number;
    size: { width: number; height: number };
    health: number;
    mass: number;
    attack: AttackConfig;
    chargeTime: number;
    next: RankKey | null;
}

export type RankKey = "PAWN" | "TOWER" | "HORSE" | "BISHOP" | "QUEEN";

export const RANKS: Record<RankKey, RankConfig> = {
    PAWN: {
        key: "pawn",
        index: 0,
        speed: 200,
        size: { width: 128, height: 128 },
        health: 100,
        mass: 1,
        attack: { type: "rectangle", length: 80, width: 50 },
        chargeTime: 1000,
        next: "TOWER",
    },
    TOWER: {
        key: "tower",
        index: 1,
        speed: 140,
        size: { width: 160, height: 160 },
        health: 200,
        mass: 4,
        attack: { type: "circle", radius: 120 },
        chargeTime: 1500,
        next: "HORSE",
    },
    HORSE: {
        key: "horse",
        index: 2,
        speed: 280,
        size: { width: 144, height: 144 },
        health: 125,
        mass: 1.6,
        attack: { type: "lshape", forwardLength: 80, sideLength: 60, width: 50 },
        chargeTime: 1200,
        next: "BISHOP",
    },
    BISHOP: {
        key: "bishop",
        index: 3,
        speed: 200,
        size: { width: 144, height: 144 },
        health: 150,
        mass: 1.8,
        attack: { type: "diamond", radius: 100 },
        chargeTime: 1500,
        next: "QUEEN",
    },
    QUEEN: {
        key: "queen",
        index: 4,
        speed: 250,
        size: { width: 160, height: 160 },
        health: 200,
        mass: 3,
        attack: { type: "circle", radius: 150 },
        chargeTime: 2000,
        next: null,
    },
};

/** Mesma ordem de `RankConfig.index`. Usada para decodificar o uint8. */
export const RANK_ORDER: RankKey[] = ["PAWN", "TOWER", "HORSE", "BISHOP", "QUEEN"];

/** Aura concedida ao abater cada tipo de inimigo. */
export const AURA_KILL_VALUES: Record<string, number> = {
    pawn: 10,
    tower: 20,
    horse: 30,
    bishop: 40,
    queen: 50,
};

// ---------------------------------------------------------------------------
// MUNDO E COMBATE
// ---------------------------------------------------------------------------

/** Dimensões do mapa (assets/map_3548_1774.png). */
export const WORLD_WIDTH = 3548;
export const WORLD_HEIGHT = 1774;

/** Intervalo da simulação, em ms. 20 ticks/s. */
export const TICK_MS = 50;

/** Atraso entre iniciar o golpe e aplicar o dano (era `delayedCall(200)`). */
export const ATTACK_WINDUP_MS = 200;

export const DAMAGE_NORMAL = 25;
export const DAMAGE_CHARGED = 50;

/** Invulnerabilidade após levar dano. */
export const HIT_INVULN_MS = 500;
/** Invulnerabilidade após renascer. */
export const RESPAWN_INVULN_MS = 1000;

/** Tempo mínimo entre morrer e poder renascer. */
export const HUMAN_RESPAWN_DELAY_MS = 1000;
export const BOT_RESPAWN_DELAY_MS = 1000;

/** Bots andam a 25% da velocidade do rank (mantido do original). */
export const BOT_SPEED_FACTOR = 0.25;

/**
 * Tempo mínimo entre dois golpes do mesmo bot.
 *
 * Era 2000 ms e, somado ao sorteio abaixo, deixava o bot quase inofensivo.
 */
export const BOT_ATTACK_COOLDOWN_MS = 700;

/**
 * Golpes por segundo que o bot tenta desferir enquanto tem alvo ao alcance.
 *
 * É uma taxa por SEGUNDO, não uma chance por tick: a conversão em
 * `stepBot` usa o delta real, então mudar `TICK_MS` não altera a
 * agressividade. Antes era `0.02` por tick, o que a amarrava aos 20 ticks/s
 * e dava ~2,5 s de espera aleatória em cima do cooldown.
 */
export const BOT_ATTACK_RATE_PER_SECOND = 3;

/**
 * Folga somada ao alcance calculado, em pixels.
 *
 * O alvo se mexe durante os `ATTACK_WINDUP_MS` do golpe, então mirar no
 * alcance exato erraria quase sempre contra quem está fugindo.
 */
export const BOT_ATTACK_RANGE_SLACK = 20;

/** Margem das bordas em que o bot inverte o rumo. */
export const BOT_EDGE_MARGIN = 100;

/**
 * Quanto tempo o bot segura um golpe já carregado esperando o alvo entrar no
 * alcance, antes de soltar assim mesmo.
 *
 * Sem este teto, um alvo que foge deixaria o bot paralisado segurando a carga
 * para sempre. Soltar no vazio é melhor: gasta o cooldown e ele volta a agir.
 */
export const BOT_CHARGE_HOLD_MS = 1200;

// ---------------------------------------------------------------------------
// EMPURRÃO DO GOLPE
// ---------------------------------------------------------------------------

/**
 * Velocidade inicial do empurrão, em px/s, de um golpe normal sobre uma peça
 * de massa 1 (o peão).
 */
export const KNOCKBACK_SPEED = 420;

/**
 * Quanto o golpe carregado empurra a mais.
 *
 * Deliberadamente MENOR que o multiplicador de dano (que é 2): dobrar o dano e
 * o empurrão junto faria o golpe carregado arremessar o alvo para fora da
 * briga, e quem levou não teria como revidar.
 */
export const KNOCKBACK_CHARGED_FACTOR = 1.8;

/**
 * Constante de tempo do decaimento exponencial, em ms.
 *
 * O deslocamento total é aproximadamente `velocidade * (esta constante / 1000)`
 * — cerca de 63 px num peão, 113 no golpe carregado.
 */
export const KNOCKBACK_DECAY_MS = 150;

/** Abaixo disto o empurrão é zerado, para o alvo não ficar à deriva. */
export const KNOCKBACK_MIN_SPEED = 5;

/**
 * Velocidade inicial do empurrão sobre um alvo de massa `targetMass`.
 *
 * Divide pela RAIZ da massa, e não pela massa: com a massa crua a torre
 * (massa 4) mal se mexeria enquanto o peão (massa 1) voaria quatro vezes mais
 * longe. A raiz mantém a diferença perceptível sem ficar discrepante — é o
 * mesmo motivo pelo qual o carregado usa 1,8 e não 2.
 */
export function knockbackSpeed(charged: boolean, targetMass: number): number {
    const force = charged ? KNOCKBACK_SPEED * KNOCKBACK_CHARGED_FACTOR : KNOCKBACK_SPEED;
    return force / Math.sqrt(Math.max(targetMass, 0.01));
}

/**
 * Alcance do golpe, do centro da elipse até a ponta da forma.
 *
 * Serve só para a IA decidir QUANDO bater — o dano continua saindo da
 * geometria exata de `World.executeAttackHit()`. Antes a IA usava 100 px fixos
 * para todo rank: o peão (alcance 80) atacava fora e a rainha (150) só colada.
 */
export function attackReach(rank: RankConfig): number {
    const atk = rank.attack;
    switch (atk.type) {
        case "rectangle": return atk.length;
        case "circle": return atk.radius;
        case "lshape": return atk.forwardLength;
        case "diamond": return atk.radius;
    }
}

/**
 * Meia-altura (em Y) da área que o golpe cobre.
 *
 * Golpes retos (peão, cavalo) só acertam quem está na faixa à frente; os
 * radiais (torre, bispo, rainha) pegam em volta e não têm restrição — daí o
 * `Infinity`, que dispensa um `if` na comparação.
 */
export function attackHalfBand(rank: RankConfig): number {
    const atk = rank.attack;
    switch (atk.type) {
        case "rectangle": return atk.width / 2;
        case "lshape": return atk.width / 2 + atk.sideLength / 2;
        case "circle":
        case "diamond": return Infinity;
    }
}

/**
 * Tempo sem receber entrada depois do qual o personagem para.
 *
 * O servidor guarda o último vetor recebido, então um cliente que congela
 * (aba em segundo plano — o Phaser pausa o loop e para de enviar) deixaria o
 * boneco andando sozinho até a parede. O cliente reenvia a entrada a cada
 * 500 ms; passar disso sem notícias significa que ele parou de falar.
 */
export const INPUT_TIMEOUT_MS = 2000;

/** Quantos personagens por time a sala mantém (humanos + bots). */
export const TEAM_SIZE = 5;

/** Segundos que o servidor guarda o personagem esperando reconexão. */
export const RECONNECTION_SECONDS = 20;

export type Team = "ally" | "enemy";
export const TEAM_INDEX: Record<Team, number> = { ally: 0, enemy: 1 };
