import assert from "assert";

import { World } from "../src/sim/World.js";
import { Actor } from "../src/sim/Actor.js";
import {
    RANKS, TICK_MS, DAMAGE_NORMAL, DAMAGE_CHARGED, HIT_INVULN_MS, BOT_RESPAWN_DELAY_MS, INPUT_TIMEOUT_MS,
    BOT_ATTACK_COOLDOWN_MS, RESPAWN_INVULN_MS, attackHalfBand, attackReach,
    KNOCKBACK_DECAY_MS, knockbackSpeed, BOT_CHARGE_HOLD_MS,
    ATTACK_WINDUP_MAX_MS, ATTACK_RECOVERY_MAX_MS, chargeDamage, chargeAreaMult,
    XP_PER_KILL, XP_PER_LEVEL, MAX_LEVEL, levelFromXp, xpProgress,
    DAMAGE_LIGHT, DAMAGE_MAX, AREA_MULT_LIGHT, AREA_MULT_MAX, KNOCKBACK_CHARGED_FACTOR,
    attackWindupMs, attackRecoveryMs, chargePower,
} from "../src/sim/constants.js";

/**
 * Roda `fn` com o sorteio do bot sempre passando.
 *
 * `stepBot` sorteia se ataca neste tick; sem fixar isso, os testes de decisão
 * do bot ficariam intermitentes.
 */
function comSorteioCerto<T>(fn: () => T): T {
    const original = Math.random;
    Math.random = () => 0;
    try {
        return fn();
    } finally {
        Math.random = original;
    }
}

