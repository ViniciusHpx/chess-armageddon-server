/**
 * Malha de navegação dos bots, derivada da máscara de colisão.
 *
 * O bot não pode simplesmente andar na direção do alvo: o mapa tem rio, muralha
 * e uma ponte, e a linha reta encosta na parede e para. Aqui o mesmo
 * `CollisionMask` que decide a colisão vira um grid grosseiro, e o caminho sai
 * de um A* sobre ele — a ponte é só mais uma célula caminhável, sem regra
 * especial para "rio" ou "ponte".
 *
 * **Resolução.** 32 px por célula: 156 x 53 = 8268 células no mapa inteiro
 * (~8 KB de bytes + 16 KB de rótulos). A ponte tem ~96 px de altura livre, ou
 * seja 3 células — com 64 px ela quase desapareceria, e é justamente a
 * travessia que o bot precisa achar.
 *
 * **Custo.** O grid é montado uma vez, na subida, junto com os componentes
 * conexos. Depois disso ninguém mais lê pixel para navegar: o A* anda em
 * índices de array e os componentes respondem "existe caminho?" em O(1) — sem
 * isso, um alvo inalcançável faria o A* varrer o mapa inteiro antes de desistir.
 */
import { CollisionMask } from "./CollisionMask.js";
import { RANKS, WATER_SPEED_FACTOR, WORLD_HEIGHT, WORLD_WIDTH } from "./constants.js";

/** Lado da célula, em px. Ver "Resolução" acima antes de mexer. */
export const NAV_CELL = 32;

/**
 * Teto de nós expandidos por busca.
 *
 * O grid tem 8268 células, então o teto quase nunca é atingido; ele existe para
 * o pior caso não virar um pico de CPU dentro do tick.
 */
const MAX_EXPANSOES = 12000;

/** Passo do teste de linha de visão, em px. Metade do corpo de um peão. */
const LOS_PASSO = 24;

export class NavGrid {
    readonly cols: number;
    readonly rows: number;

    /** 1 = a peça cabe no centro da célula. */
    private readonly walkable: Uint8Array;

    /**
     * 1 = célula de água. Caminhável como qualquer outra, só que mais cara.
     *
     * Atravessar a nado custa `1 / WATER_SPEED_FACTOR` (1,25) por passo, que é
     * exatamente o tempo a mais que se leva ali. Assim o A* prefere a ponte e a
     * terra quando elas não são um desvio grande, e mergulha quando nadar
     * realmente sai mais rápido — sem que a água vire barreira.
     */
    private readonly water: Uint8Array;

    /** Rótulo do componente conexo de cada célula; -1 = bloqueada. */
    private readonly component: Int16Array;

    private readonly mask: CollisionMask;

    // Buffers do A*, reaproveitados entre buscas: alocar três arrays de 8k por
    // chamada seria lixo garantido a cada repath.
    private readonly gScore: Float32Array;
    private readonly fScore: Float32Array;
    private readonly cameFrom: Int32Array;
    private readonly visitCarimbo: Int32Array;
    private carimbo = 0;

    /** Instância única do processo: o grid é o mesmo para todas as salas. */
    private static cache: NavGrid | undefined;

    static shared(mask: CollisionMask): NavGrid {
        if (!NavGrid.cache) NavGrid.cache = new NavGrid(mask);
        return NavGrid.cache;
    }

    private constructor(mask: CollisionMask) {
        this.mask = mask;
        this.cols = Math.ceil(WORLD_WIDTH / NAV_CELL);
        this.rows = Math.ceil(WORLD_HEIGHT / NAV_CELL);

        const total = this.cols * this.rows;
        this.walkable = new Uint8Array(total);
        this.water = new Uint8Array(total);
        this.component = new Int16Array(total).fill(-1);
        this.gScore = new Float32Array(total);
        this.fScore = new Float32Array(total);
        this.cameFrom = new Int32Array(total);
        this.visitCarimbo = new Int32Array(total);

        this.build();
    }

    /**
     * Marca as células e rotula os componentes.
     *
     * A célula usa os raios da RAINHA (a maior peça): um caminho aprovado aqui
     * serve para qualquer rank. Usar o peão faria a rota passar por frestas onde
     * a rainha empaca — e bot empacado é exatamente o que estamos consertando.
     */
    private build(): void {
        const rx = 50 * (RANKS.QUEEN.size.width / 128);
        const ry = 25 * (RANKS.QUEEN.size.height / 128);

        for (let ry_ = 0; ry_ < this.rows; ry_++) {
            for (let cx = 0; cx < this.cols; cx++) {
                const x = cx * NAV_CELL + NAV_CELL / 2;
                const y = ry_ * NAV_CELL + NAV_CELL / 2;
                if (!this.mask.canStand(x, y, rx, ry)) continue;

                const i = ry_ * this.cols + cx;
                this.walkable[i] = 1;
                if (this.mask.isWater(x, y)) this.water[i] = 1;
            }
        }

        this.rotulaComponentes();
    }

