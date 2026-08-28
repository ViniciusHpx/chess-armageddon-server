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

// ---------------------------------------------------------------------------
// EXPERIÊNCIA E NÍVEL
//
// O rank deixou de subir direto no abate: o abate dá XP, e o NÍVEL sai da XP
// acumulada. Nível e rank são a mesma coisa vista de dois jeitos — nível 1 é
// peão, 5 é rainha, na ordem de `RANK_ORDER` —, então o nível não trafega nem
// é guardado: deriva de `RANKS[rankKey].index`. Uma fonte de verdade só.
//
// A XP nunca é gasta ao subir de nível; ela só acumula. É por isso que o
// nível é uma divisão da XP total, e não um contador que zera.
// ---------------------------------------------------------------------------

export const XP_PER_KILL = 30;
export const XP_PER_LEVEL = 100;

/** Nível mais alto que existe = quantidade de ranks. */
export const MAX_LEVEL = RANK_ORDER.length;

/** Nível (1..MAX_LEVEL) correspondente a uma XP total. */
export function levelFromXp(xp: number): number {
    const nivel = Math.floor(Math.max(0, xp) / XP_PER_LEVEL) + 1;
    return Math.min(nivel, MAX_LEVEL);
}

/** Rank de um nível. Nível 1 = peão, MAX_LEVEL = rainha. */
export function rankKeyForLevel(level: number): RankKey {
    const i = clamp(Math.round(level), 1, MAX_LEVEL) - 1;
    return RANK_ORDER[i];
}

/**
 * Progresso dentro do nível atual, para a barra.
 *
 * `into`/`need` são o que a barra mostra (20/100), não a XP total: a XP total
 * passa dos 100 e encheria a barra para sempre. No nível máximo devolve a
 * barra cheia e `max: true` — não existe "próximo nível" para calcular.
 */
export function xpProgress(xp: number): { level: number; into: number; need: number; max: boolean } {
    const level = levelFromXp(xp);
    if (level >= MAX_LEVEL) {
        return { level, into: XP_PER_LEVEL, need: XP_PER_LEVEL, max: true };
    }
    return {
        level,
        into: Math.max(0, xp) - (level - 1) * XP_PER_LEVEL,
        need: XP_PER_LEVEL,
        max: false,
    };
}

/** Aura concedida ao abater cada tipo de inimigo. */
export const AURA_KILL_VALUES: Record<string, number> = {
    pawn: 10,
    tower: 20,
    horse: 30,
    bishop: 40,
    queen: 50,
};

// ---------------------------------------------------------------------------
// MODOS DE JOGO
//
// Por enquanto o modo é só um RÓTULO da sala: nenhuma regra depende dele ainda.
// Ele existe para a escolha do criador ficar registrada e chegar aos outros
// clientes, e para as regras de cada modo terem onde se pendurar depois.
//
// A ordem é contrato de rede, como `RANK_ORDER` e `TEAM_ORDER`: é o índice que
// trafega no schema. Modo novo entra no FIM da lista.
// ---------------------------------------------------------------------------

export const GAME_MODES = ["team_deathmatch", "capture_the_flag", "free_for_all"] as const;

export type GameMode = (typeof GAME_MODES)[number];

/**
 * Padrão e fallback: é o comportamento que o jogo já tem hoje (dois times
 * brigando sem condição de vitória), então sala antiga, cliente antigo ou
 * valor inválido continuam caindo em algo que funciona.
 */
export const DEFAULT_GAME_MODE: GameMode = "team_deathmatch";

/**
 * Modo pedido pelo cliente, saneado.
 *
 * Allowlist estrita: qualquer coisa fora da lista (string arbitrária, número,
 * objeto, ausente) vira o padrão. Nunca se guarda no estado da sala um valor
 * que o cliente escolheu sem passar por aqui.
 */
