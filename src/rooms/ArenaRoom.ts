import { Room, Client, CloseCode, ServerError, matchMaker, updateLobby } from "colyseus";
import { ArenaState, ActorState } from "./schema/ArenaState.js";
import { Actor } from "../sim/Actor.js";
import { World } from "../sim/World.js";
import {
    RANKS, TEAM_INDEX, TEAM_SIZE, TICK_MS, RECONNECTION_SECONDS, DASH_COOLDOWN_MS, Team,
    GAME_MODES, GameMode, sanitizeGameMode, TEAM_KILL_LIMIT, ROOM_JOIN_GRACE_SECONDS,
} from "../sim/constants.js";

/**
 * Sala da arena. Não contém regra de jogo: só traduz mensagens do cliente em
 * chamadas ao `World` e copia o resultado para o schema.
 *
 * Protocolo cliente -> servidor (nomes curtos porque vão a 20 Hz):
 *   "i"  { dx, dy, s } vetor de movimento normalizado + sequência do pacote
 *   "a"  1 | 0         1 = apertou o botão de ataque, 0 = soltou
 *   "d"  -             pediu um dash (direção e cooldown quem decide é o World)
 *   "r"  -             pediu para renascer (botão RENASCER)
 *   "rm" -             aceitou a revanche (só depois do fim da partida)
 *
 * Entrada: o cliente cria a sala (`client.create("arena", { name, bots, mode })`)
 * ou entra numa existente (`client.joinById(id, { name })`), sempre a partir
 * do lobby. `bots` é saneado aqui; o time é escolhido pelo servidor.
 *
 * Servidor -> cliente:
 *   state             posições, vida, rank, aura, estado de golpe (schema)
 *   "kill"            { killer, victim } para killfeed e feedback
 */
export class ArenaRoom extends Room {
    maxClients = TEAM_SIZE * 2;

    /**
     * Sala morre quando o último jogador sai. Sem isso a simulação dos bots
     * ficaria queimando CPU numa arena vazia.
     */
    autoDispose = true;

    /**
     * Movimento chega a 20 Hz; a folga cobre ataque e reconexão. Passar disso
     * é cliente adulterado ou com defeito — o Colyseus desconecta sozinho.
     */
    maxMessagesPerSecond = 60;

    state = new ArenaState();

    /**
     * Bots com que cada time NASCE, escolhido por quem criou a sala (0..5).
     *
     * Guardado porque também é o teto de reposição: quando um humano sai, o
     * bot só volta se o time tiver menos bots que isto. Sem esse teto, uma
     * sala criada com 0 bots ganharia bots do nada na primeira saída.
     */
    private botsPerTeam = TEAM_SIZE;

    /**
     * Modo escolhido na criação. Ainda não muda regra nenhuma — é o rótulo que
     * o lobby mostra e que as regras de cada modo vão consultar depois.
     */
    private gameMode: GameMode = sanitizeGameMode(undefined);

    /**
     * Trava da revanche: fica de pé enquanto a criação da sala nova está em
     * curso. `matchMaker.createRoom` é assíncrono, então sem ela dois jogadores
     * clicando no mesmo instante criariam DUAS salas — cada `await` devolve o
     * controle antes de `state.rematchRoomId` estar escrito.
     */
    private rematchCriando = false;

    private world = new World();

    messages = {
        /** Vetor de movimento. O World normaliza, limita e ordena por `s`. */
        i: (client: Client, message: { dx: number; dy: number; s: number }) => {
            const actor = this.actorOf(client);
            if (!actor || !message) return;
            this.world.setInput(actor, Number(message.dx), Number(message.dy), Number(message.s));
        },

        /** 1 = começou a carregar, 0 = soltou. Quem cronometra é o servidor. */
        a: (client: Client, message: number) => {
            const actor = this.actorOf(client);
            if (!actor) return;
            if (message) this.world.startCharge(actor);
            else this.world.releaseAttack(actor);
        },

        /**
         * Dash. Mensagem sem corpo de propósito: direção, distância, duração e
         * cooldown saem todos do `World`, então não há nada que o cliente possa
         * inflar. Spam cai no cooldown do lado de cá (e, em rajada, no
         * `maxMessagesPerSecond` da própria sala).
         */
        d: (client: Client) => {
            const actor = this.actorOf(client);
            if (actor) this.world.requestDash(actor);
        },

        r: (client: Client) => {
            const actor = this.actorOf(client);
            if (actor) this.world.requestRespawn(actor);
        },

        /**
         * Aceitou a revanche. A sala nova é criada UMA vez; quem clicar depois
         * já encontra o id em `state.rematchRoomId` e entra na mesma partida.
         */
        rm: (client: Client) => {
            if (!this.actorOf(client)) return;
            void this.createRematch();
        },
    };

