/**
 * Máscara de colisão do cenário, no servidor.
 *
 * Porte de [`MapCollider.js`](../../../chess-armageddon/src/utils/MapCollider.js)
 * do cliente — mesma imagem, mesma regra, mesmo espelhamento. O cliente lê os
 * pixels com um `<canvas>`; aqui o PNG é decodificado uma única vez no boot e
 * vira um bitset.
 *
 * Duas coisas precisam bater com o cliente ou o golpe da colisão sai deslocado:
 *
 *   1. **o asset é a METADE esquerda** (2496x1684). O mundo é essa metade mais
 *      o espelho dela, daí `WORLD_WIDTH = HALF_WORLD_WIDTH * 2`;
 *   2. **as três classes de terreno**, pela cor do pixel:
 *
 *          branco (r > 128)              chão livre
 *          azul   (b > 128, r <= 128)    água: navegável, mas mais lenta
 *          preto                         parede
 *
 *      O limiar (em vez de "é preto?") perdoa o anti-aliasing do desenho. A
 *      água entrou na própria máscara, e não num segundo arquivo, para
 *      continuar existindo UMA fonte de verdade do terreno — quem pinta é
 *      `scripts/paint-water.mjs`.
 *
 * Memória: 1 bit por pixel da metade = 2496 * 1684 / 8 ≈ 512 KB, carregado uma
 * vez e só consultado depois. Nada de decodificar imagem por tick.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";

import { HALF_WORLD_WIDTH, WORLD_HEIGHT, WORLD_WIDTH } from "./constants.js";

/**
 * Onde procurar o PNG, em ordem.
 *
 * `COLLISION_MASK_PATH` (env) tem prioridade; depois vem a cópia versionada
 * junto do servidor — a única que existe no deploy — e por fim o asset do
 * cliente, útil em desenvolvimento se a cópia estiver defasada.
 */
const CANDIDATOS = [
    process.env.COLLISION_MASK_PATH,
    // A cópia versionada junto do servidor vem primeiro: é a única que existe
    // no deploy, onde o repositório do cliente não está presente. Em
    // desenvolvimento ela é mantida em dia por `npm run sync:mask`.
    "assets/collision.png",
    "../chess-armageddon/assets/collision.png",
];

export class CollisionMask {
    readonly width = WORLD_WIDTH;
    readonly height = WORLD_HEIGHT;
    readonly halfWidth = HALF_WORLD_WIDTH;

    /** 1 bit por pixel da metade esquerda: 1 = dá para andar (chão OU água). */
    private readonly bits: Uint8Array;

    /** 1 bit por pixel: 1 = água. Subconjunto de `bits`. */
    private readonly water: Uint8Array;

    /**
     * 1 bit por pixel: 1 = tabuleiro de ponte. Subconjunto de `bits` e
     * disjunto de `water` — a ponte é chão normal (velocidade cheia, sem
     * `WATER_SPEED_FACTOR`), e o que a distingue é só a proibição de
     * `canCross`. Quem pinta é `scripts/paint-bridges.mjs`.
     */
    private readonly bridge: Uint8Array;

    private constructor(bits: Uint8Array, water: Uint8Array, bridge: Uint8Array) {
        this.bits = bits;
        this.water = water;
        this.bridge = bridge;
    }

    /** Instância única do processo; ver `load()`. */
    private static cache: CollisionMask | undefined;

    /**
     * Decodifica o PNG e monta o bitset — uma vez por processo, na subida
     * (`app.config.ts`). Chamadas seguintes devolvem a mesma instância.
     *
     * @throws se o arquivo não existir ou não tiver o tamanho esperado. Uma
     *         máscara errada deixaria todo mundo atravessando parede, então é
     *         melhor o servidor não subir do que subir quebrado — e o log diz
     *         exatamente onde ele procurou.
     */
    static load(): CollisionMask {
        if (CollisionMask.cache) return CollisionMask.cache;
        return (CollisionMask.cache = CollisionMask.decode());
    }

