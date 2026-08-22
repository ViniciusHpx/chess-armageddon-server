/**
 * Constantes da simulação, portadas de `chess-armageddon/src/constants/Hierarchy.js`.
 *
 * ESTE ARQUIVO É A FONTE DE VERDADE. O cliente tem uma cópia em
 * `src/constants/Hierarchy.js` usada apenas para desenhar (textura, tamanho,
 * forma do ataque). Se mudar um valor aqui, espelhe lá.
 */
import { clamp } from "./mathx.js";


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

// ---------------------------------------------------------------------------
// GOLPE: LEVE <-> CARREGADO
//
// Toda a diferença entre um toque no botão e um golpe segurado até o fim sai
// de UM número: `power`, de 0 a 1, medido pelo servidor como
// `elapsed / rank.chargeTime` e limitado em 1 — esse clamp é o teto absoluto de
// tudo o que vem abaixo.
//
// Antes `charged` era booleano e só existiam dois golpes (25/50 de dano, área
// 1x/2x). Os extremos continuam valendo os mesmos números, de propósito: quem
// solta na hora certa não perdeu nada, e o que nasceu foi o meio da escala.
//
// Cada atributo tem mínimo, máximo e um expoente próprio. O expoente é o botão
// de balanceamento: 1 = linear, acima de 1 concentra o ganho no fim da carga
// (segurar até o fim vale mais), abaixo de 1 entrega cedo.
// ---------------------------------------------------------------------------

/** Dano de um toque rápido no botão. */
export const DAMAGE_LIGHT = 25;
/** Teto de dano de um único golpe, por mais que se segure. */
export const DAMAGE_MAX = 50;
/**
 * Expoente do dano. Acima de 1: metade da carga rende bem menos que metade do
 * bônus, então parar no meio não é a jogada ótima — ou se bate leve e rápido,
 * ou se compromete com a carga inteira.
 */
export const DAMAGE_CHARGE_EXP = 1.6;

/** Multiplicador das dimensões da forma do golpe: 1 = tamanho de projeto. */
export const AREA_MULT_LIGHT = 1;
/** Teto de área. Dobrar já leva a rainha a 300 px de alcance. */
export const AREA_MULT_MAX = 2;
/**
 * Expoente da área: linear.
 *
 * A área é o atributo que decide se o golpe ACERTA, e o bot mira por ela
 * (`botCanHit`). Curva aqui torna o alcance difícil de prever no olho — o
 * jogador precisa saber onde o golpe pega.
 */
export const AREA_CHARGE_EXP = 1;

/**
 * Atraso entre soltar o botão e o dano sair.
 *
 * Escala com a carga: o toque rápido sai mais cedo do que os 200 ms fixos de
 * antes, e o golpe cheio se anuncia por mais tempo. É essa janela que dá ao
 * alvo a chance de esquivar do golpe pesado.
 */
export const ATTACK_WINDUP_LIGHT_MS = 160;
export const ATTACK_WINDUP_MAX_MS = 260;

/**
 * Espera depois do golpe antes de poder atacar ou carregar de novo.
 *
 * É a desvantagem do carregado e o freio de spam do leve: sem ela o ciclo do
 * humano era só o windup, e segurar o botão de ataque sem parar rendia golpe
 * atrás de golpe. Bots continuam limitados também por BOT_ATTACK_COOLDOWN_MS
 * (vale o maior dos dois).
 */
export const ATTACK_RECOVERY_LIGHT_MS = 60;
export const ATTACK_RECOVERY_MAX_MS = 340;

/** Potência (0..1) do tempo de carga cumprido, com o teto de 1 aplicado. */
export function chargePower(elapsedMs: number, chargeTimeMs: number): number {
    if (!(chargeTimeMs > 0)) return 1;
    return clamp(elapsedMs / chargeTimeMs, 0, 1);
}

/** Interpola entre `min` e `max` pela potência, com o expoente do atributo. */
function scaleByCharge(power: number, min: number, max: number, exp: number): number {
    const p = clamp(power, 0, 1);
    return min + (max - min) * Math.pow(p, exp);
}

export function chargeDamage(power: number): number {
    return scaleByCharge(power, DAMAGE_LIGHT, DAMAGE_MAX, DAMAGE_CHARGE_EXP);
}

export function chargeAreaMult(power: number): number {
    return scaleByCharge(power, AREA_MULT_LIGHT, AREA_MULT_MAX, AREA_CHARGE_EXP);
}

export function attackWindupMs(power: number): number {
    return scaleByCharge(power, ATTACK_WINDUP_LIGHT_MS, ATTACK_WINDUP_MAX_MS, 1);
}

export function attackRecoveryMs(power: number): number {
    return scaleByCharge(power, ATTACK_RECOVERY_LIGHT_MS, ATTACK_RECOVERY_MAX_MS, 1);
}