export function sanitizeGameMode(raw: unknown): GameMode {
    return GAME_MODES.includes(raw as GameMode) ? (raw as GameMode) : DEFAULT_GAME_MODE;
}

// ---------------------------------------------------------------------------
// MUNDO E COMBATE
// ---------------------------------------------------------------------------

/**
 * Dimensões do mapa. Espelha `chess-armageddon/src/constants/Scenario.js`.
 *
 * Os assets (`arena.png`, `collision.png`) são a METADE esquerda, 2496x1684; o
 * mundo é essa metade mais o espelho dela. Por isso `WORLD_WIDTH` é o dobro de
 * `HALF_WORLD_WIDTH`, e tanto o desenho quanto a máscara de colisão dobram o X
 * pela mesma conta.
 */
export const HALF_WORLD_WIDTH = 2496;
export const WORLD_WIDTH = HALF_WORLD_WIDTH * 2;
export const WORLD_HEIGHT = 1684;

/**
 * Área de nascimento de cada time, dentro do próprio castelo.
 *
 * São retângulos GENEROSOS de propósito: o pátio tem construções internas, e
 * quem garante que ninguém nasce em cima delas é a máscara de colisão
 * (`World.placeAtSpawn` sorteia dentro daqui e valida). Retângulo apertado o
 * bastante para caber só em chão livre seria mais frágil e mais difícil de
 * ajustar quando a arte mudar.
 *
 * O time `enemy` é o espelho em X — como o mapa inteiro.
 */
export const SPAWN_ZONE = {
    minX: 150,
    maxX: 900,
    minY: 560,
    maxY: 1400,
} as const;

/**
 * Área que RECUPERA VIDA, no fundo do pátio de cada castelo.
 *
 * NÃO é a `SPAWN_ZONE`: aquela é generosa de propósito (sorteio de nascimento,
 * validado pela máscara) e transborda o portão — chega a y 1400, já no campo
 * aberto ao sul do castelo. Curar ali significava curar na porta, e até fora
 * dela.
 *
 * Este retângulo é o miolo do pátio, recuado do portão. Medido na máscara de
 * colisão com uma busca em largura a partir do campo aberto, o ponto MENOS
 * profundo daqui está a 1672 px de caminhada do lado de fora (a `SPAWN_ZONE`
 * tem pontos a 808 px), e o corredor do portão — x 192..456, y 1176..1300 —
 * fica inteiro fora. Ou seja: é preciso atravessar a entrada e avançar pátio
 * adentro para a regeneração ligar.
 *
 * O recorte também é quase todo chão livre (99,9 % dos pixels), o que importa
 * porque o cliente desenha ESTE MESMO retângulo como a névoa verde: verde em
 * cima de muralha seria mentira visual.
 *
 * Como todo o resto do mapa, o time `enemy` usa o espelho em X.
 */
export const HEAL_ZONE = {
    minX: 220,
    maxX: 840,
    minY: 540,
    maxY: 980,
} as const;

/**
 * O ponto está na área de cura do castelo deste time?
 *
 * Espelho em X para o `enemy`, como o mapa inteiro. É o que define "estar na
 * própria base" para efeito de regeneração — o castelo do outro time nunca
 * cura, porque a zona testada é sempre a do time do ator.
 */
export function insideHealZone(team: Team, x: number, y: number): boolean {
    const bruteX = team === "enemy" ? WORLD_WIDTH - x : x;
    return bruteX >= HEAL_ZONE.minX && bruteX <= HEAL_ZONE.maxX
        && y >= HEAL_ZONE.minY && y <= HEAL_ZONE.maxY;
}

/**
 * Vida recuperada por segundo dentro do PRÓPRIO castelo.
 *
 * 12/s enche um peão (100) em 8,3 s e uma torre (200) em 16,7 s. Era 20/s, o
 * que devolvia um peão inteiro em 5 s — rápido demais para a volta ao combate
 * custar alguma coisa. A recuperação continua contínua (sai do `dt` do tick,
 * não de um pulso na entrada) e nunca passa de `maxHealth`.
 *
 * Esta constante é a ÚNICA fonte da taxa: o modo offline a espelha em
 * `src/constants/Scenario.js` do cliente e não existe nenhum outro lugar
 * somando vida por estar na base.
 */
