import { Room, Client, CloseCode } from "colyseus";
import { ArenaState, ActorState } from "./schema/ArenaState.js";
import { Actor } from "../sim/Actor.js";
import { World } from "../sim/World.js";
import {
    RANKS, TEAM_INDEX, TEAM_SIZE, TICK_MS, RECONNECTION_SECONDS, DASH_COOLDOWN_MS, Team,
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
    };

    onCreate(): void {
        // Enche os dois times de bots: quem entrar primeiro já tem com quem lutar.
        for (let i = 0; i < TEAM_SIZE; i++) {
            this.spawnBot("ally");
            this.spawnBot("enemy");
        }

        this.setPatchRate(TICK_MS);
        this.setSimulationInterval((deltaMs) => this.step(deltaMs), TICK_MS);
    }

    onJoin(client: Client, options: { name?: string } = {}): void {
        const team = this.pickTeam();

        // Abre vaga tirando um bot, para o time não passar de TEAM_SIZE.
        if (this.world.countTeam(team) >= TEAM_SIZE) {
            const bot = this.world.findBot(team);
            if (bot) this.despawn(bot.id);
        }

        const name = sanitizeName(options.name) || `Jogador ${client.sessionId.slice(0, 4)}`;
        const actor = this.world.addPlayer(client.sessionId, team, name);
        this.state.actors.set(actor.id, new ActorState());
        this.writeActor(actor);

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

        for (const kill of this.world.kills) {
            this.broadcast("kill", {
                killer: this.world.actors.get(kill.killerId)?.name ?? "?",
                victim: this.world.actors.get(kill.victimId)?.name ?? "?",
            });
        }
        this.world.kills.length = 0;
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

    /** Time com menos humanos; empate vai para os aliados. */
    private pickTeam(): Team {
        const allies = this.world.countTeam("ally", true);
        const enemies = this.world.countTeam("enemy", true);
        return enemies < allies ? "enemy" : "ally";
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

    /** Remove de vez e devolve um bot para o time não ficar desfalcado. */
    private dropPlayer(actor: Actor): void {
        const team = actor.team;
        this.despawn(actor.id);
        if (this.world.countTeam(team) < TEAM_SIZE) this.spawnBot(team);
        console.log(`${actor.name} saiu do time ${team}`);
    }
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
