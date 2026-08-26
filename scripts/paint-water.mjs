/**
 * Pinta a ÁGUA na máscara de colisão do cliente.
 *
 * A máscara era binária (branco = chão, preto = bloqueado), e nela o rio era
 * indistinguível de uma muralha. Como a água passou a ser navegável (mais
 * lenta), ela precisa de uma classe própria — e o lugar certo para isso é a
 * própria máscara, que já é a fonte de verdade da colisão dos dois lados:
 *
 *     branco (255,255,255) chão livre
 *     azul   (0,0,255)     água: navegável, com WATER_SPEED_FACTOR
 *     preto  (0,0,0)       parede
 *
 * De onde sai a água: da ARTE (`assets/arena.png`), onde o rio e o mar são
 * azulados (b > r) enquanto muralha e chão são amarronzados. Cruzando isso com
 * o que a máscara já marca como bloqueado, sobra exatamente a água — nada de
 * coordenada cravada.
 *
 * Telhados azuis das construções também são azuis na arte, então só entram os
 * COMPONENTES CONEXOS grandes (rio e mar). A separação é folgada: os corpos
 * d'água têm dezenas de milhares de pixels e os telhados, poucos milhares.
 *
 * Tamanho, porém, não separa de CÉU — o fundo atrás do castelo é azul, é
 * grande e passava no corte. Quem separa é o passo 5: água que não encosta em
 * chão nenhum não é água, é fundo, e volta a ser parede.
 *
 * É um passo de asset, não de execução: roda à mão (`npm run paint:water`),
 * o resultado é revisável no editor de imagem e vai versionado. Rodar de novo
 * numa máscara já pintada dá o mesmo resultado (o azul continua sendo "não
 * branco", logo continua sendo água).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliente = path.resolve(raiz, "../chess-armageddon");

const scenario = fs.readFileSync(path.join(cliente, "src/constants/Scenario.js"), "utf8");
const achaCaminho = (nome, padrao) => {
    const m = scenario.match(padrao);
    if (!m) {
        console.error(`erro: não achei ${nome} em src/constants/Scenario.js`);
        process.exit(1);
    }
    return path.resolve(cliente, m[1]);
};

const arenaPath = achaCaminho("ARENA_PATH", /ARENA_PATH\s*=\s*['"]([^'"]+)['"]/);
const maskPath = achaCaminho("COLLISION_PATH", /COLLISION_PATH\s*=\s*['"]([^'"]+)['"]/);

/** Azul da arte: o rio é esverdeado-azulado, o terreno é amarronzado. */
const MARGEM_AZUL = 20;
/** Piso de tamanho do corpo d'água, em pixels. Abaixo disso é telhado. */
const MIN_AREA = 20000;

/**
 * Espessura máxima da "praia", em pixels.
 *
 * Entre o chão e a água existe uma faixa fina de água rasa que a máscara
 * antiga marcava como bloqueada — quando o rio era intransponível ela não
 * incomodava, mas agora ela seria uma mureta invisível trancando quem quer
 * entrar n'água. Todo pixel bloqueado que fica a menos de PRAIA tanto da água
 * quanto do chão livre é essa película, e vira água.
 *
 * O valor é metade do raio do menor corpo do jogo (peão, rx 50): uma parede
 * mais fina que um corpo não é parede, é margem. Muralha de verdade é ordens
 * de grandeza mais grossa e não é tocada — o teste é ficar perto DOS DOIS
 * lados ao mesmo tempo.
 */
const PRAIA = 24;

const arte = PNG.sync.read(fs.readFileSync(arenaPath));
const mascara = PNG.sync.read(fs.readFileSync(maskPath));

if (arte.width !== mascara.width || arte.height !== mascara.height) {
    console.error(`erro: arte ${arte.width}x${arte.height} e máscara ${mascara.width}x${mascara.height} têm tamanhos diferentes`);
    process.exit(1);
}

const W = mascara.width;
const H = mascara.height;
const total = W * H;

/**
 * `--only-prune` roda SÓ o passo 5 (fundo sem contato com chão).
 *
 * Existe porque este script não é idempotente: o passo 3 come mais uma faixa
 * de praia a cada rodada, então uma máscara já pintada não pode ser passada
 * pelo script inteiro só para corrigir uma coisa. Medido nesta máscara, a
 * segunda rodada mexia em 2343 px de margem espalhados pelo mapa — exatamente
 * o que não se quer tocar.
 *
 * Com a flag, o passo 5 é uma correção cirúrgica e conferível: ele só APAGA
 * água que não encosta em chão, e não tem como criar água nova.
 */
