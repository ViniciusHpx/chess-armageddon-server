import assert from "assert";

import { World } from "../src/sim/World.js";
import { Actor } from "../src/sim/Actor.js";
import {
    RANKS, TICK_MS, DAMAGE_NORMAL, DAMAGE_CHARGED, HIT_INVULN_MS, BOT_RESPAWN_DELAY_MS, INPUT_TIMEOUT_MS,
    BOT_ATTACK_COOLDOWN_MS, RESPAWN_INVULN_MS, attackHalfBand, attackReach,
} from "../src/sim/constants.js";

/** Avança a simulação em passos de um tick. */
function advance(world: World, ms: number): void {
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) world.tick(TICK_MS);
}

/**
 * Coloca dois personagens lado a lado, encostados o suficiente para o golpe do
 * peão alcançar (retângulo de 80 px a partir da borda da elipse) mas longe o
 * bastante para o CollisionResolver não os empurrar: as elipses só se separam
 * abaixo de collisionRx * 2 = 100 px.
 */
function placeSideBySide(attacker: Actor, target: Actor): void {
    attacker.x = 1000;
    attacker.y = 900;
    attacker.flipX = false; // virado para a direita
    target.x = 1110;
    target.y = 900;
}

/** Um golpe simples: carrega e solta no mesmo instante. */
function swing(world: World, actor: Actor): void {
    world.startCharge(actor);
    world.releaseAttack(actor);
}