    private static decode(): CollisionMask {
        const raiz = path.dirname(fileURLToPath(import.meta.url));
        const base = path.resolve(raiz, "../../");

        for (const candidato of CANDIDATOS) {
            if (!candidato) continue;

            const arquivo = path.isAbsolute(candidato) ? candidato : path.resolve(base, candidato);
            if (!fs.existsSync(arquivo)) continue;

            const png = PNG.sync.read(fs.readFileSync(arquivo));
            if (png.width !== HALF_WORLD_WIDTH || png.height !== WORLD_HEIGHT) {
                throw new Error(
                    `máscara ${arquivo} tem ${png.width}x${png.height}; ` +
                    `esperado ${HALF_WORLD_WIDTH}x${WORLD_HEIGHT} (metade do mundo)`,
                );
            }

            const total = png.width * png.height;
            const bits = new Uint8Array(Math.ceil(total / 8));
            const water = new Uint8Array(Math.ceil(total / 8));
            const bridge = new Uint8Array(Math.ceil(total / 8));
            let nAgua = 0;
            let nPonte = 0;

            for (let i = 0; i < total; i++) {
                // Mesmo critério do cliente: branco é chão, azul é água, e
                // dá para andar nos dois. O vermelho (255,0,0) é o tabuleiro
                // da ponte: também é chão — daí ele entrar em `chao` —, só que
                // marcado, para `canCross` recusar o passo vindo da água.
                const chao = png.data[i * 4] > 128;
                const ponte = chao && png.data[i * 4 + 1] <= 128;
                const agua = !chao && png.data[i * 4 + 2] > 128;

                if (chao || agua) bits[i >> 3] |= 1 << (i & 7);
                if (agua) {
                    water[i >> 3] |= 1 << (i & 7);
                    nAgua++;
                }
                if (ponte) {
                    bridge[i >> 3] |= 1 << (i & 7);
                    nPonte++;
                }
            }

            console.log(
                `máscara de colisão carregada de ${arquivo}` +
                (nAgua > 0 ? ` (${((100 * nAgua) / total).toFixed(1)}% de água` : " (sem água") +
                (nPonte > 0 ? `, ${nPonte} px de ponte)` : ", sem ponte)"),
            );
            return new CollisionMask(bits, water, bridge);
        }

        throw new Error(
            `máscara de colisão não encontrada. Procurei em: ${CANDIDATOS.filter(Boolean).join(", ")}`,
        );
    }

    /**
     * O pixel é água?
     *
     * Uma consulta de bit, igual à de `isWalkable` — é o que permite perguntar
     * "está na água?" todo tick sem custo. Fora do mapa não é água.
     */
    isWater(x: number, y: number): boolean {
        let px = Math.floor(x);
        const py = Math.floor(y);

        if (px < 0 || py < 0 || px >= this.width || py >= this.height) return false;
        if (px >= this.halfWidth) px = this.width - 1 - px;

        const i = py * this.halfWidth + px;
        return (this.water[i >> 3] & (1 << (i & 7))) !== 0;
    }

    /**
     * O pixel é tabuleiro de ponte?
     *
     * Mesma consulta de bit da água. A ponte NÃO é um terreno especial para
     * andar: velocidade cheia, colisão igual. O que ela tem é a regra de
     * `canCross`.
     */
    isBridge(x: number, y: number): boolean {
        let px = Math.floor(x);
        const py = Math.floor(y);

        if (px < 0 || py < 0 || px >= this.width || py >= this.height) return false;
        if (px >= this.halfWidth) px = this.width - 1 - px;

        const i = py * this.halfWidth + px;
        return (this.bridge[i >> 3] & (1 << (i & 7))) !== 0;
    }