const somentePoda = process.argv.includes("--only-prune");

// 1. candidatos: bloqueado na máscara E azul na arte.
const agua = new Uint8Array(total);
for (let i = 0; i < total && !somentePoda; i++) {
    if (mascara.data[i * 4] > 128) continue; // já é chão livre
    if (arte.data[i * 4 + 2] > arte.data[i * 4] + MARGEM_AZUL) agua[i] = 1;
}

// 2. só os corpos d'água grandes sobrevivem (telhado azul é pequeno).
const fila = new Int32Array(total);
const visto = new Uint8Array(total);
let pintados = 0;

for (let inicio = 0; inicio < total && !somentePoda; inicio++) {
    if (!agua[inicio] || visto[inicio]) continue;

    let cabeca = 0;
    let cauda = 0;
    fila[cauda++] = inicio;
    visto[inicio] = 1;

    while (cabeca < cauda) {
        const i = fila[cabeca++];
        const x = i % W;
        const y = (i / W) | 0;
        if (x > 0 && agua[i - 1] && !visto[i - 1]) { visto[i - 1] = 1; fila[cauda++] = i - 1; }
        if (x < W - 1 && agua[i + 1] && !visto[i + 1]) { visto[i + 1] = 1; fila[cauda++] = i + 1; }
        if (y > 0 && agua[i - W] && !visto[i - W]) { visto[i - W] = 1; fila[cauda++] = i - W; }
        if (y < H - 1 && agua[i + W] && !visto[i + W]) { visto[i + W] = 1; fila[cauda++] = i + W; }
    }

    if (cauda < MIN_AREA) continue;

    for (let k = 0; k < cauda; k++) {
        const i = fila[k];
        mascara.data[i * 4] = 0;
        mascara.data[i * 4 + 1] = 0;
        mascara.data[i * 4 + 2] = 255;
        mascara.data[i * 4 + 3] = 255;
        pintados++;
    }
}

// 3. praia: película fina de bloqueado entre a água e o chão livre.
const distAgua = new Int32Array(total).fill(-1);
const distChao = new Int32Array(total).fill(-1);

/** BFS multi-origem sobre os pixels BLOQUEADOS, até PRAIA de distância. */
const espalha = (dist, semente) => {
    let cabeca = 0;
    let cauda = 0;
    for (let i = 0; i < total; i++) {
        if (semente(i)) { dist[i] = 0; fila[cauda++] = i; }
    }
    while (cabeca < cauda) {
        const i = fila[cabeca++];
        if (dist[i] >= PRAIA) continue;
        const x = i % W;
        const y = (i / W) | 0;
        const vizinhos = [
            x > 0 ? i - 1 : -1,
            x < W - 1 ? i + 1 : -1,
            y > 0 ? i - W : -1,
            y < H - 1 ? i + W : -1,
        ];
        for (const v of vizinhos) {
            if (v < 0 || dist[v] >= 0) continue;
            // Só atravessa o que está bloqueado: a distância é medida DENTRO
            // da parede, que é o que define a espessura dela.
            if (mascara.data[v * 4] > 128 || ehAgua(v)) continue;
            dist[v] = dist[i] + 1;
            fila[cauda++] = v;
        }
    }
};

const ehAgua = (i) => mascara.data[i * 4 + 2] > 128 && mascara.data[i * 4] <= 128;
if (!somentePoda) {
    espalha(distAgua, (i) => ehAgua(i));
    espalha(distChao, (i) => mascara.data[i * 4] > 128);
}

let praia = 0;
for (let i = 0; i < total && !somentePoda; i++) {
    if (distAgua[i] <= 0 || distChao[i] <= 0) continue;
    if (distAgua[i] > PRAIA || distChao[i] > PRAIA) continue;

    mascara.data[i * 4] = 0;
    mascara.data[i * 4 + 1] = 0;
    mascara.data[i * 4 + 2] = 255;
    mascara.data[i * 4 + 3] = 255;
    praia++;
}

