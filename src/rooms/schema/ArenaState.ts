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

    /**
     * Experiência acumulada. O NÍVEL não trafega: é `rank + 1`, e mandar os
     * dois abriria espaço para eles discordarem.
     */
    @type("uint16") xp: number = 0;

    /** Placar da sessão, exibido no painel do TAB. */
    @type("uint16") kills: number = 0;
    @type("uint16") deaths: number = 0;

    @type("boolean") alive: boolean = true;
    @type("boolean") invuln: boolean = false;

    /** Golpe em curso: o cliente desenha a forma enquanto isto for true. */
    @type("boolean") attacking: boolean = false;

    /**
     * Potência do golpe em curso, 0..100.
     *
     * Era o booleano `charged`. O cliente desenha a forma do golpe com este
     * número (área proporcional), então ele precisa ser o MESMO que o servidor
     * usou para calcular o dano — daí trafegar o valor final, e não o tempo de
     * carga, que cada lado arredondaria de um jeito.
     */
    @type("uint8") atkPower: number = 0;

    /** Lado (em Y) da perna do L do cavalo: -1 ou 1. */
    @type("int8") atkSide: number = 1;

    /**
     * Dash em curso. Só serve para o cliente disparar o efeito visual dos
     * OUTROS personagens; o dono do ator dispara o dele na hora do toque.
     */
    @type("boolean") dashing: boolean = false;

    /**
     * Cooldown do dash que ainda falta, em 0..100 (0 = pronto).
     *
     * É a única fonte do indicador circular do botão: o cliente não guarda
     * cooldown próprio, então não há como um cliente adulterado se dar dash
     * infinito — o servidor recusaria e o botão continuaria em recarga.
     *
     * Fica em 0 nos bots, que não têm botão: sem isso este byte mudaria a cada
     * patch para cada bot em recarga, só para ninguém ler.
     */
    @type("uint8") dashCd: number = 0;

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

    /**
     * Modo de jogo da sala, como índice em `GAME_MODES`.
     *
     * Escrito uma única vez, na criação, e só pelo servidor — o cliente lê para
     * saber em que modo entrou. Índice (e não string) pelo mesmo motivo de
     * `rank` e `team`: é um byte e a ordem já é contrato entre os dois lados.
     */
    @type("uint8") mode: number = 0;
}