    /**
     * Dá para ir DAQUI até ALI, olhando só a classe do terreno?
     *
     * A única transição proibida do mapa: **água <-> ponte**. Quem está no rio
     * não sobe no meio do tabuleiro pela lateral, e quem está no tabuleiro não
     * cai na água de lado — é o parapeito, e ele vale nos dois sentidos porque
     * uma regra de mão única deixaria o personagem entalado entre as duas
     * classes.
     *
     * O que continua livre é tudo o que interessa: terra <-> ponte (a
     * ENTRADA, nas duas cabeceiras), terra <-> água (entrar e sair do rio em
     * qualquer margem) e cada classe consigo mesma (atravessar a ponte
     * inteira, nadar o rio inteiro).
     *
     * Os dois pontos são CENTROS DE ELIPSE, a mesma origem de `inWater`: quem
     * decide é onde o personagem está, não onde está o ombro dele — assim o
     * corpo pode encostar na ponte sem que o passo seja recusado, e ninguém
     * fica preso na borda.
     *
     * Custo: duas consultas de bit no caso comum (as duas classes iguais).
     */
    canCross(fromX: number, fromY: number, toX: number, toY: number): boolean {
        const daPonte = this.isBridge(fromX, fromY);
        const praPonte = this.isBridge(toX, toY);
        if (daPonte === praPonte) return true;

        return daPonte ? !this.isWater(toX, toY) : !this.isWater(fromX, fromY);
    }

    /** O pixel é caminhável? Fora do mapa conta como bloqueado. */
    isWalkable(x: number, y: number): boolean {
        let px = Math.floor(x);
        const py = Math.floor(y);

        if (px < 0 || py < 0 || px >= this.width || py >= this.height) return false;

        // Metade direita é o espelho da esquerda — a mesma conta do cliente.
        if (px >= this.halfWidth) px = this.width - 1 - px;

        const i = py * this.halfWidth + px;
        return (this.bits[i >> 3] & (1 << (i & 7))) !== 0;
    }

    /**
     * O personagem cabe com o centro da elipse aqui?
     *
     * Nove pontos: o centro, as quatro pontas e as quatro diagonais, todos a
     * 70% dos raios. As diagonais são o que faltava — com só as pontas, uma
     * quina entra pelo vão entre elas e o "ombro" do corpo termina dentro da
     * parede:
     *
     *     ponta ──┐        │####      o centro e as pontas passam,
     *             ●        │####      mas o canto (X) está na parede
     *        ●  ● ● ●  X ──┘####
     *             ●
     *
     * Continua sendo amostragem, não a elipse inteira: varrer o contorno todo
     * a cada movimento custaria muito mais para ganhar pouco. Os raios a 70%
     * (e não 100%) seguem perdoando resvalos, como antes.
     */
    canStand(cx: number, cy: number, rx: number, ry: number): boolean {
        const dx = rx * 0.7;
        const dy = ry * 0.7;
        // Ponto da diagonal sobre a mesma elipse: cos45 = sen45 ≈ 0,7071.
        const ix = dx * 0.7071;
        const iy = dy * 0.7071;

        return this.isWalkable(cx, cy)
            && this.isWalkable(cx + dx, cy)
            && this.isWalkable(cx - dx, cy)
            && this.isWalkable(cx, cy + dy)
            && this.isWalkable(cx, cy - dy)
            && this.isWalkable(cx + ix, cy + iy)
            && this.isWalkable(cx + ix, cy - iy)
            && this.isWalkable(cx - ix, cy + iy)
            && this.isWalkable(cx - ix, cy - iy);
    }

    /**
     * Maior fração do deslocamento que ainda cabe, de 0 a 1.
     *
     * Bisseção com poucas iterações: o passo de um tick tem no máximo ~15 px,
     * então 4 cortes já param a menos de 1 px da parede. É o que faz o
     * personagem ENCOSTAR no obstáculo em vez de parar a um passo dele — sem
     * isso ele fica "flutuando" longe da parede e, no caso do bot, empurrando
     * o vazio sem progredir.
     */
    private maxAlong(
        x: number, y: number, dx: number, dy: number,
        offsetY: number, rx: number, ry: number,
    ): number {
        const cy = y + offsetY;
        if (this.aceita(x, cy, x + dx, cy + dy, rx, ry)) return 1;

        let baixo = 0;
        let alto = 1;
        for (let i = 0; i < 4; i++) {
            const meio = (baixo + alto) / 2;
            if (this.aceita(x, cy, x + dx * meio, cy + dy * meio, rx, ry)) baixo = meio;
            else alto = meio;
        }
        return baixo;
    }