// 4. sujeira: bloco bloqueado minúsculo cercado só de água.
//
// A arte da água tem respingos escuros (pedrinhas, sombra, espuma) que a
// máscara marcava como parede. Cada um deles é invisível para quem joga e
// bloqueia uma área do TAMANHO DO CORPO — as nove sondas de `canStand` batem
// no respingo de até meio corpo de distância. Era isso que travava quem
// atravessava o rio: parede nenhuma na tela, personagem parado.
//
// O corte é a área da elipse do PEÃO (a menor peça): um bloco menor que um
// corpo não é ilha, é sujeira — e a zona morta que ele cria é maior que ele
// mesmo. Ilha de verdade (as grandes, e qualquer uma que encoste em terra)
// não é tocada.
const AREA_CORPO = Math.PI * 50 * 25;

const ehChao = (i) => mascara.data[i * 4] > 128;
const bloqueado = (i) => !ehChao(i) && !ehAgua(i);
const componente = new Int32Array(total).fill(-1);
let sujeira = 0;

for (let inicio = 0; inicio < total && !somentePoda; inicio++) {
    if (!bloqueado(inicio) || componente[inicio] >= 0) continue;

    let cabeca = 0;
    let cauda = 0;
    fila[cauda++] = inicio;
    componente[inicio] = inicio;
    let sóAgua = true;

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
            if (v < 0) continue;
            if (!bloqueado(v)) {
                // Encostou em chão: é margem/estrutura de verdade, fica.
                if (ehChao(v)) sóAgua = false;
                continue;
            }
            if (componente[v] >= 0) continue;
            componente[v] = inicio;
            fila[cauda++] = v;
        }
    }

    if (!sóAgua || cauda > AREA_CORPO) continue;

    for (let k = 0; k < cauda; k++) {
        const i = fila[k];
        mascara.data[i * 4] = 0;
        mascara.data[i * 4 + 1] = 0;
        mascara.data[i * 4 + 2] = 255;
        mascara.data[i * 4 + 3] = 255;
        sujeira++;
    }
}

// 5. sobra: corpo d'água que não encosta em chão nenhum.
//
// O corte de tamanho do passo 2 separa rio e mar de TELHADO azul, que é
// pequeno. Ele não separa de CÉU: o fundo atrás do castelo é azul na arte,
// está bloqueado na máscara e tem dezenas de milhares de pixels — passava
// pelo `MIN_AREA` e virava água navegável no canto superior esquerdo, num
// bolsão que nenhum personagem alcança a pé.
//
// A regra que separa os dois não é tamanho, é topologia, no mesmo espírito do
// corte de `paint-bridges.mjs`: **água que não toca chão não é água, é
// fundo**. Medido nesta máscara — mar: 6132 pixels encostando em chão; rio:
// 1290; céu: 0, a 194 px de qualquer chão, do outro lado da muralha do
// castelo. Não é ajuste fino, é zero contra milhares.
//
// Roda por último de propósito: antes do passo 3 a praia ainda separa a água
// do chão livre, e o rio de verdade seria reprovado junto.
const naoEhAgua = (i) => {
    mascara.data[i * 4] = 0;
    mascara.data[i * 4 + 1] = 0;
    mascara.data[i * 4 + 2] = 0;
    mascara.data[i * 4 + 3] = 255;
};

const compAgua = new Int32Array(total).fill(-1);
let fundo = 0;

for (let inicio = 0; inicio < total; inicio++) {
    if (!ehAgua(inicio) || compAgua[inicio] >= 0) continue;

    let cabeca = 0;
    let cauda = 0;
    fila[cauda++] = inicio;
    compAgua[inicio] = inicio;
    let tocaChao = false;

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
            if (v < 0) continue;
            if (!ehAgua(v)) {
                if (ehChao(v)) tocaChao = true;
                continue;
            }
            if (compAgua[v] >= 0) continue;
            compAgua[v] = inicio;
            fila[cauda++] = v;
        }
    }

    if (tocaChao) continue;

    // Volta a ser parede: é o que o fundo do desenho sempre foi, e o que a
    // máscara dizia antes de este script rodar.
    for (let k = 0; k < cauda; k++) {
        naoEhAgua(fila[k]);
        fundo++;
    }
}

fs.writeFileSync(maskPath, PNG.sync.write(mascara));
console.log(`água pintada em ${maskPath}`);
let azul = 0;
for (let i = 0; i < total; i++) if (ehAgua(i)) azul++;

console.log(
    `  +${pintados} px de corpo d'água, +${praia} px de praia, +${sujeira} px de respingo,` +
    ` -${fundo} px de fundo sem contato com chão` +
    ` — total de água: ${azul} px (${((100 * azul) / total).toFixed(1)}% do mapa)`,
);
console.log("Rode `npm run sync:mask` em seguida e commite as duas cópias.");