describe("World (simulação)", () => {
    it("o golpe do peão acerta o inimigo ao lado", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");
        placeSideBySide(attacker, target);

        swing(world, attacker);
        advance(world, 300);

        assert.strictEqual(target.currentHealth, RANKS.PAWN.health - DAMAGE_NORMAL);
        assert.strictEqual(attacker.attacking, false, "o golpe deveria ter terminado");
    });

    it("o golpe carregado tira o dobro", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");
        placeSideBySide(attacker, target);

        world.startCharge(attacker);
        advance(world, RANKS.PAWN.chargeTime + TICK_MS);
        placeSideBySide(attacker, target); // a carga não move ninguém, mas garante a pose
        world.releaseAttack(attacker);
        advance(world, 300);

        assert.strictEqual(target.currentHealth, RANKS.PAWN.health - DAMAGE_CHARGED);
    });

    it("não há fogo amigo", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const friend = world.addPlayer("b", "ally", "B");
        placeSideBySide(attacker, friend);

        swing(world, attacker);
        advance(world, 300);

        assert.strictEqual(friend.currentHealth, RANKS.PAWN.health);
    });

    it("a invulnerabilidade segura o segundo golpe seguido", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");
        placeSideBySide(attacker, target);

        swing(world, attacker);
        advance(world, 300);
        const afterFirst = target.currentHealth;

        placeSideBySide(attacker, target);
        swing(world, attacker);
        advance(world, 300);

        assert.strictEqual(
            target.currentHealth, afterFirst,
            `dentro dos ${HIT_INVULN_MS} ms de invulnerabilidade o alvo não pode perder vida`,
        );
    });

    it("matar promove o atacante e dá aura", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");

        // 100 de vida / 25 por golpe = 4 golpes, esperando a invulnerabilidade.
        for (let i = 0; i < 4; i++) {
            placeSideBySide(attacker, target);
            swing(world, attacker);
            advance(world, 300);
            advance(world, HIT_INVULN_MS + TICK_MS);
        }

        assert.strictEqual(target.alive, false, "o alvo deveria ter morrido");
        assert.strictEqual(attacker.rankKey, "TOWER", "matar promove peão para torre");
        assert.strictEqual(attacker.currentHealth, RANKS.TOWER.health);
        assert.strictEqual(attacker.aura, 10, "abater um peão dá 10 de aura");
    });

    it("humano morto só renasce depois da carência, e como peão", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");
        target.aura = 99;

        for (let i = 0; i < 4; i++) {
            placeSideBySide(attacker, target);
            swing(world, attacker);
            advance(world, 300);
            advance(world, HIT_INVULN_MS + TICK_MS);
        }
        assert.strictEqual(target.alive, false);

        // Antes da carência o pedido é ignorado...
        target.respawnAt = world.now + 1000;
        world.requestRespawn(target);
        assert.strictEqual(target.alive, false, "renascer antes da carência não pode valer");

        advance(world, 1100);
        world.requestRespawn(target);

        assert.strictEqual(target.alive, true);
        assert.strictEqual(target.rankKey, "PAWN");
        assert.strictEqual(target.currentHealth, RANKS.PAWN.health);
        assert.strictEqual(target.aura, 0, "a aura zera na morte");
    });

    it("o bot renasce sozinho", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const bot = world.addBot("enemy");

        for (let i = 0; i < 4; i++) {
            placeSideBySide(attacker, bot);
            swing(world, attacker);
            advance(world, 300);
            advance(world, HIT_INVULN_MS + TICK_MS);
        }

        advance(world, BOT_RESPAWN_DELAY_MS + 200);

        assert.strictEqual(bot.alive, true, "o bot deveria ter renascido sozinho");
        assert.strictEqual(bot.rankKey, "PAWN");
    });

    it("personagens não ficam sobrepostos", () => {
        const world = new World();
        const a = world.addPlayer("a", "ally", "A");
        const b = world.addPlayer("b", "enemy", "B");

        a.x = 1000; a.y = 900;
        b.x = 1005; b.y = 902;

        advance(world, 500);

        // No espaço circular (Y multiplicado por 2) a distância entre os
        // centros tem de chegar perto de collisionRx * 2.
        const ca = a.ellipseCenter();
        const cb = b.ellipseCenter();
        const dist = Math.hypot(cb.x - ca.x, (cb.y - ca.y) * 2);

        assert.ok(
            dist > a.collisionRx + b.collisionRx - 1,
            `esperava separação de ~${a.collisionRx + b.collisionRx}, deu ${dist.toFixed(1)}`,
        );
    });

    it("para de andar se o cliente emudecer", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        actor.x = 1000;
        actor.y = 900;

        world.setInput(actor, 1, 0, 1);
        advance(world, 500);
        const andouCedo = actor.x - 1000;
        assert.ok(andouCedo > 0, "deveria estar andando enquanto a entrada é recente");

        // Nenhum pacote novo: passado INPUT_TIMEOUT_MS o servidor solta o comando.
        advance(world, INPUT_TIMEOUT_MS + 200);
        const parouEm = actor.x;
        advance(world, 1000);

        assert.strictEqual(
            Math.round(actor.x), Math.round(parouEm),
            "sem entrada nova o personagem não pode continuar andando",
        );
    });

    it("o placar conta o abate para quem matou e a morte para quem morreu", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");
        const bystander = world.addPlayer("c", "enemy", "C");

        for (let i = 0; i < 4; i++) {
            placeSideBySide(attacker, target);
            swing(world, attacker);
            advance(world, 300);
            advance(world, HIT_INVULN_MS + TICK_MS);
        }

        assert.strictEqual(attacker.kills, 1);
        assert.strictEqual(attacker.deaths, 0);
        assert.strictEqual(target.kills, 0);
        assert.strictEqual(target.deaths, 1);
        assert.strictEqual(bystander.deaths, 0, "quem não estava na briga não pontua");
    });

    it("o placar sobrevive ao renascimento", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        actor.kills = 3;
        actor.deaths = 2;

        world.requestRespawn(actor);
        advance(world, 2000);

        assert.strictEqual(actor.kills, 3, "renascer não zera o placar (a aura sim)");
        assert.strictEqual(actor.deaths, 2);
    });

    it("o bot ataca quando o inimigo entra no alcance do seu rank", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const target = world.addPlayer("b", "enemy", "B");
        placeSideBySide(bot, target);

        // Bem além do alcance: não deve sair golpe nenhum.
        target.x = bot.x + 900;
        advance(world, 3000);
        assert.strictEqual(bot.attacking, false, "não ataca alvo fora de alcance");
        assert.strictEqual(target.currentHealth, RANKS.PAWN.health);

        // Ao alcance: em poucos segundos tem de ter acertado.
        placeSideBySide(bot, target);
        target.invulnUntil = 0;
        for (let i = 0; i < 60 && target.currentHealth === RANKS.PAWN.health; i++) {
            placeSideBySide(bot, target); // o bot anda; a pose é reposta a cada passo
            world.tick(TICK_MS);
        }

        assert.ok(
            target.currentHealth < RANKS.PAWN.health,
            "o bot deveria ter acertado em até 3 s com o alvo colado",
        );
    });

    it("o bot não desperdiça golpe em alvo invulnerável", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const target = world.addPlayer("b", "enemy", "B");

        target.invulnUntil = world.now + RESPAWN_INVULN_MS * 4;
        for (let i = 0; i < 40; i++) {
            placeSideBySide(bot, target);
            world.tick(TICK_MS);
            if (bot.attacking) break;
        }

        assert.strictEqual(bot.attacking, false, "invulnerável não vale o cooldown");
        assert.ok(bot.attackCooldown <= BOT_ATTACK_COOLDOWN_MS);
    });

    it("o alcance e a faixa do golpe seguem a forma de cada rank", () => {
        // Retos: alcance para frente e faixa limitada em Y.
        assert.strictEqual(attackReach(RANKS.PAWN), RANKS.PAWN.attack.length);
        assert.strictEqual(attackHalfBand(RANKS.PAWN), RANKS.PAWN.attack.width / 2);

        // Radiais: pegam em volta, então não há restrição de faixa.
        assert.strictEqual(attackReach(RANKS.QUEEN), RANKS.QUEEN.attack.radius);
        assert.strictEqual(attackHalfBand(RANKS.QUEEN), Infinity);

        assert.ok(
            attackReach(RANKS.QUEEN) > attackReach(RANKS.PAWN),
            "a rainha alcança mais longe que o peão — era isso que os 100 px fixos ignoravam",
        );
    });

    it("o personagem não sai do mapa", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        actor.x = 300;
        actor.y = 300;

        world.setInput(actor, -1, -1, 1);
        advance(world, 5000);

        const half = RANKS.PAWN.size.width / 2;
        assert.ok(actor.x >= half - 0.01, `x=${actor.x} passou da borda esquerda`);
        assert.ok(actor.y >= half - 0.01, `y=${actor.y} passou da borda de cima`);
    });
});
