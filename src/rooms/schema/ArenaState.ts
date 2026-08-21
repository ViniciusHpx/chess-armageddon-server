import { Schema, MapSchema, type } from "@colyseus/schema";

/**
 * Recorte do `Actor` que vai para a rede.
 *
 * Tudo aqui é lido pelo cliente só para DESENHAR. Nada de velocidade, alvos ou
 * temporizadores internos: o cliente não simula nada, então não precisa deles —
 * e o que não trafega não gasta banda a 20 patches/s.
 */
export class ActorState extends Schema {
    @type("string") name: string = "";

    /** 0 = ally, 1 = enemy. Define o tint e de que lado o jogador está. */
    @type("uint8") team: number = 0;

    @type("boolean") bot: boolean = false;

    /** Índice em `RANK_ORDER` — escolhe textura, tamanho e forma do golpe. */
    @type("uint8") rank: number = 0;

    @type("float32") x: number = 0;
    @type("float32") y: number = 0;
    @type("boolean") flipX: boolean = false;

    @type("uint16") hp: number = 0;
    @type("uint16") maxHp: number = 0;
    @type("uint16") aura: number = 0;

    /** Placar da sessão, exibido no painel do TAB. */
    @type("uint16") kills: number = 0;
    @type("uint16") deaths: number = 0;

    @type("boolean") alive: boolean = true;
    @type("boolean") invuln: boolean = false;

    /** Golpe em curso: o cliente desenha a forma enquanto isto for true. */
    @type("boolean") attacking: boolean = false;
    @type("boolean") charged: boolean = false;

    /** Lado (em Y) da perna do L do cavalo: -1 ou 1. */
    @type("int8") atkSide: number = 1;

    @type("boolean") charging: boolean = false;
    /** Progresso da carga em 0..100 (float compactado para 1 byte). */
    @type("uint8") chargeRatio: number = 0;

    /**
     * Sequência do último pacote de entrada que o servidor já aplicou a este
     * ator (0 para bots, que não recebem entrada).
     *
     * É o que permite ao dono deste ator prever sem ficar para trás: ele volta
     * a previsão para (`x`, `y`) e reaplica os deslocamentos dos pacotes com
     * sequência maior que `ack` — exatamente os que ainda estavam viajando
     * quando este patch foi gerado.
     */
    @type("uint32") ack: number = 0;
}

export class ArenaState extends Schema {
    /** Chaveado pelo id do ator: sessionId para humanos, `bot_N` para bots. */
    @type({ map: ActorState }) actors = new MapSchema<ActorState>();
}
