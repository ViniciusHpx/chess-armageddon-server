/**
 * Pinta as PONTES na máscara de colisão do cliente.
 *
 * Depois que a água virou navegável, a ponte deixou de ser a única travessia:
 * quem vinha nadando entrava pelo MEIO dela, de lado, e a ponte virou detalhe
 * de arte. A regra desejada é a de sempre — ponte se atravessa pela ENTRADA,
 * vindo da terra —, e para isso o terreno precisa de uma quarta classe:
 *
 *     branco   (255,255,255) chão livre
 *     azul     (0,0,255)     água: navegável, com WATER_SPEED_FACTOR
 *     VERMELHO (255,0,0)     tabuleiro da ponte: chão normal, só que o passo
 *                            água <-> ponte é proibido (ver CollisionMask)
 *     preto    (0,0,0)       parede
 *
 * O vermelho tem `r > 128`, então um decodificador que não conheça a classe
 * continua lendo a ponte como chão — a máscara nova responde "dá para andar?"
 * exatamente como a antiga.
 *
 * **De onde saem as pontes: da própria máscara, sem coordenada cravada.**
 * A definição é topológica e vale para qualquer número de pontes:
 *
 *   1. *vão* — pixel de chão com água dos DOIS lados a menos de `VAO` px
 *      (esquerda e direita, ou cima e baixo), medido sem atravessar parede.
 *      Isso pega o tabuleiro inteiro e para exatamente na margem, onde a terra
 *      deixa de ser uma faixa entre duas águas: é ali a entrada;
 *   2. *corte* — dos componentes achados em (1) sobram só os que LIGAM DUAS
 *      MASSAS DE TERRA distintas. Tirando a ponte, as duas ilhas ficam
 *      separadas; tirando uma língua de areia, nada muda. É esse teste que
 *      separa ponte de margem estreita, e é ele que dispensa qualquer lista
 *      de pontes escrita à mão.
 *
 * Medido nesta máscara: o teste acha UM tabuleiro na metade esquerda
 * (x 1273..1452, y 695..787 — 92 px de largura útil) e, como o mundo é o
 * espelho dessa metade, isso são as DUAS pontes do mapa, com a mesma regra e
 * sem código repetido. O resultado é idêntico para `VAO` de 100 a 200 px:
 * o número não é ajuste fino, é só um teto folgado de largura de tabuleiro.
 *
 * É passo de asset, não de execução: roda à mão (`npm run paint:bridges`,
 * depois de `paint:water`), o resultado é revisável no editor de imagem e vai
 * versionado. Rodar de novo é idempotente — o vermelho volta a branco no
 * começo e a detecção refaz tudo a partir de chão e água.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliente = path.resolve(raiz, "../chess-armageddon");

const scenario = fs.readFileSync(path.join(cliente, "src/constants/Scenario.js"), "utf8");
const achado = scenario.match(/COLLISION_PATH\s*=\s*['"]([^'"]+)['"]/);
if (!achado) {
    console.error("erro: não achei COLLISION_PATH em src/constants/Scenario.js");
    process.exit(1);
}
const maskPath = path.resolve(cliente, achado[1]);

/**
 * Vão máximo de uma ponte, em px.
 *
 * É teto da largura ÚTIL do tabuleiro (a faixa que se atravessa a pé), não do
 * comprimento. O tabuleiro deste mapa tem 92 px, e qualquer valor entre 100 e
 * 200 devolve exatamente a mesma ponte. Acima de ~260 entram penínsulas
 * largas — que o teste do corte ainda descartaria, mas ficar no meio do platô
 * é de graça.
 */
const VAO = 160;

/** Sentinela de "não há água por aqui". Maior que qualquer VAO plausível. */
const LONGE = 1 << 28;

const mascara = PNG.sync.read(fs.readFileSync(maskPath));
const W = mascara.width;
const H = mascara.height;
const total = W * H;

const ehPonte = (i) => mascara.data[i * 4] > 128 && mascara.data[i * 4 + 1] <= 128;

// 0. o vermelho de uma rodada anterior volta a branco: a detecção parte
//    sempre de chão e água, então rodar de novo dá o mesmo resultado mesmo
//    quando os parâmetros mudam.
for (let i = 0; i < total; i++) {
    if (!ehPonte(i)) continue;
    mascara.data[i * 4 + 1] = 255;
    mascara.data[i * 4 + 2] = 255;
}

const chao = new Uint8Array(total);
const agua = new Uint8Array(total);
for (let i = 0; i < total; i++) {
    if (mascara.data[i * 4] > 128) chao[i] = 1;
    else if (mascara.data[i * 4 + 2] > 128) agua[i] = 1;
}

