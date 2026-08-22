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

    // -----------------------------------------------------------------------
    // LOBBY: CRIAÇÃO, ENTRADA E LOTAÇÃO
    // -----------------------------------------------------------------------

    it("respeita a quantidade de bots pedida na criação", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", { bots: 2 });

        assert.strictEqual(room.state.actors.size, 4, "2 bots por time");

        // Os outros slots ficam vazios e são para humanos.
        const client = await colyseus.connectTo(room, { name: "A" });
        assert.strictEqual(room.state.actors.size, 5, "entrou em slot vazio, sem tirar bot");
        assert.ok(client.sessionId);
    });

    it("recusa configuração inválida de bots vinda do cliente", async () => {
        for (const bots of [99, -3, "muitos", null, 2.9, NaN]) {
            const room = await colyseus.createRoom<ArenaState>("arena", { bots } as never);
            const total = room.state.actors.size;
            assert.ok(
                total <= TEAM_SIZE * 2 && total % 2 === 0,
                `bots=${String(bots)} gerou ${total} atores`,
            );
            await room.disconnect();
        }
    });

    it("publica jogadores e bots na metadata para o lobby", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", { bots: 3 });
        assert.deepStrictEqual(
            { players: room.metadata.players, bots: room.metadata.bots },
            { players: 0, bots: 6 },
        );

        await colyseus.connectTo(room, { name: "A" });
        assert.strictEqual(room.metadata.players, 1, "a metadata acompanha quem entrou");
    });

    it("sala lotada é travada e recusa entrada", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", { bots: 0 });

        // 10 humanos: 5 por time, sem bot nenhum para ceder lugar.
        for (let i = 0; i < TEAM_SIZE * 2; i++) {
            await colyseus.connectTo(room, { name: `P${i}` });
        }

        assert.strictEqual(room.state.actors.size, TEAM_SIZE * 2);
        assert.strictEqual(room.locked, true, "sala cheia tem de sair da listagem do lobby");

        await assert.rejects(
            () => colyseus.connectTo(room, { name: "Tarde demais" }),
            "o 11º jogador não pode entrar",
        );
    });

    it("dois pedidos simultâneos pelo último slot: só um entra", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", { bots: 0 });

        // Enche até sobrar exatamente um slot.
        for (let i = 0; i < TEAM_SIZE * 2 - 1; i++) {
            await colyseus.connectTo(room, { name: `P${i}` });
        }

        const resultados = await Promise.allSettled([
            colyseus.connectTo(room, { name: "X" }),
            colyseus.connectTo(room, { name: "Y" }),
        ]);

        const entraram = resultados.filter((r) => r.status === "fulfilled").length;
        assert.strictEqual(entraram, 1, "o segundo pedido tem de ser recusado");
        assert.strictEqual(room.state.actors.size, TEAM_SIZE * 2, "o time não estoura");
        assert.strictEqual(room.locked, true);
    });

    it("distribui os jogadores entre os dois times", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", { bots: 0 });

        for (let i = 0; i < 4; i++) await colyseus.connectTo(room, { name: `P${i}` });

        let allies = 0;
        let enemies = 0;
        room.state.actors.forEach((a) => (a.team === 0 ? allies++ : enemies++));
        assert.deepStrictEqual([allies, enemies], [2, 2], "quatro humanos = dois de cada lado");
    });

    it("sala sem bots não ganha bots quando um jogador sai", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", { bots: 0 });
        const a = await colyseus.connectTo(room, { name: "A" });
        await colyseus.connectTo(room, { name: "B" });

        await a.leave(true);
        await waitTicks(2);

        assert.strictEqual(room.state.actors.size, 1, "o slot volta a ficar vago, sem inventar bot");
    });

    it("sala com bots repõe o bot quando o jogador sai", async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", { bots: TEAM_SIZE });
        const a = await colyseus.connectTo(room, { name: "A" });

        assert.strictEqual(room.state.actors.size, TEAM_SIZE * 2);

        await a.leave(true);
        await waitTicks(2);

        assert.strictEqual(room.state.actors.size, TEAM_SIZE * 2, "o bot volta ao lugar");
        let humanos = 0;
        room.state.actors.forEach((x) => { if (!x.bot) humanos++; });
        assert.strictEqual(humanos, 0);
    });
});