export const BASE_HEAL_PER_SECOND = 12;

/** Tentativas de sorteio antes de desistir e usar o fallback do castelo. */
export const SPAWN_ATTEMPTS = 40;

/** Distância mínima entre dois personagens recém-nascidos, em px. */
export const SPAWN_MIN_DISTANCE = 120;

/**
 * Janela que uma sala recém-criada tem para receber o primeiro jogador.
 *
 * O padrão do Colyseus são 15 s (`seatReservationTimeout`): sala criada e
 * vazia se descarta sozinha depois disso. É pouco para a revanche, que nasce
 * pelo `matchMaker.createRoom` e só recebe gente depois de o cliente recarregar
 * a página inteira (Phaser + arte). Passado o prazo, o `joinById` caía numa
 * sala inexistente — e a borda devolve uma página de erro sem
 * `Access-Control-Allow-Origin`, que o navegador acusa como CORS.
 *
 * Vale para qualquer sala: quem cria pelo lobby entra em segundos, então o
 * prazo maior não muda nada no caminho comum.
 */
export const ROOM_JOIN_GRACE_SECONDS = 90;

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

/**
 * TEMPORÁRIO: ataque carregado desligado.
 *
 * Com `false`, apertar o botão já dispara o golpe leve (potência 0) e ninguém
 * — jogador ou bot — chega a entrar em estado de carga. Toda a máquina da
 * carga continua no lugar (`chargePower`, `chargeDamage`, `startCharge`,
 * `botShouldCharge`...): basta voltar esta flag para `true` para reativá-la.
 */
export const CHARGED_ATTACK_ENABLED = false;

/**
 * Abates que um time precisa somar para vencer no modo `team_deathmatch`.
 *
 * Só vale para esse modo: a `ArenaRoom` é quem repassa este número ao
 * `World.killLimit`, e nos outros modos ele fica em 0 (sem condição de
 * vitória, que é o comportamento que a arena sempre teve).
 */
export const TEAM_KILL_LIMIT = 40;

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

// ---------------------------------------------------------------------------
// DIREÇÃO DO GOLPE
//
// O golpe já saiu preso ao eixo X: a direção era o `flipX`, ou seja, leste ou
// oeste. Hoje ela é uma das OITO direções, escolhida pelo jogador no controle
// de ataque, e independente de para onde ele anda.
//
// O que trafega é o ÍNDICE (0..7), não o ângulo — mesmo motivo de `atkPower`
// trafegar a potência final em vez do tempo de carga: os dois lados derivam o
// ângulo do mesmo índice, então não existe arredondamento para divergir, e o
// desenho é exatamente a área que causou o dano.
//
// A ORDEM é contrato de rede, como `RANK_ORDER`: índice 0 é leste e a lista
// gira no sentido do Y da tela (que cresce para BAIXO), então 2 é sul e 6 é
// norte. Não reordene de um lado só.
// ---------------------------------------------------------------------------

export const ATTACK_DIR_COUNT = 8;

/** Ângulo entre duas direções vizinhas (45°). */
const ATTACK_DIR_STEP = (Math.PI * 2) / ATTACK_DIR_COUNT;

/**
 * Módulo mínimo do vetor de mira para ele valer como direção.
 *
 * Abaixo disto o toque conta como "sem mira" e o golpe sai para onde a peça
 * olha (o `flipX`), que é o comportamento de sempre — é o que mantém teclado e
 * bots exatamente como eram. Também evita que um encostão no controle mande o
 * golpe para um lado aleatório.
 */
export const ATTACK_AIM_DEADZONE = 0.35;