    /**
     * @param options.bots Bots por time pedidos por quem criou a sala. Vem do
     *        cliente, então é saneado aqui: qualquer coisa fora de 0..TEAM_SIZE
     *        (ou não numérica) cai no padrão.
     * @param options.mode Modo de jogo pedido. Idem: só os de `GAME_MODES`
     *        passam; o resto vira `DEFAULT_GAME_MODE`.
     */
    onCreate(options: { bots?: unknown; mode?: unknown } = {}): void {
        this.botsPerTeam = sanitizeBots(options.bots);
        // Allowlist no servidor: o cliente pede, o servidor decide. Valor
        // estranho não é erro fatal — vira o padrão, e a sala sobe igual.
        this.gameMode = sanitizeGameMode(options.mode);
        this.state.mode = GAME_MODES.indexOf(this.gameMode);

        // A condição de vitória é do modo, não da simulação: o `World` só
        // recebe o número, e nos outros modos ele fica em 0 (sem fim).
        this.world.killLimit = this.gameMode === "team_deathmatch" ? TEAM_KILL_LIMIT : 0;

        for (let i = 0; i < this.botsPerTeam; i++) {
            this.spawnBot("ally");
            this.spawnBot("enemy");
        }

        // Sala nasce vazia, e o auto-descarte padrão a mataria em 15 s
        // (`seatReservationTimeout`) — pouco para a revanche, cujo cliente
        // ainda recarrega a página inteira antes de entrar. Desligar o
        // auto-descarte segura a sala; o relógio abaixo o devolve, e aí ela só
        // morre se continuar vazia.
        this.autoDispose = false;
        this.clock.setTimeout(
            () => { this.autoDispose = true; },
            ROOM_JOIN_GRACE_SECONDS * 1000,
        );

        this.setPatchRate(TICK_MS);
        this.setSimulationInterval((deltaMs) => this.step(deltaMs), TICK_MS);
        this.publish();
    }

    onJoin(client: Client, options: { name?: string } = {}): void {
        // Partida decidida não recebe mais ninguém: quem quer jogar de novo
        // entra na sala da revanche, que é outra.
        if (this.world.winner) throw new ServerError(4002, "Partida encerrada");

        const team = this.pickTeam();

        // Sem time com vaga a sala está cheia. `onJoin` roda uma de cada vez
        // na sala, então dois pedidos pelo último slot são resolvidos em
        // sequência: o segundo já vê o slot ocupado e cai aqui.
        if (!team) throw new ServerError(4001, "Sala cheia");

        // Slot vazio primeiro; só se o time estiver completo é que um bot cede
        // o lugar. Quem escolhe QUAL bot sai é o servidor (o primeiro achado).
        if (this.world.countTeam(team) >= TEAM_SIZE) {
            const bot = this.world.findBot(team);
            if (!bot) throw new ServerError(4001, "Sala cheia");
            this.despawn(bot.id);
        }

        const name = sanitizeName(options.name) || `Jogador ${client.sessionId.slice(0, 4)}`;
        // Entrou gente: o auto-descarte volta a valer normalmente (a sala morre
        // quando o último sair). Ver a janela de carência no `onCreate`.
        this.autoDispose = true;

        const actor = this.world.addPlayer(client.sessionId, team, name);
        this.state.actors.set(actor.id, new ActorState());
        this.writeActor(actor);
        this.publish();

        console.log(`${name} (${client.sessionId}) entrou no time ${team}`);
    }

    async onLeave(client: Client, code: CloseCode): Promise<void> {
        const actor = this.actorOf(client);
        if (!actor) return;

        // Congela em vez de sumir: numa queda de rede o personagem some do
        // combate mas a vaga fica guardada.
        actor.frozen = true;
        actor.inputDx = 0;
        actor.inputDy = 0;

        if (code === CloseCode.CONSENTED) {
            this.dropPlayer(actor);
            return;
        }

        try {
            await this.allowReconnection(client, RECONNECTION_SECONDS);
            actor.frozen = false;
            console.log(`${actor.name} reconectou`);
        } catch {
            this.dropPlayer(actor);
        }
    }

