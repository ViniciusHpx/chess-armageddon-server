/**
 * Personagem headless. Porte de `PlayerBase` sem nada de Phaser: só posição,
 * vida, rank, aura e a máquina de estados do ataque. Todo o visual (Graphics,
 * partículas, tweens, tint) ficou no cliente.
 *
 * Os temporizadores do original eram `scene.time.delayedCall`; aqui são
 * instantes absolutos em ms (`World.now`) comparados a cada tick, para que a
 * simulação dependa só do relógio da sala.
 */
import {
    RANKS, RankKey, RankConfig, AURA_KILL_VALUES, Team,
    WORLD_WIDTH, WORLD_HEIGHT, HIT_INVULN_MS,
} from "./constants.js";
import { clamp } from "./mathx.js";

export class Actor {
    readonly id: string;
    team: Team;
    isBot: boolean;
    name: string;

    /** sessionId do cliente que controla este ator (vazio se for bot). */
    sessionId = "";

    x = 0;
    y = 0;
    vx = 0;
    vy = 0;
    flipX = false;

    rankKey: RankKey = "PAWN";
    maxHealth = RANKS.PAWN.health;
    currentHealth = RANKS.PAWN.health;
    aura = 0;

    alive = true;
    /** Instante a partir do qual pode renascer. */
    respawnAt = 0;

    // --- ataque ---
    attacking = false;
    /** Instante em que o dano do golpe em curso será aplicado. */
    attackHitAt = 0;
    charged = false;
    /** Para qual lado (em Y) sai a perna do L do cavalo: -1 ou 1. */
    atkSide = 1;
    /** Alvos já atingidos pelo golpe atual — evita dano duplo. */
    hitThisAttack = new Set<string>();

    // --- carga ---
    charging = false;
    chargeStartedAt = 0;
    /** 0..1, só para o cliente desenhar o brilho dos outros jogadores. */
    chargeRatio = 0;

    invulnUntil = 0;

    // --- entrada (humanos) ---
    inputDx = 0;
    inputDy = 0;
    /** Instante do último pacote de entrada. Ver INPUT_TIMEOUT_MS. */
    lastInputAt = 0;
    /** Cliente desconectado esperando reconexão: congela o personagem. */
    frozen = false;

    // --- IA (bots) ---
    wanderAngle = Math.random() * Math.PI * 2;
    wanderTimer = 0;
    attackCooldown = 0;

    constructor(id: string, team: Team, isBot: boolean, name: string) {
        this.id = id;
        this.team = team;
        this.isBot = isBot;
        this.name = name;
    }

    get rank(): RankConfig {
        return RANKS[this.rankKey];
    }

    get collisionRx(): number {
        return 50 * (this.rank.size.width / 128);
    }

    get collisionRy(): number {
        return 25 * (this.rank.size.height / 128);
    }

    get mass(): number {
        return this.rank.mass || 1;
    }

    /**
     * Centro da elipse de colisão, em coordenadas de mundo.
     *
     * No cliente isso saía de `body.center`. Reproduzindo a conta de
     * `applyRankPhysics` (origem do sprite em 0.5; offsetY = (altura -
     * collisionRx) + collisionRy/3; altura do corpo = collisionRy*2):
     *
     *   centerX = x
     *   centerY = y + altura/2 - collisionRx + collisionRy * 4/3
     *
     * O cliente usa a MESMA fórmula em `ArenaActor.getEllipseCenter()`.
     */
    ellipseCenter(): { x: number; y: number } {
        return {
            x: this.x,
            y: this.y + this.rank.size.height / 2 - this.collisionRx + (this.collisionRy * 4) / 3,
        };
    }

    setRank(key: RankKey): void {
        this.rankKey = key;
    }

    promote(): void {
        const next = this.rank.next;
        if (!next) return;
        this.setRank(next);
        this.maxHealth = this.rank.health;
        this.currentHealth = this.maxHealth;
    }

    resetToPawn(): void {
        this.setRank("PAWN");
        this.maxHealth = RANKS.PAWN.health;
        this.currentHealth = this.maxHealth;
    }

    isInvulnerable(now: number): boolean {
        return now < this.invulnUntil;
    }

    /** @returns true se o golpe matou. */
    takeDamage(amount: number, now: number): boolean {
        if (!this.alive || this.isInvulnerable(now)) return false;

        this.currentHealth -= amount;
        if (this.currentHealth <= 0) {
            this.currentHealth = 0;
            return true;
        }

        this.invulnUntil = now + HIT_INVULN_MS;
        return false;
    }

    addAuraFromKill(victim: Actor): void {
        this.aura += AURA_KILL_VALUES[victim.rank.key] ?? 10;
    }

    /** Cancela ataque e carga em curso. */
    cancelAttack(): void {
        this.attacking = false;
        this.attackHitAt = 0;
        this.charged = false;
        this.charging = false;
        this.chargeRatio = 0;
        this.hitThisAttack.clear();
    }

    /** Mantém o sprite inteiro dentro do mapa (era `clampToWorldBounds`). */
    clampToWorld(): void {
        const halfW = this.rank.size.width / 2;
        const halfH = this.rank.size.height / 2;
        this.x = clamp(this.x, halfW, WORLD_WIDTH - halfW);
        this.y = clamp(this.y, halfH, WORLD_HEIGHT - halfH);
    }
}