/** Direção (0..7) mais próxima de um vetor de mira. */
export function attackDirIndex(ax: number, ay: number): number {
    const i = Math.round(Math.atan2(ay, ax) / ATTACK_DIR_STEP);
    return ((i % ATTACK_DIR_COUNT) + ATTACK_DIR_COUNT) % ATTACK_DIR_COUNT;
}

/** Ângulo, em radianos, de uma direção de ataque. */
export function attackDirAngle(dir: number): number {
    const i = ((Math.round(dir) % ATTACK_DIR_COUNT) + ATTACK_DIR_COUNT) % ATTACK_DIR_COUNT;
    return i * ATTACK_DIR_STEP;
}

/**
 * Espera MÍNIMA entre o início de dois golpes, em ms. É o botão de
 * balanceamento do ataque contínuo.
 *
 * Segurar o controle de ataque repete o golpe sozinho, e sem este piso a
 * cadência seria a soma windup + recuperação do golpe leve (160 + 60 = 220 ms,
 * ou seja 4,5 golpes por segundo) — o personagem viraria uma máquina de bater.
 * Com 420 ms dá ~2,4 por segundo: sobra ritmo entre um golpe e o outro sem o
 * ataque ficar lerdo.
 *
 * Entra como PISO do `attackReadyAt`, o mesmo gate que já era o freio de spam
 * (ver `beginAttack`) — não existe um segundo temporizador. Como o piso é um
 * `Math.max`, um golpe cuja recuperação já passe disto (a carga cheia:
 * 260 + 340 = 600 ms) não fica mais rápido por causa dele.
 *
 * Bots não são afetados: `BOT_ATTACK_COOLDOWN_MS` (700 ms) é maior, e vale o
 * maior dos dois.
 */
export const ATTACK_INTERVAL = 420;

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
 * Fração da velocidade enquanto o golpe está sendo CARREGADO.
 *
 * Mais lento que o próprio golpe (0,6): segurar a carga passa a ter um custo
 * de posicionamento, e não só de tempo — quem carrega fica mais fácil de
 * acertar e mais difícil de escapar. Vale para humanos e bots; o dano, o
 * alcance e o empurrão não mudam.
 */
export const CHARGE_MOVE_FACTOR = 0.45;

/**
 * Fator de velocidade do estado atual de combate.
 *
 * Fonte única dos dois lados (o cliente tem a cópia em `Hierarchy.js`): a
 * velocidade nunca é calculada solta no meio do código, senão previsão,
 * simulação e modo offline divergem. Os estados são exclusivos — não se
 * carrega durante o golpe —, mas a ordem deixa isso explícito.
 */
export function movementFactor(
    attacking: boolean, charging: boolean, inWater = false,
): number {
    let fator = 1;
    if (attacking) fator = ATTACK_MOVE_FACTOR;
    else if (charging) fator = CHARGE_MOVE_FACTOR;

    // Terreno multiplica o estado de combate, não o substitui: atacar dentro
    // d'água é 0,6 × 0,8. Como o fator é sempre recalculado a partir da
    // `rank.speed`, entrar e sair da água não acumula nada e nada precisa ser
    // "restaurado" — fora da água a conta simplesmente não tem o 0,8.
    return inWater ? fator * WATER_SPEED_FACTOR : fator;
}

/**
 * Fração da velocidade dentro da água (rio e mar).
 *
 * A água é NAVEGÁVEL por todo mundo — jogador, bot, qualquer peça —, só custa
 * 20% de velocidade. Quem diz onde é água é a máscara de colisão
 * (`CollisionMask.isWater`), pela cor do pixel; não existe zona nem coordenada
 * escrita em código.
 */
export const WATER_SPEED_FACTOR = 0.8;

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

/**
 * Empurrão da separação, em px por tick, que interrompe um dash.
 *
 * O dash acaba quando ESBARRA em alguém: se a separação empurrou o personagem
 * CONTRA o sentido do dash mais do que isto, ele para ali, junto do outro. Só
 * o sentido contrário conta — dashar para longe de quem está encostado também
 * gera empurrão, e cancelar aí tiraria justamente a fuga de um aglomerado.
 */
