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
 * O primeiro é o asset do cliente (fonte única em desenvolvimento); o segundo é
 * a cópia que `npm run build` deixa junto do servidor, para o deploy — que é
 * separado e não enxerga a pasta do cliente. `COLLISION_MASK_PATH` cobre
 * qualquer arranjo diferente sem precisar editar código.
 */
const CANDIDATOS = [
    process.env.COLLISION_MASK_PATH,
    "../chess-armageddon/assets/collision.png",
    "assets/collision.png",
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

    /**
     * Decodifica o PNG e monta o bitset. Chamado uma vez, no boot.
     *
     * @throws se o arquivo não existir ou não tiver o tamanho esperado — uma
     *         máscara errada deixaria todo mundo atravessando parede, e falhar
     *         alto na subida é melhor que descobrir isso em jogo.
     */
    static load(): CollisionMask {
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
     * Cinco pontos (centro e as quatro pontas), com os raios a 70% — idêntico
     * ao `isPositionWalkable` do offline. Testar só o centro deixaria metade do
     * corpo entrar na parede; testar a elipse inteira exigiria varrer pixels a
     * cada tick para ganhar pouco.
     */
    canStand(cx: number, cy: number, rx: number, ry: number): boolean {
        const dx = rx * 0.7;
        const dy = ry * 0.7;
        return this.isWalkable(cx, cy)
            && this.isWalkable(cx + dx, cy)
            && this.isWalkable(cx - dx, cy)
            && this.isWalkable(cx, cy + dy)
            && this.isWalkable(cx, cy - dy);
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
    resolveMove(
        prevX: number, prevY: number,
        nextX: number, nextY: number,
        offsetY: number, rx: number, ry: number,
    ): { x: number; y: number } {
        if (this.canStand(nextX, nextY + offsetY, rx, ry)) return { x: nextX, y: nextY };
        if (this.canStand(nextX, prevY + offsetY, rx, ry)) return { x: nextX, y: prevY };
        if (this.canStand(prevX, nextY + offsetY, rx, ry)) return { x: prevX, y: nextY };
        return { x: prevX, y: prevY };
    }
}
