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
 *   2. **livre = canal vermelho > 128**. O limiar (em vez de "é preto?")
 *      perdoa o anti-aliasing da borda do desenho.
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

    /** 1 bit por pixel da metade esquerda: 1 = livre. */
    private readonly bits: Uint8Array;

    private constructor(bits: Uint8Array) {
        this.bits = bits;
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
            for (let i = 0; i < total; i++) {
                // Canal vermelho, mesmo critério do cliente.
                if (png.data[i * 4] > 128) bits[i >> 3] |= 1 << (i & 7);
            }

            console.log(`máscara de colisão carregada de ${arquivo}`);
            return new CollisionMask(bits);
        }

        throw new Error(
            `máscara de colisão não encontrada. Procurei em: ${CANDIDATOS.filter(Boolean).join(", ")}`,
        );
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
        if (this.canStand(x + dx, y + dy + offsetY, rx, ry)) return 1;

        let baixo = 0;
        let alto = 1;
        for (let i = 0; i < 4; i++) {
            const meio = (baixo + alto) / 2;
            if (this.canStand(x + dx * meio, y + dy * meio + offsetY, rx, ry)) baixo = meio;
            else alto = meio;
        }
        return baixo;
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
                if (this.canStand(px, py + offsetY, rx, ry)) return { x: px, y: py };
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
        if (this.canStand(nextX, nextY + offsetY, rx, ry)) return { x: nextX, y: nextY };

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

        if (avancoDiag >= avancoX && avancoDiag >= avancoY) {
            return { x: prevX + dx * tDiag, y: prevY + dy * tDiag };
        }
        if (avancoX >= avancoY) return { x: prevX + dx * tX, y: prevY };
        return { x: prevX, y: prevY + dy * tY };
    }
}