/**
 * Fração da velocidade mantida durante o golpe.
 *
 * Era 0 (parado seco). Somado ao RTT — o cliente só volta a andar quando o
 * `attacking` cai no estado — a parada aparecia bem maior que os 200 ms do
 * windup e cortava o movimento no meio. Andar devagar preserva o custo de
 * atacar em movimento sem travar o jogador.
 *
 * Vale para humanos e bots, e a cópia do cliente
 * (`chess-armageddon/src/constants/Hierarchy.js`) tem de bater: é ela que a
 * previsão local usa.
 */
export const ATTACK_MOVE_FACTOR = 0.6;

/**
 * Apelidos dos extremos da escala, mantidos porque a IA raciocina com eles
 * ("este golpe mata se eu carregar?" em `botShouldCharge`).
 */
export const DAMAGE_NORMAL = DAMAGE_LIGHT;
export const DAMAGE_CHARGED = DAMAGE_MAX;

/** Invulnerabilidade após levar dano. */
export const HIT_INVULN_MS = 500;
/** Invulnerabilidade após renascer. */
export const RESPAWN_INVULN_MS = 1000;

/** Tempo mínimo entre morrer e poder renascer. */
export const HUMAN_RESPAWN_DELAY_MS = 1000;
export const BOT_RESPAWN_DELAY_MS = 1000;

/**
 * Bots andam na velocidade cheia do rank, igual ao jogador.
 *
 * Era 0.25 (herdado do original): o bot ficava lento demais para perseguir,
 * qualquer humano simplesmente andava para fora do alcance dele.
 */
export const BOT_SPEED_FACTOR = 1;

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

// ---------------------------------------------------------------------------
// DASH / ESQUIVA
// ---------------------------------------------------------------------------

/**
 * O dash é um OVERRIDE de velocidade por um tempo fixo, não um teleporte nem
 * um empurrão: enquanto dura, `vx`/`vy` vêm da direção do dash e o resto do
 * tick (colisão entre personagens, `clampToWorld`) continua valendo. Assim
 * ninguém atravessa outro personagem nem sai do mapa, e a distância percorrida
 * não depende de FPS nem de tick rate.
 *
 * A velocidade sai de distância/duração — mexa nesses dois, não nela.
 */
export const DASH_DISTANCE = 220;
export const DASH_DURATION_MS = 220;
export const DASH_SPEED = DASH_DISTANCE / (DASH_DURATION_MS / 1000);

/** Espera até poder dar outro dash, contada do INÍCIO do dash. */
/**
 * Teto de tempo do dash. Quem termina o dash é a distância percorrida
 * (`Actor.dashRemaining`); este prazo só solta o personagem se ele estiver
 * travado contra outro ou contra a borda e o resto nunca for consumido.
 *
 * Precisa de folga sobre a duração nominal: o servidor integra em ticks de
 * 50 ms e, com o teto colado em DASH_DURATION_MS, o último pedaço da distância
 * ficava para trás — e aí o cliente, que integra em quadros de ~16 ms, entregava
 * alguns pixels a mais que o servidor a cada dash.
 */
export const DASH_TIMEOUT_MS = DASH_DURATION_MS * 2;

export const DASH_COOLDOWN_MS = 1500;

/**
 * Invulnerabilidade concedida no início do dash.
 *
 * Menor que a duração de propósito: a esquiva salva de um golpe que já estava
 * vindo, mas o final do dash fica exposto — atravessar um inimigo que ataca no
 * fim do movimento ainda dói.
 */
export const DASH_INVULN_MS = 160;

/** Cooldown do dash para bots: bem maior, senão eles esquivam demais. */
export const BOT_DASH_COOLDOWN_MS = 3000;

/**
 * Chance de o bot reagir a um golpe que ele percebeu.
 *
 * Sorteada UMA vez por golpe inimigo (a chave é o `attackHitAt` do atacante),
 * não a cada tick — sorteando por tick qualquer chance viraria ~100% ao longo
 * dos 200 ms de windup e o bot esquivaria de tudo.
 */
export const BOT_DODGE_CHANCE = 0.35;

/**
 * Tempo de reação: o bot só considera esquivar depois que o golpe já começou
 * há esse tanto. Some com o windup de 200 ms para dar uma janela curta —
 * reagir no primeiro tick pareceria leitura de pensamento.
 */
export const BOT_DODGE_REACTION_MS = 90;

/** Folga sobre o alcance do atacante para o bot considerar o golpe perigoso. */
export const BOT_DODGE_RANGE_SLACK = 1.25;

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
 * Expoente do empurrão. Entre o do dano (1,6) e o da área (1): o empurrão
 * acompanha a força do golpe sem que uma carga curta já arremesse o alvo para
 * fora do alcance de quem bateu.
 */
export const KNOCKBACK_CHARGE_EXP = 1.3;

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
export function knockbackSpeed(power: number, targetMass: number): number {
    const fator = scaleByCharge(power, 1, KNOCKBACK_CHARGED_FACTOR, KNOCKBACK_CHARGE_EXP);
    return (KNOCKBACK_SPEED * fator) / Math.sqrt(Math.max(targetMass, 0.01));
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
