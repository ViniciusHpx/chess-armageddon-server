import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { ArenaState } from "../src/rooms/schema/ArenaState.js";
import { RANKS, TEAM_SIZE, TICK_MS } from "../src/sim/constants.js";

/** Espera tempo real de simulação: o World roda em setSimulationInterval. */
const waitTicks = (n: number) => new Promise((r) => setTimeout(r, TICK_MS * n + 30));

describe("ArenaRoom", () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;

    before(async () => (colyseus = await boot(appConfig)));
    after(async () => colyseus.shutdown());
    beforeEach(async () => await colyseus.cleanup());

    it("cria a sala cheia de bots nos dois times", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", {});

        assert.strictEqual(room.state.actors.size, TEAM_SIZE * 2);

        let allies = 0;
        let enemies = 0;
        room.state.actors.forEach((actor) => {
            assert.ok(actor.bot, "sala recém-criada só deve ter bots");
            if (actor.team === 0) allies++;
            else enemies++;
        });

        assert.strictEqual(allies, TEAM_SIZE);
        assert.strictEqual(enemies, TEAM_SIZE);
    });

    it("substitui um bot pelo jogador que entra, sem inflar o time", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", {});
        const client = await colyseus.connectTo(room, { name: "Vinicius" });

        // O total não muda: entrou um humano, saiu um bot.
        assert.strictEqual(room.state.actors.size, TEAM_SIZE * 2);

        const mine = room.state.actors.get(client.sessionId);
        assert.ok(mine, "o jogador deve ter um ator com a chave do sessionId");
        assert.strictEqual(mine!.bot, false);
        assert.strictEqual(mine!.name, "Vinicius");
        assert.strictEqual(mine!.rank, RANKS.PAWN.index);
        assert.strictEqual(mine!.hp, RANKS.PAWN.health);
        assert.strictEqual(mine!.alive, true);
    });

    it("move o personagem conforme a entrada enviada", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", {});
        const client = await colyseus.connectTo(room);
        const actor = room.state.actors.get(client.sessionId)!;

        const startX = actor.x;
        client.send("i", { dx: 1, dy: 0, s: 1 });
        await waitTicks(4);

        assert.ok(
            actor.x > startX,
            `esperava avançar em X, foi de ${startX} para ${actor.x}`,
        );
    });

    it("normaliza a entrada: cliente não consegue correr mais rápido", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", {});
        const honest = await colyseus.connectTo(room);
        const cheater = await colyseus.connectTo(room);

        const honestActor = room.state.actors.get(honest.sessionId)!;
        const cheaterActor = room.state.actors.get(cheater.sessionId)!;

        const honestStart = honestActor.x;
        const cheaterStart = cheaterActor.x;

        honest.send("i", { dx: 1, dy: 0, s: 1 });
        cheater.send("i", { dx: 999, dy: 0, s: 1 });
        await waitTicks(6);

        const honestDelta = honestActor.x - honestStart;
        const cheaterDelta = cheaterActor.x - cheaterStart;

        assert.ok(honestDelta > 0, "o jogador honesto deveria ter andado");
        assert.ok(
            cheaterDelta <= honestDelta + 1,
            `entrada inflada andou ${cheaterDelta} contra ${honestDelta} do honesto`,
        );
    });

    it("devolve em ack a sequência da última entrada processada", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", {});
        const client = await colyseus.connectTo(room);
        const actor = room.state.actors.get(client.sessionId)!;

        assert.strictEqual(actor.ack, 0, "sem entrada nenhuma, ack começa em zero");

        client.send("i", { dx: 1, dy: 0, s: 7 });
        await waitTicks(2);

        assert.strictEqual(actor.ack, 7, "ack deve espelhar a sequência recebida");

        // É esse par (posição, ack) que o cliente usa para reconciliar: o ack
        // tem de valer para a posição publicada no MESMO patch.
        const xNoAck7 = actor.x;
        client.send("i", { dx: 0, dy: 0, s: 8 });
        await waitTicks(3);

        assert.strictEqual(actor.ack, 8);
        assert.ok(actor.x >= xNoAck7, "parar não pode andar para trás");
    });

    it("ignora entrada com sequência velha (reordenação ou cliente adulterado)", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", {});
        const client = await colyseus.connectTo(room);
        const actor = room.state.actors.get(client.sessionId)!;

        client.send("i", { dx: 0, dy: 0, s: 10 });
        await waitTicks(2);
        const parado = actor.x;

        // Chega atrasado um pacote antigo mandando andar: tem de ser descartado.
        client.send("i", { dx: 1, dy: 0, s: 4 });
        await waitTicks(4);

        assert.strictEqual(actor.ack, 10, "ack não pode retroceder");
        assert.strictEqual(
            Math.round(actor.x), Math.round(parado),
            `entrada fora de ordem moveu o personagem de ${parado} para ${actor.x}`,
        );
    });

    it("só marca golpe carregado se o botão ficou tempo suficiente", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", {});
        const client = await colyseus.connectTo(room);
        const actor = room.state.actors.get(client.sessionId)!;

        // Toque rápido: abaixo de RANKS.PAWN.chargeTime (1000 ms).
        client.send("a", 1);
        await waitTicks(2);
        client.send("a", 0);
        await waitTicks(1);

        assert.strictEqual(actor.attacking, true, "o golpe deveria ter começado");
        assert.ok(actor.atkPower < 50, "toque curto não pode virar golpe carregado");
    });

    it("devolve um bot ao time quando o jogador sai", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", {});
        const client = await colyseus.connectTo(room);

        assert.ok(room.state.actors.get(client.sessionId));

        await client.leave(true); // saída consentida: sem espera de reconexão
        await waitTicks(2);

        assert.strictEqual(room.state.actors.has(client.sessionId), false);
        assert.strictEqual(room.state.actors.size, TEAM_SIZE * 2);
    });
});
