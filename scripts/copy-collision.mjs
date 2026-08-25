/**
 * Copia a máscara de colisão do cliente para junto do servidor.
 *
 * A fonte é o asset do cliente, e QUAL asset é ele quem diz: o caminho sai de
 * `COLLISION_PATH` (`chess-armageddon/src/constants/Scenario.js`), o mesmo que
 * o `preload` da cena carrega. Antes estava escrito à mão aqui, o arquivo foi
 * renomeado no cliente e a cópia do servidor congelou numa versão antiga — os
 * dois lados passaram a colidir contra mapas diferentes, e ninguém percebeu
 * porque o script avisava e saía com sucesso.
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
const cliente = path.resolve(raiz, "../chess-armageddon");

// O cliente é a fonte de verdade do nome do arquivo também. Lido como texto
// porque o projeto do cliente não tem package.json: um `import()` do módulo
// ESM dele quebraria (o Node trataria o .js como CommonJS).
const scenario = fs.readFileSync(
    path.join(cliente, "src/constants/Scenario.js"), "utf8",
);
const achado = scenario.match(/COLLISION_PATH\s*=\s*['"]([^'"]+)['"]/);

if (!achado) {
    console.error("erro: não achei COLLISION_PATH em src/constants/Scenario.js");
    process.exit(1);
}

const origem = path.resolve(cliente, achado[1]);
const destino = path.resolve(raiz, "assets/collision.png");

if (!fs.existsSync(origem)) {
    console.error(`erro: ${origem} não existe.`);
    console.error("Rode este script com o repositório do cliente ao lado, e commite a cópia.");
    process.exit(1);
}

fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.copyFileSync(origem, destino);
console.log(`máscara de colisão copiada para ${destino}`);
