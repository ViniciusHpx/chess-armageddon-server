import { Client, Room } from "@colyseus/sdk";
import { cli, Options } from "@colyseus/loadtest";

/**
 * Cliente sintético para `npm run loadtest`.
 *
 * Imita o tráfego real: muda de direção de vez em quando e ataca, para medir a
 * sala com carga parecida com a de jogadores de verdade — e não com clientes
 * mudos, que não custam quase nada.
 */
export async function main(options: Options) {
    const client = new Client(options.endpoint);
    const room: Room = await client.joinOrCreate(options.roomName, {
        name: "Bot de carga",
    });

    console.log(`entrou como ${room.sessionId}`);

    room.onMessage("kill", () => { /* só consome */ });

    room.onLeave((code: number) => console.log("saiu", code));

    // Troca de direção a cada ~1 s.
    const walk = setInterval(() => {
        const angle = Math.random() * Math.PI * 2;
        room.send("i", { dx: Math.cos(angle), dy: Math.sin(angle) });
    }, 1000);

    // Ataca a cada ~2,5 s, metade das vezes segurando até carregar.
    const swing = setInterval(() => {
        const holdMs = Math.random() < 0.5 ? 100 : 1200;
        room.send("a", 1);
        setTimeout(() => room.send("a", 0), holdMs);
    }, 2500);

    // Renasce assim que morrer.
    const revive = setInterval(() => {
        const me = (room.state as any)?.actors?.get(room.sessionId);
        if (me && !me.alive) room.send("r");
    }, 500);

    room.onLeave(() => {
        clearInterval(walk);
        clearInterval(swing);
        clearInterval(revive);
    });
}

cli(main);
