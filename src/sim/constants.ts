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
/** Distância em que o bot considera que há inimigo ao alcance. */
export const BOT_ATTACK_RANGE = 100;
export const BOT_ATTACK_COOLDOWN_MS = 2000;
/** Chance por tick de o bot atacar quando há inimigo ao alcance. */
export const BOT_ATTACK_CHANCE = 0.02;
/** Margem das bordas em que o bot inverte o rumo. */
export const BOT_EDGE_MARGIN = 100;

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