// 1. distância até a água em cada uma das quatro direções, em varredura
//    linear (O(pixels) por direção). A parede ZERA a contagem: água do outro
//    lado de uma muralha não é a margem deste pedaço de terra.
const distancia = (direcao) => {
    const d = new Int32Array(total).fill(LONGE);
    const passo = (i, v) => {
        const atual = agua[i] ? 0 : (chao[i] ? v + 1 : LONGE);
        d[i] = atual;
        return atual;
    };

    if (direcao === "esquerda") {
        for (let y = 0; y < H; y++) { let v = LONGE; for (let x = 0; x < W; x++) v = passo(y * W + x, v); }
    } else if (direcao === "direita") {
        for (let y = 0; y < H; y++) { let v = LONGE; for (let x = W - 1; x >= 0; x--) v = passo(y * W + x, v); }
    } else if (direcao === "cima") {
        for (let x = 0; x < W; x++) { let v = LONGE; for (let y = 0; y < H; y++) v = passo(y * W + x, v); }
    } else {
        for (let x = 0; x < W; x++) { let v = LONGE; for (let y = H - 1; y >= 0; y--) v = passo(y * W + x, v); }
    }
    return d;
};

const dEsq = distancia("esquerda");
const dDir = distancia("direita");
const dCima = distancia("cima");
const dBaixo = distancia("baixo");

const candidato = new Uint8Array(total);
for (let i = 0; i < total; i++) {
    if (!chao[i]) continue;
    if ((dEsq[i] <= VAO && dDir[i] <= VAO) || (dCima[i] <= VAO && dBaixo[i] <= VAO)) candidato[i] = 1;
}

// 2. componentes conexos: os candidatos (possíveis tabuleiros) e, à parte, o
//    chão SEM eles — as massas de terra que restam quando as pontes caem.
const fila = new Int32Array(total);

const rotula = (pertence) => {
    const rotulo = new Int32Array(total).fill(-1);
    let n = 0;

    for (let inicio = 0; inicio < total; inicio++) {
        if (!pertence(inicio) || rotulo[inicio] >= 0) continue;

        let cabeca = 0;
        let cauda = 0;
        fila[cauda++] = inicio;
        rotulo[inicio] = n;

        while (cabeca < cauda) {
            const i = fila[cabeca++];
            const x = i % W;
            const y = (i / W) | 0;
            const vizinhos = [
                x > 0 ? i - 1 : -1,
                x < W - 1 ? i + 1 : -1,
                y > 0 ? i - W : -1,
                y < H - 1 ? i + W : -1,
            ];
            for (const v of vizinhos) {
                if (v < 0 || !pertence(v) || rotulo[v] >= 0) continue;
                rotulo[v] = n;
                fila[cauda++] = v;
            }
        }
        n++;
    }
    return { rotulo, n };
};

const tabuleiros = rotula((i) => candidato[i] === 1);
const terras = rotula((i) => chao[i] === 1 && candidato[i] === 0);

// 3. o corte: quantas massas de terra distintas cada candidato encosta. Duas
//    ou mais = é ele que liga as duas margens, ou seja, é ponte.
const encosta = Array.from({ length: tabuleiros.n }, () => new Set());
for (let i = 0; i < total; i++) {
    const p = tabuleiros.rotulo[i];
    if (p < 0) continue;

    const x = i % W;
    const y = (i / W) | 0;
    const vizinhos = [
        x > 0 ? i - 1 : -1,
        x < W - 1 ? i + 1 : -1,
        y > 0 ? i - W : -1,
        y < H - 1 ? i + W : -1,
    ];
    for (const v of vizinhos) {
        if (v >= 0 && terras.rotulo[v] >= 0) encosta[p].add(terras.rotulo[v]);
    }
}

const caixas = new Map();
let pintados = 0;

for (let i = 0; i < total; i++) {
    const p = tabuleiros.rotulo[i];
    if (p < 0 || encosta[p].size < 2) continue;

    mascara.data[i * 4] = 255;
    mascara.data[i * 4 + 1] = 0;
    mascara.data[i * 4 + 2] = 0;
    mascara.data[i * 4 + 3] = 255;
    pintados++;

    const x = i % W;
    const y = (i / W) | 0;
    const caixa = caixas.get(p) ?? { n: 0, minX: W, maxX: 0, minY: H, maxY: 0 };
    caixa.n++;
    caixa.minX = Math.min(caixa.minX, x);
    caixa.maxX = Math.max(caixa.maxX, x);
    caixa.minY = Math.min(caixa.minY, y);
    caixa.maxY = Math.max(caixa.maxY, y);
    caixas.set(p, caixa);
}

if (caixas.size === 0) {
    console.error(
        "erro: nenhuma ponte encontrada. A máscara tem água pintada " +
        "(`npm run paint:water`)? Nenhum pixel foi alterado.",
    );
    process.exit(1);
}

fs.writeFileSync(maskPath, PNG.sync.write(mascara));
console.log(`pontes pintadas em ${maskPath}`);
console.log(
    `  ${caixas.size} tabuleiro(s) na metade esquerda (o mundo espelha, ` +
    `então são ${caixas.size * 2} pontes), ${pintados} px:`,
);
for (const c of caixas.values()) {
    console.log(
        `  - x ${c.minX}..${c.maxX}, y ${c.minY}..${c.maxY} ` +
        `(${c.maxX - c.minX + 1} x ${c.maxY - c.minY + 1}, ${c.n} px)`,
    );
}
console.log("Rode `npm run sync:mask` em seguida e commite as duas cópias.");