    onDispose(): void {
        console.log("sala", this.roomId, "encerrada");
    }

    // -----------------------------------------------------------------------
    // INTERNO
    // -----------------------------------------------------------------------

    private step(deltaMs: number): void {
        this.world.tick(deltaMs);

        for (const actor of this.world.actors.values()) {
            this.writeActor(actor);
        }

        this.writeMatch();

        for (const kill of this.world.kills) {
            this.broadcast("kill", {
                killer: this.world.actors.get(kill.killerId)?.name ?? "?",
                victim: this.world.actors.get(kill.victimId)?.name ?? "?",
            });
        }
        this.world.kills.length = 0;
    }

    /**
     * Copia o placar e o resultado da partida para o schema.
     *
     * Só escreve o que mudou: o schema é diffado a cada patch, e reatribuir o
     * mesmo valor 20 vezes por segundo não custa banda, mas custa comparação.
     */
    private writeMatch(): void {
        const { ally, enemy } = this.world.teamKills;
        if (this.state.scoreAlly !== ally) this.state.scoreAlly = ally;
        if (this.state.scoreEnemy !== enemy) this.state.scoreEnemy = enemy;

        const winner = this.world.winner ? TEAM_INDEX[this.world.winner] : -1;
        if (this.state.winner === winner) return;

        this.state.winner = winner;
        // Sala decidida sai da listagem e para de aceitar entrada (ver onJoin).
        this.publish();
    }

    /**
     * Cria a sala da revanche, no máximo uma vez por partida.
     *
     * A sala nova nasce com os mesmos bots e o mesmo modo. Quem aceitou entra
     * nela na hora; quem aceitar depois lê o mesmo id do estado — não existe
     * caminho para duas revanches da mesma partida.
     *
     * A sala nasce vazia e o Colyseus a descarta se ninguém entrar (a mesma
     * regra de qualquer sala recém-criada), então uma revanche que ninguém
     * jogar não fica ocupando processo.
     */
    private async createRematch(): Promise<void> {
        if (!this.world.winner) return;
        if (this.state.rematchRoomId || this.rematchCriando) return;

        this.rematchCriando = true;
        try {
            const sala = await matchMaker.createRoom(this.roomName, {
                bots: this.botsPerTeam,
                mode: this.gameMode,
            });
            this.state.rematchRoomId = sala.roomId;
            console.log("revanche da sala", this.roomId, "->", sala.roomId);
        } catch (erro) {
            console.error("falha ao criar a revanche", erro);
        } finally {
            this.rematchCriando = false;
        }
    }

    /** Copia o ator da simulação para o schema. */
    private writeActor(actor: Actor): void {
        const s = this.state.actors.get(actor.id);
        if (!s) return;

        s.name = actor.name;
        s.team = TEAM_INDEX[actor.team];
        s.bot = actor.isBot;
        s.rank = RANKS[actor.rankKey].index;
        s.x = actor.x;
        s.y = actor.y;
        s.flipX = actor.flipX;
        s.hp = Math.max(0, Math.round(actor.currentHealth));
        s.maxHp = actor.maxHealth;
        s.aura = Math.min(65535, actor.aura);
        s.xp = Math.min(65535, actor.xp);
        // Satura em vez de estourar o uint16: uma sala de horas não vira 0.
        s.kills = Math.min(65535, actor.kills);
        s.deaths = Math.min(65535, actor.deaths);
        s.alive = actor.alive;
        s.invuln = actor.isInvulnerable(this.world.now);
        s.attacking = actor.attacking;
        s.atkPower = Math.round(actor.chargePower * 100);
        s.atkSide = actor.atkSide;
        s.dashing = actor.isDashing(this.world.now);
        // Bots não têm botão para desenhar: economiza um byte por patch por bot.
        s.dashCd = actor.isBot
            ? 0
            : Math.round(actor.dashCooldownRatio(this.world.now, DASH_COOLDOWN_MS) * 100);
        s.charging = actor.charging;
        s.chargeRatio = Math.round(actor.chargeRatio * 100);

        // Depois de x/y: este patch representa o mundo com as entradas até
        // `inputSeq` já aplicadas. É esse par (posição, ack) que o cliente usa
        // como base da reconciliação.
        s.ack = actor.inputSeq;
    }

