/**
 * Copia a máscara de colisão do cliente para junto do servidor.
 *
 * A fonte única é o asset do cliente (`chess-armageddon/assets/collision.png`):
 * é ele que o jogo desenha e é dele que o modo offline lê a colisão. Em
 * desenvolvimento o servidor lê direto de lá; no deploy os dois projetos vão
 * para hosts diferentes e a pasta do cliente não existe — daí esta cópia, feita
 * no `build`.
 *
 * Copiar (em vez de manter duas imagens versionadas) é o que garante que as
 * duas pontas usem exatamente os mesmos pixels.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origem = path.resolve(raiz, "../chess-armageddon/assets/collision.png");
const destino = path.resolve(raiz, "assets/collision.png");

if (!fs.existsSync(origem)) {
    console.warn(`aviso: ${origem} não existe; mantendo ${destino} como está`);
    process.exit(0);
}

fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.copyFileSync(origem, destino);
console.log(`máscara de colisão copiada para ${destino}`);