    /**
     * O destino serve como próximo passo, vindo daqui?
     *
     * Junta as duas perguntas que todo candidato de movimento tem de responder:
     * o corpo cabe lá (`canStand`) e o passo é permitido (`canCross`). Todas
     * as coordenadas são CENTROS DE ELIPSE.
     *
     * Fica no mesmo lugar de propósito: `resolveMove` é o funil por onde passa
     * todo movimento dos dois lados — jogador, bot, empurrão de golpe, dash —,
     * então a regra da ponte não precisa ser repetida em lugar nenhum.
     */
    private aceita(
        deX: number, deY: number, x: number, y: number, rx: number, ry: number,
    ): boolean {
        return this.canStand(x, y, rx, ry) && this.canCross(deX, deY, x, y);
    }

    /**
     * Resolve um movimento CONTRA a parede, devolvendo a posição aceitável.
     *
     * Mesma estratégia do offline (`PlayerBase.constrainPosition`): tenta o
     * destino inteiro; se não couber, desliza mantendo só X, depois só Y; se
     * nem isso, fica onde estava. É o que impede atravessar na diagonal —
     * o destino diagonal é testado como um ponto só, não como dois passos.
     *
     * A posição inválida nunca chega a ser aceita: quem chama grava o retorno,
     * então não existe "andou e voltou" (o teleporte/jitter que a correção a
     * posteriori causaria).
     *
     * O parapeito da ponte (`canCross`) entra aqui como qualquer parede: quem
     * vem nadando encosta na lateral do tabuleiro e desliza por ela, sem
     * subir. Não há caminho de movimento que escape deste método.
     *
     * @param offsetY Distância de `y` até o centro da elipse (constante do rank).
     */
    /**
     * Ponto livre mais próximo, em espiral curta.
     *
     * Rede de resgate para quando a posição de PARTIDA já é inválida — o
     * personagem foi espremido contra a muralha pela separação entre
     * personagens, pelo empurrão de um golpe ou pelo clamp da borda. Sem isto a
     * bisseção de `resolveMove` parte de um ponto ruim e "desliza" dentro da
     * parede, e o personagem fica preso ali para sempre.
     *
     * Não é o modo normal de mover: é um empurrão de poucos pixels, e só
     * acontece quando o estado já estava quebrado.
     *
     * O passo é fino (2 px) porque o resgate precisa sair pelo caminho mais
     * curto. Com passo grosso ele pulava vários pixels, o movimento empurrava
     * de volta contra a parede e o resgate disparava outra vez — vira tremor.
     */
    nearestFree(
        x: number, y: number, offsetY: number, rx: number, ry: number,
    ): { x: number; y: number } | undefined {
        for (let raio = 2; raio <= 96; raio += 2) {
            for (let i = 0; i < 8; i++) {
                const ang = (i / 8) * Math.PI * 2;
                const px = x + Math.cos(ang) * raio;
                const py = y + Math.sin(ang) * raio;
                // O resgate respeita o parapeito: quem foi espremido contra a
                // margem sai pela água, não aparecendo em cima da ponte.
                if (this.aceita(x, y + offsetY, px, py + offsetY, rx, ry)) return { x: px, y: py };
            }
        }
        return undefined;
    }