    private actorOf(client: Client): Actor | undefined {
        return this.world.actors.get(client.sessionId);
    }

    /**
     * Time que recebe o próximo humano, ou `undefined` se a sala está cheia.
     *
     * Só entram na disputa os times com vaga — slot livre ou um bot para ceder
     * o lugar. Entre eles vence o de menos humanos (equilíbrio), e o desempate
     * é o de menos ocupantes no total.
     */
    private pickTeam(): Team | undefined {
        const candidatos = (["ally", "enemy"] as Team[]).filter((t) => this.hasSlot(t));
        if (candidatos.length === 0) return undefined;

        return candidatos.sort((a, b) => {
            const humanos = this.world.countTeam(a, true) - this.world.countTeam(b, true);
            if (humanos !== 0) return humanos;
            return this.world.countTeam(a) - this.world.countTeam(b);
        })[0];
    }

    /** O time cabe mais um humano (slot vazio ou bot substituível)? */
    private hasSlot(team: Team): boolean {
        return this.world.countTeam(team) < TEAM_SIZE || this.world.findBot(team) !== undefined;
    }

    /**
     * Publica o estado da sala para o lobby.
     *
     * A metadata é o mínimo para a lista decidir: quantos humanos, quantos
     * bots e o teto. Nada aqui é fonte de verdade — tudo é derivado do `World`
     * na hora, então não há como divergir do jogo.
     *
     * `lock()` é o mecanismo nativo do Colyseus: sala travada some da listagem
     * e recusa entrada. Serve de "sala cheia" sem inventar um campo de status.
     */
    private publish(): void {
        const humanos = this.world.countTeam("ally", true) + this.world.countTeam("enemy", true);
        const total = this.world.countTeam("ally") + this.world.countTeam("enemy");

        this.setMetadata({
            players: humanos,
            bots: total - humanos,
            capacity: TEAM_SIZE * 2,
            // O lobby precisa mostrar o modo antes de entrar; o valor já é o
            // saneado, então nada arbitrário chega à listagem.
            mode: this.gameMode,
        });

        if (!this.world.winner && (this.hasSlot("ally") || this.hasSlot("enemy"))) this.unlock();
        else this.lock();

        updateLobby(this);
    }

    private spawnBot(team: Team): void {
        const bot = this.world.addBot(team);
        this.state.actors.set(bot.id, new ActorState());
        this.writeActor(bot);
    }

    private despawn(id: string): void {
        this.world.remove(id);
        this.state.actors.delete(id);
    }

    /**
     * Remove de vez e devolve um bot ao time — mas só até `botsPerTeam`, o
     * número escolhido na criação. Assim uma sala feita para humanos (0 bots)
     * continua sem bots, e o slot simplesmente volta a ficar vago.
     */
    private dropPlayer(actor: Actor): void {
        const team = actor.team;
        this.despawn(actor.id);

        const bots = this.world.countTeam(team) - this.world.countTeam(team, true);
        if (bots < this.botsPerTeam && this.world.countTeam(team) < TEAM_SIZE) {
            this.spawnBot(team);
        }

        this.publish();
        console.log(`${actor.name} saiu do time ${team}`);
    }
}

/**
 * Quantidade de bots por time pedida pelo cliente.
 *
 * Vem de fora, então nada é assumido: string, fração, negativo, `NaN` ou
 * ausente viram o padrão, e o teto é `TEAM_SIZE` — não existe caminho para
 * criar sala com mais bots do que cabe no time.
 */
function sanitizeBots(raw: unknown): number {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return TEAM_SIZE;
    return Math.min(TEAM_SIZE, Math.max(0, n));
}

/** Nomes vem do cliente: corta tamanho e caracteres de controle. */
function sanitizeName(raw: unknown): string {
    if (typeof raw !== "string") return "";

    let out = "";
    for (const ch of raw) {
        const code = ch.codePointAt(0) ?? 0;
        // Descarta os caracteres de controle C0 e o DEL.
        if (code >= 32 && code !== 127) out += ch;
    }
    return out.trim().slice(0, 16);
}
