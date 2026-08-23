/**
 * Copia a máscara de colisão do cliente para junto do servidor.
 *
 * A fonte é o asset do cliente (`chess-armageddon/assets/collision.png`): é ele
 * que o jogo desenha e é dele que o modo offline lê a colisão.
 *
 * A cópia em `chess-armageddon-server/assets/` é VERSIONADA de propósito (28 KB):
 * os dois projetos têm deploys separados, e no host do servidor a pasta do
 * cliente não existe. Deixá-la fora do git foi exatamente o que derrubou a
 * criação de salas em produção.
 *
 * Rode `npm run sync:mask` sempre que a arte de colisão mudar, e commite a
 * cópia junto.
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