    /** Flood fill em largura; roda uma vez e responde "dá para chegar?" depois. */
    private rotulaComponentes(): void {
        const fila = new Int32Array(this.cols * this.rows);
        let rotulo = 0;

        for (let inicio = 0; inicio < this.walkable.length; inicio++) {
            if (!this.walkable[inicio] || this.component[inicio] !== -1) continue;

            let cabeca = 0;
            let cauda = 0;
            fila[cauda++] = inicio;
            this.component[inicio] = rotulo;

            while (cabeca < cauda) {
                const atual = fila[cabeca++];
                const cx = atual % this.cols;
                const cy = (atual / this.cols) | 0;

                for (let d = 0; d < 4; d++) {
                    const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0);
                    const ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
                    if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;

                    const vizinho = ny * this.cols + nx;
                    if (!this.walkable[vizinho] || this.component[vizinho] !== -1) continue;

                    this.component[vizinho] = rotulo;
                    fila[cauda++] = vizinho;
                }
            }
            rotulo++;
        }
    }

    private index(x: number, y: number): number {
        const cx = Math.min(this.cols - 1, Math.max(0, (x / NAV_CELL) | 0));
        const cy = Math.min(this.rows - 1, Math.max(0, (y / NAV_CELL) | 0));
        return cy * this.cols + cx;
    }

    /**
     * Célula caminhável mais próxima, num raio pequeno.
     *
     * Um bot empurrado para dentro da parede (separação entre personagens) ou
     * parado numa borda cai numa célula bloqueada; sem isto o A* recusaria a
     * busca e ele ficaria parado para sempre.
     */
    private celulaValida(x: number, y: number): number {
        const inicial = this.index(x, y);
        if (this.walkable[inicial]) return inicial;

        const cx0 = inicial % this.cols;
        const cy0 = (inicial / this.cols) | 0;

        for (let raio = 1; raio <= 3; raio++) {
            for (let dy = -raio; dy <= raio; dy++) {
                for (let dx = -raio; dx <= raio; dx++) {
                    if (Math.abs(dx) !== raio && Math.abs(dy) !== raio) continue;

                    const cx = cx0 + dx;
                    const cy = cy0 + dy;
                    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) continue;

                    const i = cy * this.cols + cx;
                    if (this.walkable[i]) return i;
                }
            }
        }
        return -1;
    }

    /** Existe rota possível entre os dois pontos? Consulta O(1). */
    canReach(fromX: number, fromY: number, toX: number, toY: number): boolean {
        const a = this.celulaValida(fromX, fromY);
        const b = this.celulaValida(toX, toY);
        return a >= 0 && b >= 0 && this.component[a] === this.component[b];
    }

    /**
     * Dá para ir em linha reta?
     *
     * Caso comum em campo aberto — e o mais barato: alguns testes de pixel em
     * vez de uma busca. Enquanto responde `true`, o bot nem chega a pedir rota.
     */
    hasLineOfSight(x0: number, y0: number, x1: number, y1: number, rx: number, ry: number): boolean {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) return true;

        const passos = Math.ceil(dist / LOS_PASSO);
        for (let i = 1; i <= passos; i++) {
            const t = i / passos;
            if (!this.mask.canStand(x0 + dx * t, y0 + dy * t, rx, ry)) return false;
        }
        return true;
    }

    /**
     * A* de `from` até `to`, em coordenadas de mundo.
     *
     * Devolve os waypoints (centros de célula) já sem o ponto de partida, ou
     * `null` se não houver caminho. A lista sai "esticada": pontos intermediários
     * que o bot alcança em linha reta são descartados, senão ele andaria em
     * escadinha de 32 px e ficaria oscilando entre células.
     */
    findPath(
        fromX: number, fromY: number, toX: number, toY: number,
        rx: number, ry: number,
    ): number[] | null {
        const inicio = this.celulaValida(fromX, fromY);
        const fim = this.celulaValida(toX, toY);
        if (inicio < 0 || fim < 0) return null;
        if (this.component[inicio] !== this.component[fim]) return null;
        if (inicio === fim) return [toX, toY];

        const carimbo = ++this.carimbo;
        const aberta: number[] = [inicio];

        this.gScore[inicio] = 0;
        this.fScore[inicio] = this.heuristica(inicio, fim);
        this.cameFrom[inicio] = -1;
        this.visitCarimbo[inicio] = carimbo;

        let expansoes = 0;

        while (aberta.length > 0 && expansoes++ < MAX_EXPANSOES) {
            // Lista aberta pequena (dezenas de nós): varrer o menor custa menos
            // que manter um heap para este tamanho de grid.
            let melhor = 0;
            for (let i = 1; i < aberta.length; i++) {
                if (this.fScore[aberta[i]] < this.fScore[aberta[melhor]]) melhor = i;
            }
            const atual = aberta[melhor];
            aberta[melhor] = aberta[aberta.length - 1];
            aberta.pop();

            if (atual === fim) return this.reconstroi(atual, toX, toY, rx, ry);

            const cx = atual % this.cols;
            const cy = (atual / this.cols) | 0;

            for (let d = 0; d < 8; d++) {
                const dx = DIR_X[d];
                const dy = DIR_Y[d];
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;

                const vizinho = ny * this.cols + nx;
                if (!this.walkable[vizinho]) continue;

                // Diagonal só passa se os dois lados estiverem livres: sem isso
                // a rota corta quinas por onde o corpo não passa.
                if (dx !== 0 && dy !== 0) {
                    if (!this.walkable[cy * this.cols + nx]) continue;
                    if (!this.walkable[ny * this.cols + cx]) continue;
                }

                const passo = (dx !== 0 && dy !== 0 ? 1.4142 : 1)
                    * (this.water[vizinho] ? CUSTO_AGUA : 1);
                const custo = this.gScore[atual] + passo;
                const visitado = this.visitCarimbo[vizinho] === carimbo;
                if (visitado && custo >= this.gScore[vizinho]) continue;

                this.visitCarimbo[vizinho] = carimbo;
                this.gScore[vizinho] = custo;
                this.fScore[vizinho] = custo + this.heuristica(vizinho, fim);
                this.cameFrom[vizinho] = atual;
                if (!visitado) aberta.push(vizinho);
            }
        }

        return null;
    }

    private heuristica(a: number, b: number): number {
        const ax = a % this.cols;
        const ay = (a / this.cols) | 0;
        const bx = b % this.cols;
        const by = (b / this.cols) | 0;
        const dx = Math.abs(ax - bx);
        const dy = Math.abs(ay - by);
        // Distância octile: casa com os custos 1 / 1.4142 usados acima.
        return (dx + dy) + (1.4142 - 2) * Math.min(dx, dy);
    }

    /** Refaz o caminho de trás para frente e remove os pontos dispensáveis. */
    private reconstroi(fim: number, toX: number, toY: number, rx: number, ry: number): number[] {
        const cells: number[] = [];
        for (let i = fim; i !== -1; i = this.cameFrom[i]) cells.push(i);
        cells.reverse();

        const pontos: number[] = [];
        for (const c of cells) {
            pontos.push((c % this.cols) * NAV_CELL + NAV_CELL / 2);
            pontos.push(((c / this.cols) | 0) * NAV_CELL + NAV_CELL / 2);
        }
        // O último ponto é o alvo de verdade, não o centro da célula dele.
        pontos[pontos.length - 2] = toX;
        pontos[pontos.length - 1] = toY;

        return this.suaviza(pontos, rx, ry);
    }

    /**
     * Corta pontos que dá para pular em linha reta.
     *
     * O A* devolve um ponto por célula; segui-los todos faz o bot serrilhar e
     * mudar de direção o tempo todo. Aqui sobra só o essencial — em campo aberto
     * normalmente um ponto só.
     */
    private suaviza(pontos: number[], rx: number, ry: number): number[] {
        const saida: number[] = [];
        let ancoraX = pontos[0];
        let ancoraY = pontos[1];

        let i = 2;
        let ultimoVisivel = -1;

        while (i < pontos.length) {
            if (this.hasLineOfSight(ancoraX, ancoraY, pontos[i], pontos[i + 1], rx, ry)) {
                ultimoVisivel = i;
                i += 2;
                continue;
            }

            // Nem o primeiro candidato é visível (a âncora está encostada numa
            // quina): aceita-o assim mesmo. É a célula vizinha, e o importante é
            // o índice avançar — o laço não pode reavaliar o mesmo ponto com a
            // mesma âncora, senão nunca termina.
            if (ultimoVisivel < 0) ultimoVisivel = i;

            saida.push(pontos[ultimoVisivel], pontos[ultimoVisivel + 1]);
            ancoraX = pontos[ultimoVisivel];
            ancoraY = pontos[ultimoVisivel + 1];
            i = ultimoVisivel + 2;
            ultimoVisivel = -1;
        }

        // O destino sempre entra: é ele que o bot precisa alcançar, não o centro
        // da última célula.
        const fimX = pontos[pontos.length - 2];
        const fimY = pontos[pontos.length - 1];
        if (saida.length < 2 || saida[saida.length - 2] !== fimX || saida[saida.length - 1] !== fimY) {
            saida.push(fimX, fimY);
        }

        return saida;
    }
}

/**
 * Multiplicador de custo de uma célula de água.
 *
 * Sai da própria redução de velocidade: andar a 80% leva 1,25 vez mais tempo.
 * Manter a heurística admissível depende de este número ser >= 1 (é).
 */
const CUSTO_AGUA = 1 / WATER_SPEED_FACTOR;

const DIR_X = [1, -1, 0, 0, 1, 1, -1, -1];
const DIR_Y = [0, 0, 1, -1, 1, -1, 1, -1];