    resolveMove(
        prevX: number, prevY: number,
        nextX: number, nextY: number,
        offsetY: number, rx: number, ry: number,
    ): { x: number; y: number } {
        // Partida inválida: primeiro sai da parede, senão a bisseção abaixo
        // "anda" dentro dela.
        if (!this.canStand(prevX, prevY + offsetY, rx, ry)) {
            const saida = this.nearestFree(prevX, prevY, offsetY, rx, ry);
            if (saida) return saida;
            return { x: prevX, y: prevY };
        }

        const dx = nextX - prevX;
        const dy = nextY - prevY;

        // Caminho livre: nada a resolver (o caso esmagadoramente mais comum).
        if (this.aceita(prevX, prevY + offsetY, nextX, nextY + offsetY, rx, ry)) {
            return { x: nextX, y: nextY };
        }

        // Bateu. Três candidatos: seguir na diagonal até onde couber, deslizar
        // em X ou deslizar em Y — cada um levado até encostar. Vence o que
        // rende mais deslocamento, então uma parede inclinada não trava o
        // movimento e uma quina não vira parada seca.
        const tDiag = (dx !== 0 && dy !== 0)
            ? this.maxAlong(prevX, prevY, dx, dy, offsetY, rx, ry)
            : 0;
        const tX = dx !== 0 ? this.maxAlong(prevX, prevY, dx, 0, offsetY, rx, ry) : 0;
        const tY = dy !== 0 ? this.maxAlong(prevX, prevY, 0, dy, offsetY, rx, ry) : 0;

        const avancoDiag = tDiag * Math.hypot(dx, dy);
        const avancoX = tX * Math.abs(dx);
        const avancoY = tY * Math.abs(dy);


        const melhorAvanco = Math.max(avancoDiag, avancoX, avancoY);
        if (melhorAvanco < SLIDE_MIN_AVANCO) {
            const desvio = this.slideAround(prevX, prevY, dx, dy, offsetY, rx, ry);
            if (desvio) return desvio;
        }

        if (avancoDiag >= avancoX && avancoDiag >= avancoY) {
            return { x: prevX + dx * tDiag, y: prevY + dy * tDiag };
        }
        if (avancoX >= avancoY) return { x: prevX + dx * tX, y: prevY };
        return { x: prevX, y: prevY + dy * tY };
    }

    /**
     * Deslize pela superfície quando nem a diagonal nem os eixos avançam.
     *
     * Os candidatos de cima só sabem cortar o passo em X e em Y. Contra uma
     * borda INCLINADA — a margem de uma ilha, a quina de uma muralha — quem
     * anda numa direção só (a tecla é um eixo puro) fica com os três candidatos
     * zerados e para seco, mesmo tendo a superfície inteira livre ao lado.
     *
     * Aqui o passo é GIRADO em `SLIDE_ANGLES` para os dois lados, mantendo o
     * mesmo tamanho, e vence o que mais avança NA DIREÇÃO PEDIDA. Contra uma
     * parede reta de frente todos os giros continuam batendo nela e o resultado
     * é a parada seca de sempre — deslizar só acontece quando existe superfície
     * para deslizar.
     *
     * Custo: só roda no quadro em que o personagem ficaria parado, e no máximo
     * quatro bisseções. O deslocamento é sempre <= o passo do quadro, então não
     * existe correção grande nem salto.
     */
    private slideAround(
        prevX: number, prevY: number, dx: number, dy: number,
        offsetY: number, rx: number, ry: number,
    ): { x: number; y: number } | undefined {
        const passo = Math.hypot(dx, dy);
        if (passo < SLIDE_MIN_AVANCO) return undefined;

        const base = Math.atan2(dy, dx);
        const dirX = dx / passo;
        const dirY = dy / passo;

        let melhor: { x: number; y: number } | undefined;
        let melhorProjecao = SLIDE_MIN_AVANCO;

        for (const desvio of SLIDE_ANGLES) {
            for (const lado of [1, -1]) {
                const ang = base + lado * desvio;
                const gx = Math.cos(ang) * passo;
                const gy = Math.sin(ang) * passo;

                const t = this.maxAlong(prevX, prevY, gx, gy, offsetY, rx, ry);
                if (t <= 0) continue;

                // Projeção no rumo original: entre dois desvios livres, vale
                // mais o que leva o personagem para onde ele queria ir.
                const projecao = (gx * dirX + gy * dirY) * t;
                if (projecao <= melhorProjecao) continue;

                melhorProjecao = projecao;
                melhor = { x: prevX + gx * t, y: prevY + gy * t };
            }
        }

        return melhor;
    }
}

/**
 * Desvios testados ao deslizar, em radianos (30° e 60°).
 *
 * Dois níveis bastam: 30° cobre a borda quase paralela, 60° a borda bem
 * inclinada. Passar de 60° já seria andar quase de lado em relação ao que o
 * jogador pediu.
 */
const SLIDE_ANGLES = [Math.PI / 6, Math.PI / 3];

/** Avanço abaixo do qual o passo conta como "não saiu do lugar", em px. */
const SLIDE_MIN_AVANCO = 0.05;
