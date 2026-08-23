import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import {
    defineServer,
    defineRoom,
    monitor,
    playground,
    LobbyRoom,
} from "colyseus";

import { ArenaRoom } from "./rooms/ArenaRoom.js";
import { CollisionMask } from "./sim/CollisionMask.js";

/**
 * Carrega a máscara de colisão ANTES de aceitar conexões.
 *
 * Antes ela era carregada na primeira `new World()`, ou seja, ao criar a
 * primeira sala. Faltando o arquivo, o erro estourava dentro do matchmaking: o
 * `/health` continuava respondendo 200, `POST /matchmake/create/arena` devolvia
 * 523, e o navegador reportava aquilo como um problema de CORS — porque a
 * página de erro da borda não traz `Access-Control-Allow-Origin`.
 *
 * Carregar aqui transforma isso num erro de subida, com mensagem clara no log.
 */
CollisionMask.load();

const server = defineServer({
    rooms: {
        arena: defineRoom(ArenaRoom),

        /**
         * Lobby embutido do Colyseus: mantém a lista de salas `arena` e a
         * empurra para quem estiver conectado (eventos `rooms`, `+` e `-`).
         *
         * É o que evita polling no cliente — a lista só chega quando muda, e
         * quem publica a mudança é a própria `ArenaRoom` via `updateLobby()`.
         */
        lobby: defineRoom(LobbyRoom),
    },

    express: (app) => {
        app.get("/health", (_req, res) => {
            res.json({ ok: true });
        });

        /**
         * Painel do Colyseus. Só existe se MONITOR_PASSWORD estiver definida —
         * sem senha a rota responde 404, para não expor salas, sessionIds e
         * estado do jogo a qualquer um que descubra a URL.
         */
        app.use("/monitor", requireMonitorAuth, monitor());

        /**
         * Playground do Colyseus: cliente de teste embutido. Nunca em produção.
         */
        if (process.env.NODE_ENV !== "production") {
            app.use("/", playground());
        }
    },
});

export default server;

// ---------------------------------------------------------------------------

function requireMonitorAuth(req: Request, res: Response, next: NextFunction): void {
    const password = process.env.MONITOR_PASSWORD;
    if (!password) {
        res.status(404).send("Not found");
        return;
    }

    const expectedUser = process.env.MONITOR_USER || "admin";
    const [scheme, encoded] = (req.headers.authorization || "").split(" ");

    if (scheme === "Basic" && encoded) {
        const decoded = Buffer.from(encoded, "base64").toString("utf8");
        const separator = decoded.indexOf(":");
        const user = decoded.slice(0, separator);
        const pass = decoded.slice(separator + 1);

        if (safeEqual(user, expectedUser) && safeEqual(pass, password)) {
            next();
            return;
        }
    }

    res.set("WWW-Authenticate", 'Basic realm="colyseus-monitor"').status(401).send("Auth required");
}

/** Comparação de tempo constante: não vaza o prefixo correto da senha. */
function safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}