export const DASH_STOP_PUSHBACK = 1;

/**
 * Rank que atravessa estrutura durante o dash — o salto do cavalo do xadrez.
 *
 * É uma regra da PEÇA, não de quem a controla: humano e bot passam pelo mesmo
 * `World.startDash`, então os dois ganham a travessia ao virar cavalo e a
 * perdem ao promover.
 */
export const DASH_PHASE_RANK: RankKey = "HORSE";

/** O rank atravessa parede durante o dash? */
export function canPhaseDash(rankKey: RankKey): boolean {
    return rankKey === DASH_PHASE_RANK;
}

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

// ---------------------------------------------------------------------------
// NAVEGAÇÃO DOS BOTS
//
// O caminho só é recalculado por EVENTO (alvo mudou de lugar, rota acabou, bot
// travado), nunca por tick. Enquanto o alvo estiver em linha de visão o bot nem
// pede rota: vai direto, que é o caso comum em campo aberto.
// ---------------------------------------------------------------------------

/** Espera mínima entre dois cálculos de rota do MESMO bot. */
export const BOT_REPATH_MIN_MS = 700;

/** O alvo precisa ter andado isto para a rota valer a pena ser refeita. */
export const BOT_REPATH_TARGET_MOVE = 220;

/** Distância para considerar um waypoint alcançado. */
export const BOT_WAYPOINT_TOLERANCE = 40;

/** Janela de checagem de progresso; ver `BOT_STUCK_MIN_PROGRESS`. */
export const BOT_STUCK_CHECK_MS = 600;

/**
 * Quanto o bot precisa ter andado dentro da janela para não ser considerado
 * travado. Abaixo disso a rota é jogada fora e recalculada.
 */
export const BOT_STUCK_MIN_PROGRESS = 24;

/**
 * Buscas de caminho permitidas por tick, na sala inteira.
 *
 * Espalha o custo: numa virada em que todos perdem a rota ao mesmo tempo, os
 * cálculos caem em ticks seguidos em vez de se acumularem num só.
 */
export const BOT_PATHS_PER_TICK = 2;

/**
 * Quanto tempo o bot anda "de lado" depois de travar.
 *
 * Só limpar a rota não resolve quina: o A* devolve praticamente o mesmo
 * caminho e ele volta a encostar no mesmo canto. Durante esta janela o bot
 * ignora o waypoint e segue uma tangente, o que o tira do canto pelo movimento
 * normal — nada de teleporte.
 */
export const BOT_UNSTICK_MS = 500;

/**
 * Ângulo do desvio, em radianos (~70°).
 *
 * Perpendicular demais (90°) faz o bot bater na parede lateral do corredor;
 * pouco (30°) mantém ele raspando a mesma quina.
 */
export const BOT_UNSTICK_ANGLE = 1.22;

/**
 * Desvios testados ao sair de uma quina, em radianos (70°, 110°, 150°).
 *
 * O contorno deixou de ser às cegas: o bot testa estes desvios contra a
 * MÁSCARA, com o corpo dele, e anda para o primeiro que estiver livre. Antes
 * ele saía sempre nos mesmos 70° — num canto fechado isso é parede também, e
 * ele voltava a empacar até a janela seguinte. A escada vai do desvio suave ao
 * quase-voltar, então em algum ponto ela acha a saída.
 */
export const BOT_UNSTICK_ANGLES = [1.22, 1.92, 2.62];

/**
 * Quanto o bot enxerga à frente ao escolher a saída, em px.
 *
 * Duas células de navegação: perto o bastante para a resposta valer agora,
 * longe o bastante para não escolher um vão onde ele não cabe.
 */
export const BOT_UNSTICK_PROBE = 64;

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