/** Distância em X entre os centros das elipses de duas peças. */
function afasta(bot: Actor, target: Actor, distancia: number): void {
    bot.x = 1200;
    bot.y = 900;
    target.x = bot.x + distancia;
    target.y = 900;
    target.invulnUntil = 0;
}

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

    it("matar dá XP e aura, e o rank sobe só quando a XP dá o nível", () => {
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
        assert.strictEqual(attacker.xp, XP_PER_KILL, "um abate paga XP_PER_KILL uma única vez");
        assert.strictEqual(attacker.rankKey, "PAWN", "30 XP ainda é nível 1");
        assert.strictEqual(attacker.aura, 10, "abater um peão dá 10 de aura");
    });

    it("humano morto só renasce depois da carência, mantendo a peça", () => {
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
            // O teste é sobre o respawn, não sobre um duelo: sem calar o bot,
            // quem mata quem depende do sorteio de ataque dele e o resultado
            // fica intermitente.
            bot.attackCooldown = 5000;
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
        // `AttackConfig` é uma união discriminada: sem estreitar pelo `type`,
        // o TypeScript não deixa ler `length`/`radius`.
        const peao = RANKS.PAWN.attack;
        const rainha = RANKS.QUEEN.attack;
        if (peao.type !== "rectangle") throw new Error("o peão deixou de ser retangular");
        if (rainha.type !== "circle") throw new Error("a rainha deixou de ser circular");

        // Retos: alcance para frente e faixa limitada em Y.
        assert.strictEqual(attackReach(RANKS.PAWN), peao.length);
        assert.strictEqual(attackHalfBand(RANKS.PAWN), peao.width / 2);

        // Radiais: pegam em volta, então não há restrição de faixa.
        assert.strictEqual(attackReach(RANKS.QUEEN), rainha.radius);
        assert.strictEqual(attackHalfBand(RANKS.QUEEN), Infinity);

        assert.ok(
            attackReach(RANKS.QUEEN) > attackReach(RANKS.PAWN),
            "a rainha alcança mais longe que o peão — era isso que os 100 px fixos ignoravam",
        );
    });

    it("o golpe empurra o alvo para longe do atacante", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");
        placeSideBySide(attacker, target);

        const antes = target.x;
        swing(world, attacker);
        advance(world, ATTACK_WINDUP_MAX_MS + KNOCKBACK_DECAY_MS * 4);

        assert.ok(
            target.x > antes + 20,
            `o alvo à direita deveria ter sido empurrado para a direita (foi de ${antes} para ${target.x})`,
        );
        assert.ok(
            Math.abs(target.y - attacker.y) < 5,
            "alvo alinhado em Y não deveria ganhar empurrão vertical",
        );
    });

    it("o golpe carregado empurra mais que o normal, mas não o dobro", () => {
        const medir = (carregado: boolean): number => {
            const world = new World();
            const attacker = world.addPlayer("a", "ally", "A");
            const target = world.addPlayer("b", "enemy", "B");
            placeSideBySide(attacker, target);
            const antes = target.x;

            world.startCharge(attacker);
            if (carregado) advance(world, RANKS.PAWN.chargeTime + TICK_MS);
            placeSideBySide(attacker, target);
            world.releaseAttack(attacker);
            advance(world, ATTACK_WINDUP_MAX_MS + KNOCKBACK_DECAY_MS * 6);

            return target.x - antes;
        };

        const normal = medir(false);
        const carregado = medir(true);

        assert.ok(carregado > normal, "carregado tem de empurrar mais");
        assert.ok(
            carregado < normal * 2,
            `o empurrão do carregado (${carregado}) não pode dobrar o do normal (${normal}) — ` +
            "seria arremessar o alvo para fora da briga",
        );
    });

    it("peça pesada é empurrada menos que peça leve", () => {
        // A raiz da massa é o que impede a torre de virar uma parede imóvel.
        const peao = knockbackSpeed(0, RANKS.PAWN.mass);
        const torre = knockbackSpeed(0, RANKS.TOWER.mass);

        assert.ok(torre < peao, "a torre (massa 4) tem de resistir mais que o peão");
        assert.ok(
            torre > peao / RANKS.TOWER.mass,
            "mas não pode ser proporcional à massa crua: aí ela mal sairia do lugar",
        );
    });

    it("um golpe em três inimigos espalha cada um na sua direção", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        attacker.rankKey = "QUEEN"; // golpe circular, pega em volta
        attacker.x = 1500;
        attacker.y = 900;

        // Um acima, um na linha e um abaixo, todos ao alcance do círculo.
        const alvos = ["b", "c", "d"].map((id, i) => {
            const t = world.addPlayer(id, "enemy", id.toUpperCase());
            t.x = 1580;
            t.y = 830 + i * 70;
            return t;
        });
        const antes = alvos.map((t) => ({ x: t.x, y: t.y }));

        swing(world, attacker);
        advance(world, ATTACK_WINDUP_MAX_MS + KNOCKBACK_DECAY_MS * 4);

        alvos.forEach((t, i) => {
            assert.ok(t.x > antes[i].x, `alvo ${i} deveria ter sido empurrado para longe em X`);
        });

        // O de cima sobe, o de baixo desce: leque, não bloco.
        assert.ok(alvos[0].y < antes[0].y, "o alvo de cima deveria subir");
        assert.ok(alvos[2].y > antes[2].y, "o alvo de baixo deveria descer");
    });

    it("alvo invulnerável não leva dano nem empurrão", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");
        placeSideBySide(attacker, target);

        target.invulnUntil = world.now + 10_000;
        const antesX = target.x;
        const antesHp = target.currentHealth;

        swing(world, attacker);
        advance(world, ATTACK_WINDUP_MAX_MS + KNOCKBACK_DECAY_MS * 4);

        assert.strictEqual(target.currentHealth, antesHp, "invulnerável não perde vida");
        assert.strictEqual(
            Math.round(target.x), Math.round(antesX),
            "e também não pode ser arrastado: golpe que não conecta não empurra",
        );
    });

    it("o empurrão morre sozinho e não deixa o alvo à deriva", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");
        placeSideBySide(attacker, target);

        swing(world, attacker);
        advance(world, ATTACK_WINDUP_MAX_MS + KNOCKBACK_DECAY_MS * 10);

        assert.strictEqual(target.knockbackVx, 0);
        assert.strictEqual(target.knockbackVy, 0);

        const parouEm = target.x;
        advance(world, 1000);
        assert.strictEqual(target.x, parouEm, "sem empurrão ativo o alvo não pode continuar deslizando");
    });

    it("o bot bate normal quando o alvo está inteiro e ao alcance", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const target = world.addPlayer("b", "enemy", "B");
        afasta(bot, target, 110);

        comSorteioCerto(() => world.tick(TICK_MS));

        assert.strictEqual(bot.charging, false, "alvo inteiro e colado não justifica carregar");
        assert.strictEqual(bot.attacking, true);
        assert.strictEqual(bot.chargePower, 0);
    });

    it("o bot carrega para finalizar quando o normal não mataria", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const target = world.addPlayer("b", "enemy", "B");
        afasta(bot, target, 110);

        // Janela em que só o carregado mata: acima do dano normal, até o dobro.
        target.currentHealth = DAMAGE_NORMAL + 10;

        comSorteioCerto(() => world.tick(TICK_MS));

        assert.strictEqual(bot.charging, true, "deveria carregar para fechar o abate");
        assert.strictEqual(bot.attacking, false);
    });

    it("o bot carrega quando o alvo só está no alcance dobrado", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const target = world.addPlayer("b", "enemy", "B");

        // Entre o alcance normal (~200) e o carregado (~280) do peão.
        afasta(bot, target, 240);

        comSorteioCerto(() => world.tick(TICK_MS));

        assert.strictEqual(bot.charging, true, "fora do alcance normal, carregar é de graça");
    });

    it("a carga do bot sai com o dano dobrado", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const target = world.addPlayer("b", "enemy", "B");
        target.rankKey = "TOWER"; // vida 200: sobrevive ao carregado e dá para medir
        target.maxHealth = RANKS.TOWER.health;
        target.currentHealth = RANKS.TOWER.health;

        comSorteioCerto(() => {
            afasta(bot, target, 240); // fora do alcance normal: vira carga
            world.tick(TICK_MS);
            assert.strictEqual(bot.charging, true);

            // Segura a pose enquanto a carga corre e o golpe conecta.
            const passos = (RANKS.PAWN.chargeTime + ATTACK_WINDUP_MAX_MS * 2 + ATTACK_RECOVERY_MAX_MS) / TICK_MS;
            for (let i = 0; i < passos; i++) {
                afasta(bot, target, 110); // alvo entrou no alcance
                target.invulnUntil = 0;
                world.tick(TICK_MS);
            }
        });

        assert.strictEqual(
            RANKS.TOWER.health - target.currentHealth, DAMAGE_CHARGED,
            "o golpe do bot deveria ter saído carregado",
        );
    });

    it("o bot desiste da carga se o alvo some", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const target = world.addPlayer("b", "enemy", "B");
        afasta(bot, target, 240);

        comSorteioCerto(() => world.tick(TICK_MS));
        assert.strictEqual(bot.charging, true);

        world.remove(target.id);
        world.tick(TICK_MS);

        assert.strictEqual(bot.charging, false, "sem alvo não há o que finalizar");
        assert.strictEqual(bot.attacking, false, "e não gasta golpe no vazio");
    });

    it("o bot não fica preso segurando a carga se o alvo foge", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const target = world.addPlayer("b", "enemy", "B");

        comSorteioCerto(() => {
            afasta(bot, target, 240);
            world.tick(TICK_MS);
            assert.strictEqual(bot.charging, true);

            // Alvo some no horizonte durante toda a carga e a espera.
            const passos = (RANKS.PAWN.chargeTime + BOT_CHARGE_HOLD_MS + TICK_MS * 4) / TICK_MS;
            for (let i = 0; i < passos; i++) {
                bot.x = 1200;
                bot.y = 900;
                target.x = 3000;
                target.y = 900;
                world.tick(TICK_MS);
            }
        });

        assert.strictEqual(bot.charging, false, "tem de soltar em vez de segurar para sempre");
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

    // -----------------------------------------------------------------------
    // ESCALA DA CARGA
    // -----------------------------------------------------------------------

    it("dano, área e empurrão crescem com a carga e param no teto", () => {
        const meio = 0.5;

        assert.strictEqual(chargeDamage(0), DAMAGE_LIGHT, "toque = golpe leve");
        assert.strictEqual(chargeDamage(1), DAMAGE_MAX, "carga cheia = teto");
        assert.ok(
            chargeDamage(meio) > chargeDamage(0) && chargeDamage(meio) < chargeDamage(1),
            "meia carga tem de ficar no meio da escala",
        );

        assert.strictEqual(chargeAreaMult(0), AREA_MULT_LIGHT);
        assert.strictEqual(chargeAreaMult(1), AREA_MULT_MAX);

        const kbLeve = knockbackSpeed(0, RANKS.PAWN.mass);
        const kbCheio = knockbackSpeed(1, RANKS.PAWN.mass);
        assert.ok(kbCheio > kbLeve, "carga cheia empurra mais");
        assert.ok(
            Math.abs(kbCheio - kbLeve * KNOCKBACK_CHARGED_FACTOR) < 1e-6,
            "o empurrão máximo é exatamente o fator documentado",
        );
    });

    it("segurar além do tempo do rank não aumenta nada", () => {
        // O teto vive no clamp de `chargePower`: qualquer excesso vira 1.
        assert.strictEqual(chargePower(RANKS.PAWN.chargeTime * 10, RANKS.PAWN.chargeTime), 1);

        for (const excesso of [1.5, 4, 100]) {
            assert.strictEqual(chargeDamage(excesso), DAMAGE_MAX, "dano não passa do teto");
            assert.strictEqual(chargeAreaMult(excesso), AREA_MULT_MAX, "área não passa do teto");
            assert.strictEqual(
                knockbackSpeed(excesso, RANKS.PAWN.mass),
                knockbackSpeed(1, RANKS.PAWN.mass),
                "empurrão não passa do teto",
            );
        }
    });

    it("o dano do golpe sai da carga medida pelo servidor", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");
        placeSideBySide(attacker, target);

        // Segura metade do tempo do rank e solta.
        world.startCharge(attacker);
        advance(world, RANKS.PAWN.chargeTime / 2);
        placeSideBySide(attacker, target);
        world.releaseAttack(attacker);

        const esperado = chargeDamage(attacker.chargePower);
        assert.ok(
            attacker.chargePower > 0.4 && attacker.chargePower < 0.6,
            `meia carga deveria dar potência perto de 0,5 (deu ${attacker.chargePower})`,
        );

        const vidaAntes = target.currentHealth;
        advance(world, ATTACK_WINDUP_MAX_MS + TICK_MS);

        const tirou = vidaAntes - target.currentHealth;
        assert.ok(
            Math.abs(tirou - esperado) < 0.01,
            `o golpe deveria tirar ${esperado.toFixed(1)} (tirou ${tirou})`,
        );
        assert.ok(tirou > DAMAGE_LIGHT && tirou < DAMAGE_MAX, "meia carga fica entre os extremos");
    });

    it("o cliente não consegue inflar a carga mandando 'soltei' várias vezes", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");
        placeSideBySide(attacker, target);

        world.startCharge(attacker);
        advance(world, TICK_MS);            // carga curtíssima
        placeSideBySide(attacker, target);

        // Rajada de "soltei": só a primeira vale, as outras não estão carregando.
        for (let i = 0; i < 20; i++) world.releaseAttack(attacker);

        assert.ok(attacker.chargePower < 0.2, "a potência é a do tempo real segurado");

        const vidaAntes = target.currentHealth;
        advance(world, ATTACK_WINDUP_MAX_MS + TICK_MS);
        const tirou = vidaAntes - target.currentHealth;

        assert.ok(
            tirou <= DAMAGE_MAX,
            `nenhuma rajada pode passar do teto de dano (tirou ${tirou})`,
        );
        assert.ok(tirou < DAMAGE_LIGHT * 1.2, "e nem somar vários golpes num só");
    });

    it("a recuperação impede encadear golpes", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");
        placeSideBySide(attacker, target);

        // Golpe leve: acerta em `attackWindupMs(0)` e libera em
        // + `attackRecoveryMs(0)`. Um tick depois do impacto ainda está preso.
        swing(world, attacker);
        const primeiro = attacker.attackHitAt;
        // Para no tick 200 ms: o golpe leve já bateu (windup 160) e a
        // recuperação ainda corre (libera em 220).
        advance(world, 180);
        assert.strictEqual(attacker.attacking, false, "o golpe leve já deveria ter saído");

        world.startCharge(attacker);
        assert.strictEqual(attacker.charging, false, "carga cedo demais tem de ser recusada");

        advance(world, attackRecoveryMs(0) + TICK_MS * 2);
        world.startCharge(attacker);
        assert.strictEqual(attacker.charging, true, "passada a recuperação, pode carregar de novo");
        assert.ok(primeiro > 0);
    });

    it("golpe mais carregado demora mais para sair", () => {
        assert.ok(
            attackWindupMs(1) > attackWindupMs(0),
            "o windup do carregado é a janela em que dá para esquivar dele",
        );
        assert.ok(
            attackRecoveryMs(1) > attackRecoveryMs(0),
            "e a recuperação maior é o preço de ter carregado",
        );
    });

    // -----------------------------------------------------------------------
    // EXPERIÊNCIA E NÍVEL
    // -----------------------------------------------------------------------

    it("a XP acumula e nunca é gasta ao subir de nível", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");

        assert.strictEqual(actor.xp, 0, "começa zerado");
        assert.strictEqual(actor.level, 1);
        assert.strictEqual(actor.rankKey, "PAWN");

        // 3 abates: 90 XP, ainda nível 1.
        for (let i = 0; i < 3; i++) actor.addExperience(XP_PER_KILL);
        assert.strictEqual(actor.xp, 90);
        assert.strictEqual(actor.level, 1);

        // O quarto leva a 120: sobe de nível SEM zerar a XP.
        const subiu = actor.addExperience(XP_PER_KILL);
        assert.strictEqual(subiu, true);
        assert.strictEqual(actor.xp, 120, "a XP continua acumulada, não volta para 0");
        assert.strictEqual(actor.level, 2);
        assert.strictEqual(actor.rankKey, "TOWER");
        assert.strictEqual(actor.currentHealth, RANKS.TOWER.health, "o nível novo cura");

        // 190 + 30 = 220 -> nível 3.
        actor.xp = 190;
        actor.addExperience(XP_PER_KILL);
        assert.strictEqual(actor.xp, 220);
        assert.strictEqual(actor.level, 3);
        assert.strictEqual(actor.rankKey, "HORSE");
    });

    it("a sequência de ranks segue a ordem antiga, e o nível máximo não estoura", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");

        const esperado = ["PAWN", "TOWER", "HORSE", "BISHOP", "QUEEN"];
        for (let nivel = 1; nivel <= MAX_LEVEL; nivel++) {
            actor.xp = (nivel - 1) * XP_PER_LEVEL;
            actor.addExperience(0.0001);
            assert.strictEqual(actor.rankKey, esperado[nivel - 1], `nível ${nivel}`);
        }

        // Muito além do teto: continua rainha, sem erro nem rank inexistente.
        actor.addExperience(XP_PER_KILL * 100);
        assert.strictEqual(actor.level, MAX_LEVEL);
        assert.strictEqual(actor.rankKey, "QUEEN");
        assert.strictEqual(levelFromXp(999999), MAX_LEVEL);
    });

    it("a barra mostra o progresso do nível, não a XP total", () => {
        assert.deepStrictEqual(xpProgress(0), { level: 1, into: 0, need: 100, max: false });
        assert.deepStrictEqual(xpProgress(120), { level: 2, into: 20, need: 100, max: false });
        assert.deepStrictEqual(xpProgress(190), { level: 2, into: 90, need: 100, max: false });
        assert.deepStrictEqual(xpProgress(200), { level: 3, into: 0, need: 100, max: false });

        const cheio = xpProgress(XP_PER_LEVEL * (MAX_LEVEL - 1) + 55);
        assert.strictEqual(cheio.level, MAX_LEVEL);
        assert.strictEqual(cheio.max, true, "no teto a barra fica cheia e não calcula próximo nível");
    });

    it("o respawn do servidor devolve o personagem com o mesmo rank", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        const algoz = world.addPlayer("b", "enemy", "B");

        actor.addExperience(XP_PER_LEVEL * 2 + 40);   // cavalo, 40 de progresso
        assert.strictEqual(actor.rankKey, "HORSE");

        // Morre de verdade, pelo caminho normal do combate.
        for (let i = 0; i < 8 && actor.alive; i++) {
            placeSideBySide(algoz, actor);
            algoz.attackReadyAt = 0;
            swing(world, algoz);
            advance(world, 300);
            advance(world, HIT_INVULN_MS + TICK_MS);
        }
        assert.strictEqual(actor.alive, false, "o alvo deveria ter morrido");

        advance(world, 1200);
        world.requestRespawn(actor);

        assert.strictEqual(actor.alive, true);
        assert.strictEqual(actor.rankKey, "HORSE", "renasce com a mesma peça");
        assert.strictEqual(actor.xp, XP_PER_LEVEL * 2, "e com a barra do nível zerada");
        assert.strictEqual(actor.currentHealth, RANKS.HORSE.health);
    });

    it("morrer mantém o rank e devolve a XP ao piso do nível", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");

        // Cavalo (nível 3) com 20 de progresso no nível.
        actor.addExperience(XP_PER_LEVEL * 2 + 20);
        assert.strictEqual(actor.rankKey, "HORSE");
        assert.strictEqual(xpProgress(actor.xp).into, 20);

        actor.resetProgressOnDeath();

        assert.strictEqual(actor.rankKey, "HORSE", "a peça continua a mesma");
        assert.strictEqual(actor.xp, XP_PER_LEVEL * 2, "a XP cai para o piso do nível");
        assert.strictEqual(xpProgress(actor.xp).into, 0, "a barra volta a zero");
        assert.strictEqual(actor.currentHealth, RANKS.HORSE.health, "renasce com vida cheia");

        // Peão perde só o progresso: 90 -> 0.
        const peao = world.addPlayer("b", "ally", "B");
        peao.addExperience(90);
        peao.resetProgressOnDeath();
        assert.strictEqual(peao.xp, 0);
        assert.strictEqual(peao.rankKey, "PAWN");
    });
});
