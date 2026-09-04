import assert from "assert";

import { World } from "../src/sim/World.js";
import { CollisionMask } from "../src/sim/CollisionMask.js";
import { Actor } from "../src/sim/Actor.js";
import {
    RANKS, TICK_MS, DAMAGE_NORMAL, DAMAGE_CHARGED, HIT_INVULN_MS, BOT_RESPAWN_DELAY_MS, INPUT_TIMEOUT_MS,
    BOT_ATTACK_COOLDOWN_MS, RESPAWN_INVULN_MS, attackHalfBand, attackReach,
    KNOCKBACK_DECAY_MS, knockbackSpeed, BOT_CHARGE_HOLD_MS,
    ATTACK_WINDUP_MAX_MS, ATTACK_RECOVERY_MAX_MS, chargeDamage, chargeAreaMult,
    XP_PER_KILL, XP_PER_LEVEL, MAX_LEVEL, RANK_ORDER, levelFromXp, xpProgress,
    WORLD_WIDTH, WORLD_HEIGHT, HALF_WORLD_WIDTH, SPAWN_ZONE, SPAWN_MIN_DISTANCE,
    BOT_STUCK_CHECK_MS, TEAM_SIZE, BOT_UNSTICK_MS,
    CHARGE_MOVE_FACTOR, ATTACK_MOVE_FACTOR, movementFactor,
    GAME_MODES, DEFAULT_GAME_MODE, sanitizeGameMode,
    DAMAGE_LIGHT, DAMAGE_MAX, AREA_MULT_LIGHT, AREA_MULT_MAX, KNOCKBACK_CHARGED_FACTOR,
    attackWindupMs, attackRecoveryMs, chargePower,
    CHARGED_ATTACK_ENABLED, BASE_HEAL_PER_SECOND, insideHealZone, HEAL_ZONE, DASH_DISTANCE,
    canPhaseDash, WATER_SPEED_FACTOR,
    ATTACK_INTERVAL, ATTACK_AIM_DEADZONE, attackAimAngle,
} from "../src/sim/constants.js";

/**
 * Testes que dependem do ataque carregado. Continuam escritos, mas pulam
 * enquanto `CHARGED_ATTACK_ENABLED` estiver desligado (ver constants.ts) —
 * sem carga não há o que medir, e apagá-los perderia a cobertura de quando a
 * flag voltar.
 */
const itCarregado = CHARGED_ATTACK_ENABLED ? it : it.skip;

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
/**
 * Posições de teste ficam no pátio do castelo aliado: com a máscara de colisão
 * ativa, uma coordenada qualquer pode cair em cima de muralha e o `World`
 * devolveria o personagem para a última posição válida no primeiro tick.
 */
const LIVRE_X = 400;
const LIVRE_Y = 800;

/**
 * Chão livre FORA do castelo aliado.
 *
 * `LIVRE_X/Y` fica dentro da área de cura do castelo aliado (`HEAL_ZONE`), e
 * lá a base regenera `BASE_HEAL_PER_SECOND` — o que atrapalha os testes que
 * medem dano com pausas longas entre os golpes.
 */
const FORA_X = 1600;
const FORA_Y = 840;

function afasta(bot: Actor, target: Actor, distancia: number): void {
    bot.teleport(LIVRE_X, LIVRE_Y);
    target.teleport(LIVRE_X + distancia, LIVRE_Y);
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
function placeSideBySide(
    attacker: Actor, target: Actor, baseX = LIVRE_X, baseY = LIVRE_Y,
): void {
    attacker.teleport(baseX, baseY);
    attacker.flipX = false; // virado para a direita
    target.teleport(baseX + 110, baseY);
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

    itCarregado("o golpe carregado tira o dobro", () => {
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

        a.teleport(LIVRE_X, LIVRE_Y);
        b.teleport(LIVRE_X + 5, LIVRE_Y + 2);

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
        actor.teleport(LIVRE_X, LIVRE_Y);

        world.setInput(actor, 1, 0, 1);
        advance(world, 500);
        const andouCedo = actor.x - LIVRE_X;
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
        target.teleport(bot.x + 900, bot.y);
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

    itCarregado("o golpe carregado empurra mais que o normal, mas não o dobro", () => {
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
        attacker.teleport(LIVRE_X, LIVRE_Y);

        // Um acima, um na linha e um abaixo, todos ao alcance do círculo.
        const alvos = ["b", "c", "d"].map((id, i) => {
            const t = world.addPlayer(id, "enemy", id.toUpperCase());
            t.teleport(LIVRE_X + 80, LIVRE_Y - 70 + i * 70);
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

    itCarregado("o bot carrega para finalizar quando o normal não mataria", () => {
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

    itCarregado("o bot carrega quando o alvo só está no alcance dobrado", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const target = world.addPlayer("b", "enemy", "B");

        // Entre o alcance normal (~200) e o carregado (~280) do peão.
        afasta(bot, target, 240);

        comSorteioCerto(() => world.tick(TICK_MS));

        assert.strictEqual(bot.charging, true, "fora do alcance normal, carregar é de graça");
    });

    itCarregado("a carga do bot sai com o dano dobrado", () => {
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

    itCarregado("o bot desiste da carga se o alvo some", () => {
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

    itCarregado("o bot não fica preso segurando a carga se o alvo foge", () => {
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
                bot.teleport(LIVRE_X, LIVRE_Y);
                target.teleport(LIVRE_X + 1800, LIVRE_Y);
                world.tick(TICK_MS);
            }
        });

        assert.strictEqual(bot.charging, false, "tem de soltar em vez de segurar para sempre");
    });

    it("o personagem não sai do mapa", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        actor.teleport(LIVRE_X, LIVRE_Y);

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

    itCarregado("o dano do golpe sai da carga medida pelo servidor", () => {
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

    itCarregado("o cliente não consegue inflar a carga mandando 'soltei' várias vezes", () => {
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

    itCarregado("a recuperação impede encadear golpes", () => {
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

        // Morre de verdade, pelo caminho normal do combate — fora do castelo,
        // onde a base não estaria curando o alvo entre um golpe e outro.
        for (let i = 0; i < 8 && actor.alive; i++) {
            placeSideBySide(algoz, actor, FORA_X, FORA_Y);
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

    // -----------------------------------------------------------------------
    // MAPA, SPAWN E COLISÃO COM O CENÁRIO
    // -----------------------------------------------------------------------

    it("o mundo tem 4992x1684 e é a metade espelhada", () => {
        assert.strictEqual(WORLD_WIDTH, 4992);
        assert.strictEqual(WORLD_HEIGHT, 1684);
        assert.strictEqual(HALF_WORLD_WIDTH * 2, WORLD_WIDTH);
    });

    it("a máscara espelha a metade direita e trata fora do mapa como parede", () => {
        const world = new World();
        const mask = world.mask;

        for (const [x, y] of [[400, 800], [1200, 700], [200, 1200]] as const) {
            assert.strictEqual(
                mask.isWalkable(x, y),
                mask.isWalkable(WORLD_WIDTH - 1 - x, y),
                `o pixel (${x},${y}) e o espelho dele têm de concordar`,
            );
        }

        assert.strictEqual(mask.isWalkable(-1, 100), false);
        assert.strictEqual(mask.isWalkable(100, -1), false);
        assert.strictEqual(mask.isWalkable(WORLD_WIDTH, 100), false);
        assert.strictEqual(mask.isWalkable(100, WORLD_HEIGHT), false);
    });

    it("todo mundo nasce no castelo do próprio time, em chão livre", () => {
        const world = new World();

        for (let i = 0; i < 20; i++) {
            const ally = world.addBot("ally");
            const enemy = world.addBot("enemy");

            for (const [actor, esquerda] of [[ally, true], [enemy, false]] as const) {
                assert.ok(
                    actor.x > 0 && actor.x < WORLD_WIDTH && actor.y > 0 && actor.y < WORLD_HEIGHT,
                    "dentro do mapa",
                );
                assert.ok(
                    esquerda ? actor.x < HALF_WORLD_WIDTH : actor.x > HALF_WORLD_WIDTH,
                    `${actor.team} nasceu no lado errado (x=${actor.x})`,
                );

                const dentroX = esquerda
                    ? actor.x >= SPAWN_ZONE.minX && actor.x <= SPAWN_ZONE.maxX
                    : actor.x >= WORLD_WIDTH - SPAWN_ZONE.maxX && actor.x <= WORLD_WIDTH - SPAWN_ZONE.minX;
                assert.ok(dentroX, `fora da zona do castelo (x=${actor.x})`);
                assert.ok(
                    actor.y >= SPAWN_ZONE.minY && actor.y <= SPAWN_ZONE.maxY,
                    `fora da zona do castelo (y=${actor.y})`,
                );

                const centro = actor.ellipseCenter();
                assert.ok(
                    world.mask.canStand(centro.x, centro.y, actor.collisionRx, actor.collisionRy),
                    `nasceu em cima de parede (${actor.x}, ${actor.y})`,
                );
            }
        }
    });

    it("spawns seguidos não empilham personagens no mesmo ponto", () => {
        const world = new World();
        const atores = [];
        for (let i = 0; i < 5; i++) atores.push(world.addBot("ally"));

        for (let i = 0; i < atores.length; i++) {
            for (let j = i + 1; j < atores.length; j++) {
                const d = Math.hypot(atores[i].x - atores[j].x, atores[i].y - atores[j].y);
                assert.ok(d >= SPAWN_MIN_DISTANCE, `dois bots nasceram a ${d.toFixed(0)}px`);
            }
        }
    });

    it("não atravessa parede andando de frente", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");

        // Empurra contra a muralha por tempo de sobra.
        for (let i = 0; i < 200; i++) {
            world.setInput(actor, -1, 0, i + 1);
            world.tick(TICK_MS);
        }

        const centro = actor.ellipseCenter();
        assert.ok(
            world.mask.canStand(centro.x, centro.y, actor.collisionRx, actor.collisionRy),
            `terminou dentro de parede em (${actor.x.toFixed(0)}, ${actor.y.toFixed(0)})`,
        );
        assert.ok(actor.x > 0, "não pode vazar pela borda esquerda");
    });

    it("nenhuma direção, nem diagonal, atravessa o cenário", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");

        const direcoes = [
            [1, 0], [-1, 0], [0, 1], [0, -1],
            [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
        ] as const;

        let seq = 1;
        for (const [dx, dy] of direcoes) {
            for (let i = 0; i < 120; i++) {
                world.setInput(actor, dx, dy, seq++);
                world.tick(TICK_MS);

                const c = actor.ellipseCenter();
                assert.ok(
                    world.mask.canStand(c.x, c.y, actor.collisionRx, actor.collisionRy),
                    `direção (${dx},${dy}) colocou o personagem dentro de parede ` +
                    `em (${actor.x.toFixed(0)}, ${actor.y.toFixed(0)})`,
                );
            }
        }
    });

    it("o deslocamento por tick nunca passa da velocidade do rank", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");

        // Entrada absurda: o World normaliza, então o passo continua limitado.
        world.setInput(actor, 9999, 9999, 1);

        const teto = (actor.rank.speed * TICK_MS) / 1000 + 1;
        for (let i = 0; i < 40; i++) {
            const x0 = actor.x;
            const y0 = actor.y;
            world.tick(TICK_MS);
            const andou = Math.hypot(actor.x - x0, actor.y - y0);
            assert.ok(andou <= teto, `andou ${andou.toFixed(1)}px num tick (teto ${teto.toFixed(1)})`);
        }
    });

    it("vários personagens empurrando a mesma parede continuam do lado de fora", () => {
        const world = new World();
        const atores = [];
        for (let i = 0; i < 6; i++) atores.push(world.addPlayer(`p${i}`, "ally", `P${i}`));

        for (let t = 0; t < 120; t++) {
            for (const a of atores) world.setInput(a, -1, 0.3, t + 1);
            world.tick(TICK_MS);
        }

        for (const a of atores) {
            const c = a.ellipseCenter();
            assert.ok(
                world.mask.canStand(c.x, c.y, a.collisionRx, a.collisionRy),
                `${a.name} acabou dentro de parede em (${a.x.toFixed(0)}, ${a.y.toFixed(0)})`,
            );
        }
    });

    // -----------------------------------------------------------------------
    // NAVEGAÇÃO DOS BOTS
    // -----------------------------------------------------------------------

    it("o bot contorna o rio pela ponte em vez de encostar na margem", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const alvo = world.addPlayer("p", "enemy", "Alvo");

        // Margens opostas do rio, na mesma altura: em linha reta é impossível.
        bot.teleport(1150, 480);
        alvo.teleport(1600, 480);
        alvo.invulnUntil = Number.MAX_SAFE_INTEGER;

        let cruzou = false;
        let saiuDaLinhaReta = false;
        for (let i = 0; i < 900 && !cruzou; i++) {
            world.tick(TICK_MS);
            // Nadando ou pela ponte, o caminho nunca é a reta: ou ele desce
            // até a travessia, ou entra na água. O que não pode é ficar
            // empurrando a margem na mesma altura.
            if (Math.abs(bot.y - 480) > 60) saiuDaLinhaReta = true;
            const centro = bot.ellipseCenter();
            if (world.mask.isWater(centro.x, centro.y)) saiuDaLinhaReta = true;
            if (bot.x > 1500) cruzou = true;
        }

        assert.ok(saiuDaLinhaReta, "ele empurrou a margem em vez de procurar travessia");
        assert.ok(cruzou, `o bot ficou preso em (${bot.x.toFixed(0)}, ${bot.y.toFixed(0)})`);
    });

    it("bot com alvo visível vai direto, sem calcular rota", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const alvo = world.addPlayer("p", "enemy", "Alvo");

        // Campo aberto do pátio: linha de visão limpa.
        bot.teleport(300, 800);
        alvo.teleport(700, 800);
        alvo.invulnUntil = Number.MAX_SAFE_INTEGER;

        world.tick(TICK_MS);

        assert.strictEqual(bot.path.length, 0, "com o alvo à vista não se gasta A*");
        assert.ok(bot.x > 300, "e ele anda na direção do alvo");
    });

    it("bot travado joga a rota fora e tenta de novo", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const alvo = world.addPlayer("p", "enemy", "Alvo");

        bot.teleport(1150, 480);
        alvo.teleport(1600, 480);
        alvo.invulnUntil = Number.MAX_SAFE_INTEGER;

        // Deixa criar uma rota...
        for (let i = 0; i < 20; i++) world.tick(TICK_MS);

        // ...e finge que ele não saiu do lugar durante a janela de checagem.
        bot.progressX = bot.x;
        bot.progressY = bot.y;
        bot.progressAt = world.now - BOT_STUCK_CHECK_MS - 1;
        bot.pathAt = world.now;              // rota "fresca", que seria mantida
        bot.path = [9999, 9999];
        bot.pathIndex = 0;

        world.tick(TICK_MS);

        assert.notDeepStrictEqual(bot.path, [9999, 9999], "a rota velha tem de ser descartada");
    });

    it("o custo do tick continua desprezível com o mapa e a navegação", () => {
        const world = new World();
        for (let i = 0; i < TEAM_SIZE; i++) {
            world.addBot("ally");
            world.addBot("enemy");
        }

        // Aquece (spawn, primeiras rotas).
        for (let i = 0; i < 100; i++) world.tick(TICK_MS);

        let pior = 0;
        for (let i = 0; i < 300; i++) {
            const t0 = process.hrtime.bigint();
            world.tick(TICK_MS);
            pior = Math.max(pior, Number(process.hrtime.bigint() - t0) / 1e6);
        }

        assert.ok(
            pior < TICK_MS / 5,
            `pior tick ${pior.toFixed(2)} ms passou de um quinto do orçamento (${TICK_MS} ms)`,
        );
    });

    it("os bots realmente se deslocam pelo mapa", () => {
        const world = new World();
        for (let i = 0; i < TEAM_SIZE; i++) {
            world.addBot("ally");
            world.addBot("enemy");
        }
        for (let i = 0; i < 100; i++) world.tick(TICK_MS);

        const bots = [...world.actors.values()].filter((a) => a.isBot);
        const antes = bots.map((b) => ({ x: b.x, y: b.y }));

        for (let i = 0; i < 400; i++) world.tick(TICK_MS);

        const andou = bots.reduce(
            (soma, b, k) => soma + Math.hypot(b.x - antes[k].x, b.y - antes[k].y), 0,
        );

        // Antes da navegação isto dava ~14 px no total: eles empurravam a
        // muralha sem sair do lugar.
        assert.ok(andou > 2000, `os bots mal se moveram (${andou.toFixed(0)} px somados)`);
    });

    // -----------------------------------------------------------------------
    // QUINAS, CANTOS E RECUPERAÇÃO
    // -----------------------------------------------------------------------

    it("nenhuma posição aceita deixa parte do corpo dentro da parede", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        const mask = world.mask;

        // Varre o mapa empurrando em oito direções a partir de vários pontos do
        // castelo; toda posição aceita tem de passar no teste de nove pontos.
        const direcoes = [
            [1, 0], [-1, 0], [0, 1], [0, -1],
            [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
        ] as const;

        let seq = 1;
        for (const [dx, dy] of direcoes) {
            actor.teleport(400, 800);
            for (let i = 0; i < 200; i++) {
                world.setInput(actor, dx, dy, seq++);
                world.tick(TICK_MS);

                const c = actor.ellipseCenter();
                assert.ok(
                    mask.canStand(c.x, c.y, actor.collisionRx, actor.collisionRy),
                    `corpo dentro da parede em (${actor.x.toFixed(0)}, ${actor.y.toFixed(0)}) ` +
                    `indo para (${dx}, ${dy})`,
                );
            }
        }
    });

    it("quem anda contra a parede encosta nela, não para a um passo", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        actor.teleport(400, 800);

        // Empurra para o oeste até parar de progredir.
        let seq = 1;
        for (let i = 0; i < 200; i++) {
            world.setInput(actor, -1, 0, seq++);
            world.tick(TICK_MS);
        }
        const parouEm = actor.x;

        // A parede está logo à frente: um passo além já não caberia.
        const c = actor.ellipseCenter();
        assert.ok(
            !world.mask.canStand(c.x - 2, c.y, actor.collisionRx, actor.collisionRy),
            `parou a mais de 2 px da parede (x=${parouEm.toFixed(1)})`,
        );
    });

    it("parede inclinada não trava o movimento: o personagem desliza", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");

        // A muralha do castelo desce na diagonal; empurrar contra ela tem de
        // render deslocamento ao longo dela, não parada seca.
        actor.teleport(300, 1300);
        const y0 = actor.y;

        let seq = 1;
        for (let i = 0; i < 60; i++) {
            world.setInput(actor, -1, 1, seq++);
            world.tick(TICK_MS);
        }

        assert.ok(
            Math.abs(actor.y - y0) > 40,
            `mal deslizou pela muralha (y foi de ${y0.toFixed(0)} para ${actor.y.toFixed(0)})`,
        );
    });

    it("encostado num obstáculo, a posição fica parada (sem tremor)", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");

        // Empurra contra a muralha, a quina e as bordas do mapa; em regime
        // estacionário a posição não pode oscilar. Foi essa oscilação —
        // resgate empurra, entrada devolve — que aparecia como tremor na tela.
        const casos: Array<[string, number, number, number, number]> = [
            ["parede oeste", 400, 800, -1, 0],
            ["quina noroeste", 400, 800, -1, -1],
            ["borda superior", 400, 600, 0, -1],
            ["borda inferior", 400, 1400, 0, 1],
        ];

        for (const [nome, x0, y0, dx, dy] of casos) {
            actor.teleport(x0, y0);

            let seq = 1;
            for (let i = 0; i < 150; i++) {
                world.setInput(actor, dx, dy, seq++);
                world.tick(TICK_MS);
            }

            // Já encostado: os próximos ticks têm de deixar tudo no lugar.
            const parado = { x: actor.x, y: actor.y };
            for (let i = 0; i < 40; i++) {
                world.setInput(actor, dx, dy, seq++);
                world.tick(TICK_MS);

                assert.ok(
                    Math.hypot(actor.x - parado.x, actor.y - parado.y) < 0.5,
                    `${nome}: a posição oscilou ` +
                    `(${parado.x.toFixed(1)},${parado.y.toFixed(1)}) -> ` +
                    `(${actor.x.toFixed(1)},${actor.y.toFixed(1)})`,
                );
            }
        }
    });

    it("quem for espremido para dentro da parede sai sozinho", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");

        // Encosta na muralha e empurra alguns pixels para dentro — é o que a
        // separação entre personagens e o empurrão de um golpe produzem na
        // prática (ninguém aparece 200 px dentro da pedra).
        actor.teleport(400, 800);
        while (world.mask.canStand(
            actor.ellipseCenter().x, actor.ellipseCenter().y,
            actor.collisionRx, actor.collisionRy,
        )) {
            actor.teleport(actor.x - 8, actor.y);
        }
        assert.ok(
            !world.mask.canStand(actor.ellipseCenter().x, actor.ellipseCenter().y,
                actor.collisionRx, actor.collisionRy),
            "o teste precisa começar com o personagem realmente dentro da parede",
        );

        for (let i = 0; i < 20; i++) {
            world.setInput(actor, 1, 0, i + 1);
            world.tick(TICK_MS);
        }

        const c = actor.ellipseCenter();
        assert.ok(
            world.mask.canStand(c.x, c.y, actor.collisionRx, actor.collisionRy),
            `continuou dentro da parede em (${actor.x.toFixed(0)}, ${actor.y.toFixed(0)})`,
        );
    });

    it("bot travado tenta o outro lado na travada seguinte", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const alvo = world.addPlayer("p", "enemy", "Alvo");
        alvo.invulnUntil = Number.MAX_SAFE_INTEGER;
        bot.teleport(1150, 480);
        alvo.teleport(1600, 480);

        const travar = () => {
            bot.progressX = bot.x;
            bot.progressY = bot.y;
            bot.progressAt = world.now - BOT_STUCK_CHECK_MS - 1;
            world.tick(TICK_MS);
        };

        travar();
        const primeiroLado = bot.unstickSide;
        assert.ok(bot.unstickUntil > world.now, "devia estar contornando");

        bot.unstickUntil = 0;
        travar();
        assert.strictEqual(
            bot.unstickSide, -primeiroLado,
            "insistir no mesmo lado repetiria a mesma travada",
        );
    });

    it("bot preso num canto do castelo se solta e volta a andar", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const alvo = world.addPlayer("p", "enemy", "Alvo");
        alvo.invulnUntil = Number.MAX_SAFE_INTEGER;

        // Encaixa o bot no canto inferior esquerdo do pátio, com o alvo do
        // outro lado do mapa: em linha reta ele encosta na muralha.
        bot.teleport(200, 1400);
        alvo.teleport(4600, 900);

        const inicio = { x: bot.x, y: bot.y };
        for (let i = 0; i < 600; i++) world.tick(TICK_MS);

        const andou = Math.hypot(bot.x - inicio.x, bot.y - inicio.y);
        assert.ok(andou > 300, `o bot saiu só ${andou.toFixed(0)} px do canto`);
        assert.ok(BOT_UNSTICK_MS > 0);
    });

    // -----------------------------------------------------------------------
    // LENTIDÃO AO CARREGAR O GOLPE
    // -----------------------------------------------------------------------

    itCarregado("quem carrega anda mais devagar, e volta ao normal ao soltar", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        actor.teleport(LIVRE_X, LIVRE_Y);

        const andouEm = (ticks: number) => {
            const x0 = actor.x;
            for (let i = 0; i < ticks; i++) {
                world.setInput(actor, 1, 0, world.now + i + 1);
                world.tick(TICK_MS);
            }
            return actor.x - x0;
        };

        const normal = andouEm(4);

        world.startCharge(actor);
        const carregando = andouEm(4);

        world.releaseAttack(actor);
        // O golpe leva `attackWindupMs` para sair; depois dele a recuperação
        // impede nova carga, mas a velocidade já é a normal.
        advance(world, ATTACK_WINDUP_MAX_MS + ATTACK_RECOVERY_MAX_MS + TICK_MS * 2);
        const depois = andouEm(4);

        assert.ok(
            Math.abs(carregando - normal * CHARGE_MOVE_FACTOR) < 1,
            `carregando devia andar ${(normal * CHARGE_MOVE_FACTOR).toFixed(1)} px, andou ${carregando.toFixed(1)}`,
        );
        assert.ok(carregando < normal, "carregar tem de ser mais lento que andar normal");
        assert.ok(
            Math.abs(depois - normal) < 1,
            `a velocidade devia voltar ao normal (${normal.toFixed(1)}), foi ${depois.toFixed(1)}`,
        );
    });

    itCarregado("cancelar a carga devolve a velocidade na hora", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        actor.teleport(LIVRE_X, LIVRE_Y);

        world.startCharge(actor);
        world.setInput(actor, 1, 0, 1);
        world.tick(TICK_MS);
        const passoCarregando = Math.abs(actor.vx);

        // `cancelAttack` é o caminho usado por morte/dash: solta a carga sem golpe.
        actor.cancelAttack();
        world.setInput(actor, 1, 0, 2);
        world.tick(TICK_MS);

        assert.ok(Math.abs(actor.vx) > passoCarregando, "sem carga, a velocidade volta");
        assert.strictEqual(Math.abs(actor.vx), actor.rank.speed);
    });

    it("o golpe normal não teve a velocidade alterada", () => {
        // Regressão: o fator do golpe em curso continua o mesmo de antes.
        assert.strictEqual(movementFactor(true, false), ATTACK_MOVE_FACTOR);
        assert.strictEqual(movementFactor(false, false), 1);
        assert.strictEqual(movementFactor(false, true), CHARGE_MOVE_FACTOR);
        // Estados não coexistem, mas se coexistissem o golpe manda.
        assert.strictEqual(movementFactor(true, true), ATTACK_MOVE_FACTOR);
    });

    // -----------------------------------------------------------------------
    // MODO DE JOGO
    // -----------------------------------------------------------------------

    it("o dash para junto de quem estava no caminho, sem voltar", () => {
        const world = new World();
        const dasher = world.addPlayer("a", "ally", "A");
        const alvo = world.addPlayer("b", "enemy", "B");

        // Alvo a meio caminho do dash: o impulso vai encontrá-lo.
        dasher.teleport(LIVRE_X, LIVRE_Y);
        alvo.teleport(LIVRE_X + DASH_DISTANCE / 2, LIVRE_Y);
        alvo.inputDx = 0;

        assert.strictEqual(world.requestDash(dasher), true);
        advance(world, 400);

        const parou = dasher.x;
        const encostado = alvo.x - (dasher.collisionRx + alvo.collisionRx);

        assert.ok(dasher.x > LIVRE_X, "o dash tem de ter avançado");
        assert.ok(
            dasher.x >= encostado - 20,
            `parou longe demais do alvo: ${dasher.x} contra ${encostado}`,
        );
        assert.ok(dasher.x < alvo.x, "não pode atravessar o outro personagem");

        // E não é arrastado de volta depois que o dash acaba.
        advance(world, 400);
        assert.ok(
            Math.abs(dasher.x - parou) < 5,
            `voltou ${parou - dasher.x} px depois de parar`,
        );
    });

    it("dashar para longe de quem está colado não cancela o dash", () => {
        const world = new World();
        const dasher = world.addPlayer("a", "ally", "A");
        const colado = world.addPlayer("b", "ally", "B");

        dasher.teleport(LIVRE_X, LIVRE_Y);
        colado.teleport(LIVRE_X + 20, LIVRE_Y); // sobreposto de propósito
        dasher.inputDx = -1;
        dasher.inputDy = 0;

        assert.strictEqual(world.requestDash(dasher), true);
        advance(world, 400);

        assert.ok(
            LIVRE_X - dasher.x > DASH_DISTANCE * 0.7,
            `o dash de fuga rendeu só ${LIVRE_X - dasher.x} px`,
        );
    });

    it("o castelo cura só quem é do time dele", () => {
        const world = new World();
        const aliado = world.addPlayer("a", "ally", "A");
        const inimigo = world.addPlayer("b", "enemy", "B");

        // Os dois no castelo aliado, machucados.
        aliado.teleport(LIVRE_X, LIVRE_Y);
        inimigo.teleport(LIVRE_X + 200, LIVRE_Y);
        aliado.currentHealth = 10;
        inimigo.currentHealth = 10;

        assert.ok(insideHealZone("ally", aliado.x, aliado.y), "cenário: dentro da base aliada");
        assert.ok(!insideHealZone("enemy", inimigo.x, inimigo.y), "cenário: base errada para o inimigo");

        advance(world, 1000);

        assert.ok(
            Math.abs(aliado.currentHealth - (10 + BASE_HEAL_PER_SECOND)) < 1,
            `curou ${aliado.currentHealth - 10} em 1 s`,
        );
        assert.strictEqual(inimigo.currentHealth, 10, "base do outro time não cura");
    });

    /**
     * A área de cura tem de ficar FUNDO no pátio: quem está no portão, ou
     * ainda no campo aberto ao sul do castelo, não pode estar regenerando.
     *
     * O teste não crava "o portão é aqui": ele MEDE, com uma busca em largura
     * sobre a própria máscara, a que distância de caminhada do lado de fora
     * está cada ponto da zona. É assim que ele continua valendo se a arte do
     * castelo mudar — e é assim que ele pegaria de volta a `SPAWN_ZONE`, cujo
     * canto sul chega a 808 px (e transborda o portão).
     */
    it("o botão DEBUG cicla peão -> ... -> rainha -> peão", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        actor.teleport(LIVRE_X, LIVRE_Y);

        assert.strictEqual(actor.rankKey, "PAWN", "cenário: começa peão");

        // Uma volta inteira mais um passo: tem de bater com RANK_ORDER e
        // voltar ao começo, sem parar na rainha nem inventar peça nova.
        const vistos: string[] = [];
        for (let i = 0; i < RANK_ORDER.length; i++) {
            world.debugCycleRank(actor);
            vistos.push(actor.rankKey);
        }

        assert.deepStrictEqual(
            vistos,
            [...RANK_ORDER.slice(1), RANK_ORDER[0]],
            "a ordem tem de ser a de RANK_ORDER, com a rainha voltando ao peão",
        );

        // O ciclo não tem fim: outra volta dá exatamente o mesmo.
        const segundaVolta: string[] = [];
        for (let i = 0; i < RANK_ORDER.length; i++) {
            world.debugCycleRank(actor);
            segundaVolta.push(actor.rankKey);
        }
        assert.deepStrictEqual(segundaVolta, vistos, "a segunda volta é igual à primeira");
    });

    it("o DEBUG usa a promoção de verdade: vida, XP e geometria acompanham", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        actor.teleport(LIVRE_X, LIVRE_Y);

        const rxPeao = actor.collisionRx;
        actor.currentHealth = 7;

        world.debugCycleRank(actor);
        assert.strictEqual(actor.rankKey, "TOWER");
        assert.strictEqual(actor.maxHealth, RANKS.TOWER.health, "vida máxima é a do rank novo");
        assert.strictEqual(actor.currentHealth, actor.maxHealth, "promoção cura, como a normal");
        assert.strictEqual(actor.level, 2, "o nível deriva do rank");

        // Até a rainha: da torre (nível 2) faltam MAX_LEVEL - 2 cliques.
        for (let i = actor.level; i < MAX_LEVEL; i++) world.debugCycleRank(actor);
        assert.strictEqual(actor.rankKey, "QUEEN");
        assert.ok(actor.collisionRx > rxPeao, "a rainha é maior que o peão");
        assert.strictEqual(actor.rank.speed, RANKS.QUEEN.speed, "velocidade vem do rank");

        // A XP fica no PISO do nível — o sistema normal continua valendo por
        // cima, sem atalho: mais um abate NÃO promove além do teto.
        assert.strictEqual(actor.xp, (MAX_LEVEL - 1) * XP_PER_LEVEL);
        actor.addExperience(XP_PER_KILL);
        assert.strictEqual(actor.rankKey, "QUEEN", "no teto continua rainha");

        // E de volta ao peão a XP zera, então subir exige matar de novo.
        world.debugCycleRank(actor);
        assert.strictEqual(actor.rankKey, "PAWN");
        assert.strictEqual(actor.xp, 0, "peão de novo começa do zero");
        assert.strictEqual(actor.addExperience(XP_PER_LEVEL - 1), false, "XP parcial não promove");
        assert.strictEqual(actor.rankKey, "PAWN");
        assert.strictEqual(actor.addExperience(1), true, "cheio o nível, promove pelo caminho normal");
        assert.strictEqual(actor.rankKey, "TOWER");
    });

    it("o DEBUG não promove ninguém para dentro da parede", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        actor.teleport(LIVRE_X, LIVRE_Y);

        // Uma volta inteira a partir de vários pontos do mapa: em nenhum deles
        // a troca de peça pode terminar em posição inválida — a rainha é bem
        // maior que o peão e um vão apertado entalaria.
        for (const [x, y] of [[LIVRE_X, LIVRE_Y], [1600, 840], [530, 760], [1300, 740]]) {
            actor.teleport(x, y);
            for (let i = 0; i < RANK_ORDER.length * 2; i++) {
                world.debugCycleRank(actor);
                assert.ok(
                    world.mask.canStand(
                        actor.x, actor.ellipseCenter().y, actor.collisionRx, actor.collisionRy,
                    ),
                    `${actor.rankKey} ficou em posição inválida partindo de (${x}, ${y})`,
                );
            }
        }
    });

    it("morto não troca de peça pelo DEBUG", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        actor.teleport(LIVRE_X, LIVRE_Y);
        actor.alive = false;

        assert.strictEqual(world.debugCycleRank(actor), false);
        assert.strictEqual(actor.rankKey, "PAWN");
    });

    it("a área de cura fica no fundo do pátio, longe do portão", () => {
        const world = new World();
        const S = 8;
        const gw = Math.ceil(WORLD_WIDTH / S);
        const gh = Math.ceil(WORLD_HEIGHT / S);
        const dist = new Int32Array(gw * gh).fill(-1);

        // Origem: campo aberto a leste do castelo aliado.
        const inicio = (Math.floor(1400 / S)) * gw + Math.floor(1700 / S);
        dist[inicio] = 0;
        let fila = [inicio];
        while (fila.length) {
            const prox: number[] = [];
            for (const c of fila) {
                const cx = c % gw;
                const cy = (c - cx) / gw;
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nx = cx + dx;
                    const ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
                    const n = ny * gw + nx;
                    if (dist[n] >= 0) continue;
                    if (!world.mask.isWalkable(nx * S + S / 2, ny * S + S / 2)) continue;
                    dist[n] = dist[c] + S;
                    prox.push(n);
                }
            }
            fila = prox;
        }

        let maisRaso = Infinity;
        let cegos = 0;
        for (let y = HEAL_ZONE.minY; y <= HEAL_ZONE.maxY; y += S) {
            for (let x = HEAL_ZONE.minX; x <= HEAL_ZONE.maxX; x += S) {
                const g = Math.floor(y / S) * gw + Math.floor(x / S);
                if (!world.mask.isWalkable(x, y)) continue;
                if (dist[g] < 0) { cegos++; continue; }
                maisRaso = Math.min(maisRaso, dist[g]);
            }
        }

        assert.strictEqual(cegos, 0, "a zona toda tem de ser alcançável de fora");
        assert.ok(
            maisRaso >= 1200,
            `o ponto mais raso da zona está a só ${maisRaso} px do campo aberto`,
        );

        // O corredor do portão (medido na máscara: x 192..456, y 1176..1300)
        // não pode curar ninguém.
        for (const [x, y] of [[330, 1200], [330, 1280], [520, 1350], [900, 1380]]) {
            assert.ok(
                !insideHealZone("ally", x, y),
                `(${x}, ${y}) é portão/campo aberto e não pode curar`,
            );
            assert.ok(
                !insideHealZone("enemy", WORLD_WIDTH - x, y),
                `o espelho de (${x}, ${y}) também não pode curar`,
            );
        }

        // E o miolo do pátio continua curando, nos dois castelos.
        assert.ok(insideHealZone("ally", 530, 760), "miolo do pátio aliado");
        assert.ok(insideHealZone("enemy", WORLD_WIDTH - 530, 760), "miolo do pátio inimigo");
    });

    it("a cura para no máximo, e fora da base não acontece", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");

        actor.teleport(LIVRE_X, LIVRE_Y);
        actor.currentHealth = actor.maxHealth - 5;
        advance(world, 2000);

        assert.strictEqual(actor.currentHealth, actor.maxHealth, "não pode passar do máximo");

        // Fora da zona: para de curar.
        actor.teleport(FORA_X, FORA_Y);
        assert.ok(!insideHealZone("ally", actor.x, actor.y), "cenário: fora da base");
        actor.currentHealth = 40;
        advance(world, 1000);

        assert.strictEqual(actor.currentHealth, 40, "fora da base ninguém cura");
    });

    /**
     * Procura no mapa de verdade um ponto de partida em que o dash para leste
     * atravesse parede. `chegadaLivre` escolhe entre os dois casos que
     * interessam: parede fina com chão do outro lado, e parede que segue até
     * depois do alcance do dash.
     *
     * Varre a máscara em vez de cravar coordenadas: se a arte mudar, o teste
     * continua achando um cenário válido (ou falha dizendo que não achou).
     */
    function acheParede(
        world: World, actor: Actor, chegadaLivre: boolean,
    ): { x: number; y: number } | undefined {
        const cabe = (x: number, y: number) => {
            const centroY = y + actor.rank.size.height / 2
                - actor.collisionRx + (actor.collisionRy * 4) / 3;
            return world.mask.canStand(x, centroY, actor.collisionRx, actor.collisionRy);
        };

        for (let y = 300; y < WORLD_HEIGHT - 300; y += 40) {
            for (let x = 300; x < HALF_WORLD_WIDTH - DASH_DISTANCE; x += 20) {
                if (!cabe(x, y)) continue;
                // Alguma coisa sólida no meio do caminho.
                if (cabe(x + DASH_DISTANCE / 2, y)) continue;
                if (cabe(x + DASH_DISTANCE, y) !== chegadaLivre) continue;
                return { x, y };
            }
        }
        return undefined;
    }

    /** Dá um dash para leste e devolve onde o personagem parou. */
    function dashParaLeste(world: World, actor: Actor): number {
        actor.inputDx = 1;
        actor.inputDy = 0;
        actor.dashReadyAt = 0;
        assert.strictEqual(world.requestDash(actor), true, "o dash deveria ter saído");

        // A direção já foi congelada no dash; sem zerar a entrada o personagem
        // sairia ANDANDO para leste depois que o impulso acabasse, e a medida
        // deixaria de ser a do dash.
        actor.inputDx = 0;
        advance(world, 600);
        return actor.x;
    }

    it("o cavalo atravessa a estrutura quando cabe do outro lado", () => {
        const world = new World();
        const cavalo = world.addPlayer("a", "ally", "A");
        cavalo.setRank("HORSE");

        const ponto = acheParede(world, cavalo, true);
        assert.ok(ponto, "não achei parede fina com chão do outro lado no mapa");

        cavalo.teleport(ponto!.x, ponto!.y);
        const parou = dashParaLeste(world, cavalo);

        assert.ok(
            Math.abs(parou - (ponto!.x + DASH_DISTANCE)) < 15,
            `devia pousar em ${ponto!.x + DASH_DISTANCE}, parou em ${parou}`,
        );

        const centro = cavalo.ellipseCenter();
        assert.ok(
            world.mask.canStand(centro.x, centro.y, cavalo.collisionRx, cavalo.collisionRy),
            "não pode terminar dentro (nem meio dentro) da estrutura",
        );
        assert.strictEqual(cavalo.dashPhasing, false, "a travessia tem de acabar com o dash");
    });

    it("a travessia termina no ponto aprovado mesmo levando empurrão", () => {
        const world = new World();
        const cavalo = world.addPlayer("a", "ally", "A");
        cavalo.setRank("HORSE");

        const ponto = acheParede(world, cavalo, true);
        assert.ok(ponto);

        cavalo.teleport(ponto!.x, ponto!.y);
        cavalo.inputDx = 1;
        cavalo.inputDy = 0;
        cavalo.dashReadyAt = 0;
        assert.strictEqual(world.requestDash(cavalo), true);
        cavalo.inputDx = 0;

        assert.strictEqual(cavalo.dashPhasing, true, "devia ter saído atravessando");

        // Golpe no meio do voo: o empurrão tira o cavalo da linha do dash.
        world.tick(TICK_MS);
        cavalo.knockbackVx = -600;
        cavalo.knockbackVy = 400;
        advance(world, 600);

        const centro = cavalo.ellipseCenter();
        assert.ok(
            world.mask.canStand(centro.x, centro.y, cavalo.collisionRx, cavalo.collisionRy),
            `terminou em posição inválida (${cavalo.x}, ${cavalo.y})`,
        );
        assert.ok(
            Math.hypot(cavalo.x - ponto!.x, cavalo.y - ponto!.y) > DASH_DISTANCE / 2,
            "não pode voltar para o ponto de partida",
        );
        assert.strictEqual(cavalo.dashPhasing, false);
    });

    it("as outras peças continuam paradas pela mesma estrutura", () => {
        const world = new World();
        const cavalo = world.addPlayer("a", "ally", "A");
        cavalo.setRank("HORSE");
        const ponto = acheParede(world, cavalo, true);
        assert.ok(ponto);

        const peao = world.addPlayer("b", "enemy", "B");
        assert.strictEqual(canPhaseDash(peao.rankKey), false);

        peao.teleport(ponto!.x, ponto!.y);
        const parou = dashParaLeste(world, peao);

        assert.ok(
            parou < ponto!.x + DASH_DISTANCE / 2,
            `o peão atravessou a parede: ${ponto!.x} -> ${parou}`,
        );
        assert.strictEqual(peao.dashPhasing, false);
    });

    it("o cavalo não atravessa quando não há chegada válida", () => {
        const world = new World();
        const cavalo = world.addPlayer("a", "ally", "A");
        cavalo.setRank("HORSE");

        const ponto = acheParede(world, cavalo, false);
        assert.ok(ponto, "não achei parede grossa o bastante no mapa");

        cavalo.teleport(ponto!.x, ponto!.y);

        cavalo.inputDx = 1;
        cavalo.inputDy = 0;
        cavalo.dashReadyAt = 0;
        assert.strictEqual(world.requestDash(cavalo), true);
        cavalo.inputDx = 0;

        // Sem chegada aprovada não há travessia. O dash em si continua
        // acontecendo (e pode deslizar pela parede, como qualquer movimento) —
        // o que não pode é entrar na estrutura.
        assert.strictEqual(cavalo.dashPhasing, false, "não devia ter saído atravessando");

        advance(world, 600);

        const centro = cavalo.ellipseCenter();
        assert.ok(
            world.mask.canStand(centro.x, centro.y, cavalo.collisionRx, cavalo.collisionRy),
            "terminou dentro da estrutura",
        );
    });

    it("nem o cavalo sai pela borda do mapa", () => {
        const world = new World();
        const cavalo = world.addPlayer("a", "ally", "A");
        cavalo.setRank("HORSE");

        const halfW = cavalo.rank.size.width / 2;
        cavalo.teleport(WORLD_WIDTH - halfW - 10, LIVRE_Y);

        const parou = dashParaLeste(world, cavalo);

        assert.strictEqual(cavalo.dashPhasing, false, "borda não se atravessa");
        assert.ok(parou <= WORLD_WIDTH - halfW, `saiu do mapa: x=${parou}`);
    });

    /**
     * Água mais próxima do castelo aliado onde a peça cabe inteira.
     *
     * "Mais próxima" porque é a água em que se entra andando a partir do
     * pátio — a que interessa para medir velocidade e alcance.
     */
    function achaAgua(world: World, actor: Actor): { x: number; y: number } | undefined {
        const alturaCentro = actor.rank.size.height / 2
            - actor.collisionRx + (actor.collisionRy * 4) / 3;

        let melhor: { x: number; y: number } | undefined;
        let melhorDist = Infinity;

        for (let y = 200; y < WORLD_HEIGHT - 200; y += 24) {
            for (let x = 200; x < HALF_WORLD_WIDTH; x += 24) {
                if (!world.mask.isWater(x, y + alturaCentro)) continue;
                if (!world.mask.canStand(x, y + alturaCentro, actor.collisionRx, actor.collisionRy)) continue;

                const d = Math.hypot(x - LIVRE_X, y - LIVRE_Y);
                if (d >= melhorDist) continue;
                melhorDist = d;
                melhor = { x, y };
            }
        }
        return melhor;
    }

    it("atravessa o rio andando, sem parar e sem precisar de resgate", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");

        // Espia o resgate: ele é a última linha de defesa e NÃO pode ser o que
        // faz alguém atravessar o rio. Se aparecer aqui, a colisão travou.
        const proto = CollisionMask.prototype as unknown as {
            nearestFree: (...args: unknown[]) => unknown;
        };
        const original = proto.nearestFree;
        let resgates = 0;
        proto.nearestFree = function (this: unknown, ...args: unknown[]) {
            resgates++;
            return original.apply(this, args);
        };

        try {
            for (const rank of ["PAWN", "QUEEN"] as const) {
                actor.setRank(rank);

                for (const y of [960, 1080, 1200, 1320]) {
                    // Partida válida para a peça atual (a rainha é bem maior
                    // que o peão). Usar o próprio resgate para POSICIONAR é
                    // legítimo; o que se mede é a caminhada depois disso.
                    const alturaCentro = actor.rank.size.height / 2
                        - actor.collisionRx + (actor.collisionRy * 4) / 3;
                    const partida = world.mask.nearestFree(
                        1050, y, alturaCentro, actor.collisionRx, actor.collisionRy,
                    );
                    assert.ok(partida, `sem chão livre para começar em y=${y}`);

                    actor.teleport(partida!.x, partida!.y);
                    const resgatesAntes = resgates;
                    let parado = 0;

                    for (let t = 0; t < 200; t++) {
                        world.setInput(actor, 1, 0, t + 1);
                        actor.lastInputAt = world.now;
                        const antes = actor.x;
                        world.tick(TICK_MS);
                        if (Math.abs(actor.x - antes) < 0.5) parado++;
                    }

                    assert.ok(
                        actor.x > 2000,
                        `${rank} não atravessou o rio em y=${y}: parou em x=${actor.x.toFixed(0)}`,
                    );
                    assert.ok(
                        parado < 20,
                        `${rank} ficou ${parado}/200 ticks parado em y=${y}`,
                    );
                    assert.strictEqual(
                        resgates, resgatesAntes,
                        `${rank} precisou do resgate para atravessar em y=${y}`,
                    );
                }
            }
        } finally {
            proto.nearestFree = original;
        }

    });

    it("a máscara não tem respingo bloqueado dentro da água", () => {
        // Um bloco bloqueado menor que um corpo, cercado só de água, é sujeira
        // da arte — e proíbe uma área do TAMANHO DO CORPO, porque as nove
        // sondas de `canStand` batem nele de longe. Era o que travava quem
        // atravessava o rio. Quem limpa é `npm run paint:water`; este teste
        // garante que a máscara publicada está limpa.
        const world = new World();
        const areaCorpo = Math.PI * 50 * 25;

        const largura = HALF_WORLD_WIDTH;
        const altura = WORLD_HEIGHT;
        const visto = new Uint8Array(largura * altura);
        const fila = new Int32Array(largura * altura);

        const bloqueado = (i: number) => {
            const x = i % largura;
            const y = (i / largura) | 0;
            return !world.mask.isWalkable(x + 0.5, y + 0.5);
        };
        const agua = (i: number) => {
            const x = i % largura;
            const y = (i / largura) | 0;
            return world.mask.isWater(x + 0.5, y + 0.5);
        };

        let sujos = 0;
        for (let inicio = 0; inicio < visto.length; inicio++) {
            if (visto[inicio] || !bloqueado(inicio)) continue;

            let cabeca = 0;
            let cauda = 0;
            fila[cauda++] = inicio;
            visto[inicio] = 1;
            let soAgua = true;

            while (cabeca < cauda) {
                const i = fila[cabeca++];
                const x = i % largura;
                const y = (i / largura) | 0;
                const vizinhos = [
                    x > 0 ? i - 1 : -1,
                    x < largura - 1 ? i + 1 : -1,
                    y > 0 ? i - largura : -1,
                    y < altura - 1 ? i + largura : -1,
                ];
                for (const v of vizinhos) {
                    if (v < 0) continue;
                    if (!bloqueado(v)) {
                        if (!agua(v)) soAgua = false;
                        continue;
                    }
                    if (visto[v]) continue;
                    visto[v] = 1;
                    fila[cauda++] = v;
                }
            }

            if (soAgua && cauda <= areaCorpo) sujos++;
        }

        assert.strictEqual(sujos, 0, `${sujos} respingos bloqueados dentro da água — rode npm run paint:water`);
    });

    it("dentro da água todo mundo anda a 80%, e volta ao normal ao sair", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");

        const agua = achaAgua(world, actor);
        assert.ok(agua, "o mapa precisa ter água onde a peça caiba");

        // Nadando: um tick de movimento horizontal.
        actor.teleport(agua!.x, agua!.y);
        world.setInput(actor, 1, 0, 1);
        actor.lastInputAt = world.now;
        const antesAgua = actor.x;
        world.tick(TICK_MS);
        const naAgua = actor.x - antesAgua;

        // Em terra firme, o mesmo passo.
        actor.teleport(LIVRE_X, LIVRE_Y);
        world.setInput(actor, 1, 0, 2);
        actor.lastInputAt = world.now;
        const antesTerra = actor.x;
        world.tick(TICK_MS);
        const naTerra = actor.x - antesTerra;

        assert.ok(naTerra > 0 && naAgua > 0, "os dois passos têm de andar para frente");
        assert.ok(
            Math.abs(naAgua / naTerra - WATER_SPEED_FACTOR) < 0.02,
            `na água andou ${(naAgua / naTerra).toFixed(2)} do normal, esperado ${WATER_SPEED_FACTOR}`,
        );
    });

    it("a água não acumula o freio nem altera a velocidade base", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        const agua = achaAgua(world, actor);
        assert.ok(agua);

        actor.teleport(agua!.x, agua!.y);
        world.setInput(actor, 1, 0, 1);

        const passos: number[] = [];
        for (let i = 0; i < 5; i++) {
            actor.lastInputAt = world.now;
            actor.teleport(agua!.x, agua!.y);
            const antes = actor.x;
            world.tick(TICK_MS);
            passos.push(actor.x - antes);
        }

        for (const passo of passos) {
            assert.ok(
                Math.abs(passo - passos[0]) < 0.01,
                `o passo mudou dentro da água: ${passos.join(", ")}`,
            );
        }
        assert.strictEqual(actor.rank.speed, RANKS.PAWN.speed, "a velocidade do rank é intocada");
    });

    it("a água é navegável: existe rota atravessando o rio", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        const agua = achaAgua(world, actor);
        assert.ok(agua);

        assert.strictEqual(
            world.nav.canReach(LIVRE_X, LIVRE_Y, agua!.x, agua!.y), true,
            "não dá para chegar à água a pé — ela virou barreira",
        );
    });

    /** Distância de `y` até o centro da elipse, para o rank atual do ator. */
    function alturaCentro(actor: Actor): number {
        return actor.rank.size.height / 2 - actor.collisionRx + (actor.collisionRy * 4) / 3;
    }

    /**
     * Os tabuleiros de ponte da metade esquerda, lidos DA MÁSCARA.
     *
     * Nenhuma coordenada cravada no teste: quem sabe onde estão as pontes é a
     * máscara (`npm run paint:bridges`). Como o mundo é o espelho desta
     * metade, cobrir os tabuleiros daqui é cobrir todas as pontes do mapa — e
     * os testes abaixo iteram sobre a lista, então uma ponte nova entra sem
     * ninguém escrever nada.
     */
    function achaTabuleiros(world: World): { minX: number; maxX: number; minY: number; maxY: number }[] {
        const PASSO = 8;
        const cols = Math.ceil(HALF_WORLD_WIDTH / PASSO);
        const rows = Math.ceil(WORLD_HEIGHT / PASSO);
        const ponte = new Uint8Array(cols * rows);

        for (let cy = 0; cy < rows; cy++) {
            for (let cx = 0; cx < cols; cx++) {
                if (world.mask.isBridge(cx * PASSO, cy * PASSO)) ponte[cy * cols + cx] = 1;
            }
        }

        const visto = new Uint8Array(cols * rows);
        const fila: number[] = [];
        const caixas: { minX: number; maxX: number; minY: number; maxY: number }[] = [];

        for (let inicio = 0; inicio < ponte.length; inicio++) {
            if (!ponte[inicio] || visto[inicio]) continue;

            fila.length = 0;
            fila.push(inicio);
            visto[inicio] = 1;
            const caixa = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };

            for (let i = 0; i < fila.length; i++) {
                const atual = fila[i];
                const cx = atual % cols;
                const cy = (atual / cols) | 0;
                caixa.minX = Math.min(caixa.minX, cx * PASSO);
                caixa.maxX = Math.max(caixa.maxX, cx * PASSO);
                caixa.minY = Math.min(caixa.minY, cy * PASSO);
                caixa.maxY = Math.max(caixa.maxY, cy * PASSO);

                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nx = cx + dx;
                    const ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
                    const v = ny * cols + nx;
                    if (!ponte[v] || visto[v]) continue;
                    visto[v] = 1;
                    fila.push(v);
                }
            }
            caixas.push(caixa);
        }

        assert.ok(
            caixas.length > 0,
            "a máscara não tem ponte pintada — rode `npm run paint:bridges` e `npm run sync:mask`",
        );
        return caixas;
    }

    /**
     * Empurra o ator numa direção por `ticks` ticks, olhando a cada um.
     *
     * A sequência é um contador que NUNCA reinicia: `World.setInput` descarta
     * pacote com sequência já processada, então recomeçar do 1 a cada trecho
     * faria o servidor ignorar a nova direção e seguir com a anterior — um
     * teste verde medindo a coisa errada.
     */
    let seqEmpurra = 0;
    function empurra(
        world: World, actor: Actor, dx: number, dy: number, ticks: number,
        olho?: () => void,
    ): void {
        for (let t = 0; t < ticks; t++) {
            world.setInput(actor, dx, dy, ++seqEmpurra);
            actor.lastInputAt = world.now;
            world.tick(TICK_MS);
            olho?.();
        }
    }

    it("a ponte é chão de verdade: caminhável, e não é água", () => {
        const world = new World();

        for (const t of achaTabuleiros(world)) {
            const cx = (t.minX + t.maxX) / 2;
            const cy = (t.minY + t.maxY) / 2;

            assert.strictEqual(world.mask.isBridge(cx, cy), true, "o meio do tabuleiro é ponte");
            assert.strictEqual(world.mask.isWalkable(cx, cy), true, "a ponte é caminhável");
            assert.strictEqual(world.mask.isWater(cx, cy), false, "a ponte não é água");

            // A metade direita é o espelho: a mesma ponte existe lá, com a
            // mesma classe. É isso que faz UMA regra valer para as DUAS.
            const espelhado = WORLD_WIDTH - 1 - cx;
            assert.strictEqual(
                world.mask.isBridge(espelhado, cy), true,
                "a ponte espelhada também é ponte",
            );
        }
    });

    it("na ponte anda-se a 100%: ela não herda o freio da água", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        const offset = alturaCentro(actor);

        // Em terra firme, a referência.
        actor.teleport(LIVRE_X, LIVRE_Y);
        world.setInput(actor, 1, 0, 1);
        actor.lastInputAt = world.now;
        const antesTerra = actor.x;
        world.tick(TICK_MS);
        const naTerra = actor.x - antesTerra;

        for (const t of achaTabuleiros(world)) {
            const cy = (t.minY + t.maxY) / 2;
            actor.teleport((t.minX + t.maxX) / 2, cy - offset);

            world.setInput(actor, 1, 0, 2);
            actor.lastInputAt = world.now;
            const antes = actor.x;
            world.tick(TICK_MS);
            const naPonte = actor.x - antes;

            assert.ok(
                Math.abs(naPonte / naTerra - 1) < 0.02,
                `na ponte andou ${(naPonte / naTerra).toFixed(2)} do normal ` +
                `— a ponte pegou o ${WATER_SPEED_FACTOR} da água`,
            );
        }
    });

    it("quem vem pelo rio não sobe no meio da ponte, e não fica preso na lateral", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        const offset = alturaCentro(actor);
        let lateraisTestadas = 0;

        // O resgate é a última linha de defesa e NÃO pode ser o que segura
        // quem empurra o parapeito: se ele aparecer aqui, a colisão travou —
        // é o mesmo espião do teste da travessia do rio.
        const proto = CollisionMask.prototype as unknown as {
            nearestFree: (...args: unknown[]) => unknown;
        };
        const original = proto.nearestFree;
        let resgates = 0;
        proto.nearestFree = function (this: unknown, ...args: unknown[]) {
            resgates++;
            return original.apply(this, args);
        };

        try {
            for (const t of achaTabuleiros(world)) {
                const cx = (t.minX + t.maxX) / 2;

                // As LATERAIS do tabuleiro são os lados que dão na água; as
                // cabeceiras dão na terra. Quem decide é a máscara, lado a lado.
                for (const lado of [-1, 1]) {
                    const foraY = lado < 0 ? t.minY - 40 : t.maxY + 40;
                    if (!world.mask.isWater(cx, foraY)) continue;
                    if (!world.mask.canStand(cx, foraY, actor.collisionRx, actor.collisionRy)) continue;

                    lateraisTestadas++;
                    actor.teleport(cx, foraY - offset);

                    let subiu = 0;
                    const ys: number[] = [];
                    empurra(world, actor, 0, -lado, 120, () => {
                        const centro = actor.ellipseCenter();
                        if (world.mask.isBridge(centro.x, centro.y)) subiu++;
                        ys.push(actor.y);
                    });

                    const centro = actor.ellipseCenter();
                    assert.strictEqual(
                        subiu, 0,
                        `entrou na ponte pela lateral vindo do rio (${subiu} ticks em cima do tabuleiro)`,
                    );
                    assert.ok(
                        lado < 0 ? centro.y < t.minY : centro.y > t.maxY,
                        `atravessou o parapeito: centro em y=${centro.y.toFixed(0)}`,
                    );

                    // Encostado, a posição fica PARADA: nada de tremor de ida e
                    // volta contra a lateral, que seria o sintoma do resgate
                    // brigando com a entrada.
                    const parado = ys.slice(-20);
                    const amplitude = Math.max(...parado) - Math.min(...parado);
                    assert.ok(
                        amplitude < 0.5,
                        `tremeu ${amplitude.toFixed(2)} px encostado no parapeito`,
                    );

                    // Nadar RENTE ao parapeito continua funcionando: o passo
                    // diagonal desliza pela lateral em vez de parar seco.
                    const antesX = actor.x;
                    empurra(world, actor, 1, -lado, 20);
                    assert.ok(
                        actor.x - antesX > 20,
                        `não deslizou ao longo do parapeito: andou ${(actor.x - antesX).toFixed(1)} px`,
                    );
                }
            }
        } finally {
            proto.nearestFree = original;
        }

        assert.ok(lateraisTestadas > 0, "nenhuma lateral de ponte dá na água — o teste não mediu nada");
        assert.strictEqual(resgates, 0, `o resgate foi acionado ${resgates}x no parapeito`);
    });

    it("pela cabeceira atravessa a ponte inteira e sai do outro lado", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");
        const offset = alturaCentro(actor);

        for (const t of achaTabuleiros(world)) {
            const cy = (t.minY + t.maxY) / 2;

            // Cabeceira: o lado que dá na TERRA (nem água nem ponte).
            const entrada = t.minX - 60;
            assert.strictEqual(world.mask.isWater(entrada, cy), false, "a cabeceira é terra");
            assert.strictEqual(world.mask.isBridge(entrada, cy), false, "a cabeceira ainda não é ponte");
            assert.ok(
                world.mask.canStand(entrada, cy, actor.collisionRx, actor.collisionRy),
                "a partida tem de ser chão livre",
            );

            actor.teleport(entrada, cy - offset);

            let noTabuleiro = 0;
            empurra(world, actor, 1, 0, 200, () => {
                const centro = actor.ellipseCenter();
                if (world.mask.isBridge(centro.x, centro.y)) noTabuleiro++;
            });

            assert.ok(noTabuleiro > 0, "não passou pelo tabuleiro em momento algum");
            assert.ok(
                actor.ellipseCenter().x > t.maxX,
                `não saiu do outro lado: parou em x=${actor.x.toFixed(0)} (ponte até ${t.maxX})`,
            );
        }
    });

    it("o bot não vê passagem do rio para o meio da ponte, e a travessia continua existindo", () => {
        const world = new World();
        const actor = world.addPlayer("a", "ally", "A");

        for (const t of achaTabuleiros(world)) {
            const cx = (t.minX + t.maxX) / 2;
            const cy = (t.minY + t.maxY) / 2;

            const rio = { x: cx, y: t.minY - 40 };
            if (!world.mask.isWater(rio.x, rio.y)) continue;

            assert.strictEqual(
                world.nav.hasLineOfSight(rio.x, rio.y, cx, cy, actor.collisionRx, actor.collisionRy),
                false,
                "o bot achou reta livre do rio para o meio da ponte",
            );

            // E o caminho de verdade continua lá: sair do rio, chegar a uma
            // cabeceira e atravessar.
            const oeste = { x: t.minX - 60, y: cy };
            const leste = { x: t.maxX + 60, y: cy };

            assert.strictEqual(
                world.nav.canReach(oeste.x, oeste.y, leste.x, leste.y), true,
                "as duas cabeceiras deixaram de se enxergar — a ponte virou barreira",
            );
            assert.ok(
                world.nav.findPath(oeste.x, oeste.y, leste.x, leste.y, actor.collisionRx, actor.collisionRy),
                "o A* não acha mais rota atravessando a ponte",
            );
            assert.strictEqual(
                world.nav.canReach(rio.x, rio.y, leste.x, leste.y), true,
                "quem está no rio não chega mais à outra margem",
            );
        }
    });

    it("nem sendo empurrado por outro personagem se entra na ponte pela lateral", () => {
        const world = new World();
        const empurrado = world.addPlayer("a", "ally", "A");
        const empurrador = world.addPlayer("b", "ally", "B");
        const offset = alturaCentro(empurrado);

        for (const t of achaTabuleiros(world)) {
            const cx = (t.minX + t.maxX) / 2;

            // Os dois na água, o de trás colado: a separação entre personagens
            // empurra o da frente CONTRA a lateral do tabuleiro. Ela escreve
            // posição direto, sem passar pelo `resolveMove` — é o caminho que a
            // revalidação do tick precisa cobrir.
            const frente = t.minY - 8;
            const atras = t.minY - 30;
            if (!world.mask.isWater(cx, frente) || !world.mask.isWater(cx, atras)) continue;

            empurrado.teleport(cx, frente - offset);
            empurrador.teleport(cx, atras - offset);

            let subiu = 0;
            for (let i = 0; i < 60; i++) {
                world.tick(TICK_MS);
                const centro = empurrado.ellipseCenter();
                if (world.mask.isBridge(centro.x, centro.y)) subiu++;
            }

            assert.strictEqual(subiu, 0, "a separação entre personagens furou o parapeito");
        }
    });

    it("o bot que está no rio contorna até a cabeceira em vez de subir pela lateral", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const alvo = world.addPlayer("p", "enemy", "Alvo");
        alvo.invulnUntil = Number.MAX_SAFE_INTEGER;

        for (const t of achaTabuleiros(world)) {
            const cx = (t.minX + t.maxX) / 2;
            const cy = (t.minY + t.maxY) / 2;
            const offset = alturaCentro(bot);

            const rioY = t.minY - 40;
            if (!world.mask.isWater(cx, rioY)) continue;
            if (!world.mask.canStand(cx, rioY, bot.collisionRx, bot.collisionRy)) continue;

            // Bot no rio, colado na lateral da ponte; alvo na margem oposta,
            // na altura do tabuleiro. A subida lateral seria o caminho curto.
            bot.teleport(cx, rioY - offset);
            alvo.teleport(t.maxX + 120, cy - offset);

            let anterior = bot.ellipseCenter();
            let subiuDaAgua = 0;
            let cruzou = false;

            for (let i = 0; i < 900 && !cruzou; i++) {
                world.tick(TICK_MS);
                const centro = bot.ellipseCenter();
                if (world.mask.isBridge(centro.x, centro.y)
                    && world.mask.isWater(anterior.x, anterior.y)) subiuDaAgua++;
                anterior = centro;
                if (centro.x > t.maxX) cruzou = true;
            }

            assert.strictEqual(subiuDaAgua, 0, "o bot subiu na ponte direto da água");
            assert.ok(cruzou, `o bot ficou preso em (${bot.x.toFixed(0)}, ${bot.y.toFixed(0)})`);
        }
    });

    it("bot travado escolhe uma saída que a máscara aprova", () => {
        const world = new World();
        const bot = world.addBot("ally");
        const alvo = world.addPlayer("b", "enemy", "B");

        // Encosta o bot numa parede, com o alvo do outro lado dela.
        let parede: { x: number; y: number } | undefined;
        for (let y = 400; y < WORLD_HEIGHT - 400 && !parede; y += 32) {
            for (let x = 300; x < HALF_WORLD_WIDTH - 300; x += 32) {
                const alturaCentro = bot.rank.size.height / 2 - bot.collisionRx + (bot.collisionRy * 4) / 3;
                if (!world.mask.canStand(x, y + alturaCentro, bot.collisionRx, bot.collisionRy)) continue;
                if (world.mask.canStand(x + 96, y + alturaCentro, bot.collisionRx, bot.collisionRy)) continue;
                parede = { x, y };
                break;
            }
        }
        assert.ok(parede, "não achei uma parede para encostar o bot");

        bot.teleport(parede!.x, parede!.y);
        alvo.teleport(parede!.x + 260, parede!.y);

        // Deixa o relógio da sala andar e então marca o bot como "está aqui há
        // uma janela inteira": é o estado que `checkStuck` enxerga em quem
        // passou o tempo todo empurrando a parede.
        advance(world, BOT_STUCK_CHECK_MS);
        bot.teleport(parede!.x, parede!.y);
        bot.progressX = bot.x;
        bot.progressY = bot.y;
        bot.progressAt = world.now - BOT_STUCK_CHECK_MS - 1;
        world.tick(TICK_MS);

        const centro = bot.ellipseCenter();
        const destinoX = centro.x + Math.cos(bot.unstickAngle) * 64;
        const destinoY = centro.y + Math.sin(bot.unstickAngle) * 64;

        assert.ok(bot.unstickUntil > 0, "a travada devia ter sido detectada");
        assert.ok(
            world.nav.hasLineOfSight(centro.x, centro.y, destinoX, destinoY, bot.collisionRx, bot.collisionRy),
            "a saída escolhida bate na parede",
        );
    });

    it("o time vence ao bater o limite de abates, e a partida congela", () => {
        const world = new World();
        world.killLimit = 3;

        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");

        for (let i = 0; i < 3; i++) {
            target.currentHealth = 1;
            target.invulnUntil = 0;
            placeSideBySide(attacker, target);
            swing(world, attacker);
            // Espera o gate do golpe seguinte, não um número solto: eram 300 ms
            // cravados, que davam certo enquanto a cadência era só windup +
            // recuperação (220 ms) e passaram a engolir um dos três abates
            // quando ATTACK_INTERVAL entrou.
            advance(world, ATTACK_INTERVAL + TICK_MS);
            if (!target.alive) target.teleport(LIVRE_X + 110, LIVRE_Y);
            target.alive = true;
        }

        assert.strictEqual(world.teamKills.ally, 3, "o placar do time conta os abates");
        assert.strictEqual(world.winner, "ally");

        // Congelada: nem o relógio anda, então nada se move nem renasce.
        const now = world.now;
        const x = attacker.x;
        attacker.inputDx = 1;
        advance(world, 500);

        assert.strictEqual(world.now, now, "a simulação parou");
        assert.strictEqual(attacker.x, x, "ninguém anda depois do fim");
    });

    it("sem limite de abates a partida não acaba", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");

        for (let i = 0; i < 3; i++) {
            target.currentHealth = 1;
            target.invulnUntil = 0;
            placeSideBySide(attacker, target);
            swing(world, attacker);
            advance(world, ATTACK_INTERVAL + TICK_MS);
            target.alive = true;
        }

        assert.strictEqual(world.teamKills.ally, 3);
        assert.strictEqual(world.winner, null, "killLimit 0 = sem condição de vitória");
    });

    it("o abate continua contando para o time depois que o jogador sai", () => {
        const world = new World();
        world.killLimit = 5;

        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");

        target.currentHealth = 1;
        target.invulnUntil = 0;
        placeSideBySide(attacker, target);
        swing(world, attacker);
        advance(world, 300);

        world.remove(attacker.id);

        assert.strictEqual(world.teamKills.ally, 1, "o placar é do time, não do ator");
    });

    it("o modo de jogo aceita só os valores oficiais", () => {
        for (const modo of GAME_MODES) {
            assert.strictEqual(sanitizeGameMode(modo), modo);
        }

        for (const lixo of [
            "deathmatch", "TEAM_DEATHMATCH", "", null, undefined, 3, {}, [], true,
            "__proto__", "constructor",
        ]) {
            assert.strictEqual(
                sanitizeGameMode(lixo), DEFAULT_GAME_MODE,
                `valor ${JSON.stringify(lixo)} devia cair no padrão`,
            );
        }
    });

    // -----------------------------------------------------------------------
    // ATAQUE DIRECIONAL E ATAQUE CONTÍNUO
    // -----------------------------------------------------------------------

    /** Manda um pacote de entrada com movimento e mira. */
    function entrada(
        world: World, actor: Actor,
        dx: number, dy: number, ax: number, ay: number,
    ): void {
        world.setInput(actor, dx, dy, actor.inputSeq + 1, ax, ay);
    }

    it("a direção do golpe é o ângulo do vetor, sem encaixe em oito", () => {
        // Regressão da limitação antiga: a mira era encaixada no múltiplo de
        // 45° mais próximo, então 20° e 30° saíam os DOIS como 45°.
        for (const grausW of [0, 5, 20, 33, 47, 91, 179, -12, -100]) {
            const rad = (grausW * Math.PI) / 180;
            const ang = attackAimAngle(Math.cos(rad), Math.sin(rad), false);
            assert.ok(
                Math.abs(Math.atan2(Math.sin(ang - rad), Math.cos(ang - rad))) < 1e-9,
                `${grausW}° virou ${(ang * 180) / Math.PI}°`,
            );
        }

        // Vetores vizinhos NÃO podem colapsar na mesma direção.
        const a = attackAimAngle(Math.cos(0.35), Math.sin(0.35), false);
        const b = attackAimAngle(Math.cos(0.36), Math.sin(0.36), false);
        assert.notStrictEqual(a, b, "duas miras distintas viraram a mesma direção");

        // Sentido do mundo: leste é 0 e o Y da tela cresce para BAIXO.
        assert.strictEqual(attackAimAngle(1, 0, false), 0, "leste");
        assert.strictEqual(attackAimAngle(0, 1, false), Math.PI / 2, "sul");
        assert.strictEqual(attackAimAngle(0, -1, false), -Math.PI / 2, "norte");

        // Sem mira (zona morta, vetor nulo ou lixo) manda o `flipX`.
        assert.strictEqual(attackAimAngle(0, 0, false), 0, "sem mira, virado ao leste");
        assert.strictEqual(attackAimAngle(0, 0, true), Math.PI, "sem mira, virado ao oeste");
        assert.strictEqual(attackAimAngle(NaN, 1, false), 0, "mira inválida vira fallback");
        assert.strictEqual(
            attackAimAngle(Infinity, Infinity, true), Math.PI,
            "mira infinita vira fallback",
        );
    });

    it("o golpe sai numa direção INTERMEDIÁRIA às oito antigas", () => {
        // O caso do pedido: mira a ~20° acima da horizontal. Com o encaixe
        // antigo isso viraria leste (0°) e o alvo a 20° escaparia.
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const alvo = world.addPlayer("b", "enemy", "B");

        const rad = (-20 * Math.PI) / 180; // 20° ACIMA (Y cresce para baixo)
        const dist = 120;
        attacker.teleport(FORA_X, FORA_Y);
        alvo.teleport(FORA_X + Math.cos(rad) * dist, FORA_Y + Math.sin(rad) * dist);
        alvo.invulnUntil = 0;

        entrada(world, attacker, 0, 0, Math.cos(rad), Math.sin(rad));
        swing(world, attacker);

        assert.ok(
            Math.abs(attacker.atkAngle - rad) < 1e-6,
            `a direção congelada devia ser ${rad}, veio ${attacker.atkAngle}`,
        );

        advance(world, 300);
        assert.ok(
            alvo.currentHealth < alvo.maxHealth,
            "o alvo na direção exata da mira devia ter sido atingido",
        );
    });

    it("o golpe sai na direção da mira, e não para onde o personagem anda", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");

        // Um inimigo ACIMA e um à DIREITA, os dois ao alcance do peão.
        const acima = world.addPlayer("b", "enemy", "B");
        const direita = world.addPlayer("c", "enemy", "C");

        attacker.teleport(FORA_X, FORA_Y);
        acima.teleport(FORA_X, FORA_Y - 95);
        direita.teleport(FORA_X + 110, FORA_Y);
        acima.invulnUntil = 0;
        direita.invulnUntil = 0;

        // Anda para a direita, mira para o NORTE — o caso do pedido: movimento
        // numa direção, golpe em outra.
        entrada(world, attacker, 1, 0, 0, -1);
        swing(world, attacker);
        advance(world, 300);

        assert.ok(
            acima.currentHealth < acima.maxHealth,
            "quem estava na direção da mira devia ter levado o golpe",
        );
        assert.strictEqual(
            direita.currentHealth, direita.maxHealth,
            "quem estava na direção do MOVIMENTO não devia ser atingido",
        );
    });

    it("sem mira o golpe continua saindo pelo lado que a peça olha", () => {
        // Regressão do comportamento antigo: teclado e bots não escrevem mira
        // nenhuma, e para eles nada pode ter mudado.
        for (const flip of [false, true]) {
            const world = new World();
            const attacker = world.addPlayer("a", "ally", "A");
            const target = world.addPlayer("b", "enemy", "B");

            attacker.teleport(FORA_X, FORA_Y);
            target.teleport(FORA_X + (flip ? -110 : 110), FORA_Y);
            target.invulnUntil = 0;
            attacker.flipX = flip;

            swing(world, attacker);
            advance(world, 300);

            assert.ok(
                target.currentHealth < target.maxHealth,
                `com flipX=${flip} o golpe devia sair para esse lado`,
            );
            assert.strictEqual(
                attacker.atkAngle, flip ? Math.PI : 0,
                "sem mira a direção é leste ou oeste, como antes",
            );
        }
    });

    it("mira dentro da zona morta não conta como direção", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const acima = world.addPlayer("b", "enemy", "B");

        attacker.teleport(FORA_X, FORA_Y);
        acima.teleport(FORA_X, FORA_Y - 95);
        acima.invulnUntil = 0;

        // Um encostão no controle: aponta para o norte, mas fraco demais.
        entrada(world, attacker, 0, 0, 0, -(ATTACK_AIM_DEADZONE / 2));
        swing(world, attacker);
        advance(world, 300);

        assert.strictEqual(attacker.atkAngle, 0, "devia ter caído no fallback (leste)");
        assert.strictEqual(
            acima.currentHealth, acima.maxHealth,
            "golpe no fallback não pode acertar quem está ao norte",
        );
    });

    it("o golpe radial não muda com a mira", () => {
        // Torre, bispo e rainha pegam em volta: a direção não pode alterá-los.
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");
        attacker.setRank("TOWER");
        attacker.maxHealth = attacker.rank.health;
        attacker.currentHealth = attacker.maxHealth;

        attacker.teleport(FORA_X, FORA_Y);
        target.teleport(FORA_X, FORA_Y - 95);
        target.invulnUntil = 0;

        // Mira para o SUL, alvo ao NORTE: o círculo pega igual.
        entrada(world, attacker, 0, 0, 0, 1);
        swing(world, attacker);
        advance(world, 300);

        assert.ok(
            target.currentHealth < target.maxHealth,
            "o golpe em círculo devia pegar independentemente da mira",
        );
    });

    it("segurar o botão não repete o golpe: uma mira, um golpe", () => {
        // Regressão do ataque contínuo. Antes, `attackHeld` fazia o `stepPlayer`
        // chamar `startCharge` a cada tick e a mesma mira rendia um golpe por
        // `ATTACK_INTERVAL`. Hoje o golpe nasce da MENSAGEM, e a mira que o
        // gerou é consumida.
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");

        attacker.teleport(FORA_X, FORA_Y);
        target.teleport(FORA_X + 110, FORA_Y);

        // Conta quantos golpes COMEÇARAM, pela subida de `attacking`.
        let golpes = 0;
        let antes = false;

        // Mira apontada e botão segurado, exatamente como o cliente reportava.
        entrada(world, attacker, 0, 0, 1, 0);
        attacker.attackHeld = true;
        world.startCharge(attacker);

        const janela = ATTACK_INTERVAL * 4;
        for (let t = 0; t < janela; t += TICK_MS) {
            // O cliente continua mandando o MESMO arraste, sem recentrar.
            entrada(world, attacker, 0, 0, 1, 0);
            world.tick(TICK_MS);
            if (attacker.attacking && !antes) golpes++;
            antes = attacker.attacking;
            // O alvo é imortal aqui: o que se mede é a cadência, não o dano.
            target.currentHealth = target.maxHealth;
            target.invulnUntil = 0;
        }

        // O `startCharge` acima é a mensagem `"a" 1`: um golpe, e só um. O que
        // não pode existir é o segundo, o terceiro...
        assert.strictEqual(
            golpes, 1,
            `a mira devia render UM golpe; saíram ${golpes} em ${janela} ms`,
        );
        assert.strictEqual(attacker.aimDx, 0, "a mira devia ter sido consumida");
        assert.strictEqual(
            attacker.aimReady, false,
            "sem recentrar o controle, nenhuma direção nova pode ser armada",
        );
    });

    it("a mira volta a valer depois que o controle recentra", () => {
        // O outro lado da regra: recentrar e mirar de novo é um golpe novo,
        // inclusive na MESMA direção.
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const acima = world.addPlayer("b", "enemy", "B");

        // O golpe EMPURRA o alvo, então a pose é reposta antes de cada um:
        // o que se mede aqui é a direção, não o alcance.
        const posiciona = (): void => {
            attacker.teleport(FORA_X, FORA_Y);
            acima.teleport(FORA_X, FORA_Y - 95);
            acima.invulnUntil = 0;
            acima.currentHealth = acima.maxHealth;
        };

        // 1) mira ao norte -> golpe.
        posiciona();
        entrada(world, attacker, 0, 0, 0, -1);
        swing(world, attacker);
        advance(world, 300);

        assert.ok(
            acima.currentHealth < acima.maxHealth,
            "o primeiro golpe devia acertar quem está ao norte",
        );

        // 2) o mesmo arraste, sem recentrar: a mira é IGNORADA, e o golpe que o
        //    cliente insistir em pedir sai sem direção (fallback do flipX).
        entrada(world, attacker, 0, 0, 0, -1);
        assert.strictEqual(attacker.aimDx, 0, "mira não renovada não pode valer");
        assert.strictEqual(attacker.aimDy, 0, "mira não renovada não pode valer");

        advance(world, ATTACK_INTERVAL);
        posiciona();
        swing(world, attacker);
        advance(world, 300);
        assert.strictEqual(
            acima.currentHealth, acima.maxHealth,
            "sem mira nova o golpe não pode sair para o norte de novo",
        );

        // 3) controle de volta ao centro e MESMA direção outra vez: vale.
        entrada(world, attacker, 0, 0, 0, 0);
        assert.strictEqual(attacker.aimReady, true, "centrado, pode armar de novo");

        entrada(world, attacker, 0, 0, 0, -1);
        assert.ok(
            Math.abs(attacker.aimDy + 1) < 1e-9,
            "a direção nova devia ter sido aceita",
        );

        advance(world, ATTACK_INTERVAL);
        posiciona();
        swing(world, attacker);
        advance(world, 300);
        assert.ok(
            acima.currentHealth < acima.maxHealth,
            "com mira nova o golpe sai de novo, na mesma direção",
        );
    });

    it("o bot decide uma direção nova a cada golpe", () => {
        // O golpe consome a mira também para o bot; ele torna a decidir em
        // `aimAt`, antes de cada golpe. O teste move o alvo de lado entre um
        // golpe e outro: reusar a direção anterior erraria.
        const world = new World();
        const bot = world.addBot("ally");
        const target = world.addPlayer("b", "enemy", "B");

        const posiciona = (dy: number): void => {
            bot.teleport(FORA_X, FORA_Y);
            target.teleport(FORA_X, FORA_Y + dy);
            target.invulnUntil = 0;
        };

        // Primeiro golpe: alvo ao NORTE.
        posiciona(-90);
        for (let i = 0; i < 120 && target.currentHealth === target.maxHealth; i++) {
            posiciona(-90);
            world.tick(TICK_MS);
        }
        assert.ok(target.currentHealth < target.maxHealth, "o bot devia ter acertado ao norte");
        assert.ok(bot.atkAngle < 0, "o primeiro golpe saiu para cima");

        // Alvo agora ao SUL. Se a direção fosse reaproveitada, o golpe
        // continuaria indo para cima.
        target.currentHealth = target.maxHealth;
        posiciona(90);
        for (let i = 0; i < 120 && target.currentHealth === target.maxHealth; i++) {
            posiciona(90);
            world.tick(TICK_MS);
        }

        assert.ok(target.currentHealth < target.maxHealth, "o bot devia ter acertado ao sul");
        assert.ok(
            bot.atkAngle > 0,
            `o segundo golpe devia ter saído para baixo, saiu em ${bot.atkAngle}`,
        );
    });

    it("soltar o botão não deixa golpe pendente", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");

        attacker.teleport(FORA_X, FORA_Y);
        attacker.attackHeld = true;
        world.startCharge(attacker);

        // Solta e espera bem mais que um intervalo.
        attacker.attackHeld = false;
        advance(world, ATTACK_INTERVAL * 3);

        assert.strictEqual(
            attacker.attacking, false,
            "sem o botão segurado, nenhum golpe novo devia ter começado",
        );
    });

    it("cliente que emudece segurando o botão para de bater", () => {
        // Aba em segundo plano: o Phaser pausa o loop e ninguém manda mais
        // nada. Sem esta guarda o personagem ficaria batendo sozinho.
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        attacker.teleport(FORA_X, FORA_Y);

        entrada(world, attacker, 0, 0, 1, 0);
        attacker.attackHeld = true;

        advance(world, INPUT_TIMEOUT_MS + ATTACK_INTERVAL * 2);

        assert.strictEqual(attacker.attackHeld, false, "o botão devia ter sido solto");
        assert.strictEqual(attacker.aimDx, 0, "a mira devia ter sido zerada");
    });

    it("morrer solta o botão de ataque", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const killer = world.addPlayer("b", "enemy", "B");

        // O que morre é o `attacker`, então ele é o ALVO do golpe do `killer`.
        placeSideBySide(killer, attacker, FORA_X, FORA_Y);
        attacker.attackHeld = true;
        attacker.currentHealth = 1;
        attacker.invulnUntil = 0;

        swing(world, killer);
        advance(world, 300);

        assert.strictEqual(attacker.alive, false, "o alvo devia ter morrido");
        assert.strictEqual(
            attacker.attackHeld, false,
            "quem morre segurando não pode renascer batendo sozinho",
        );
    });

    it("o cliente não infla a mira: ela só escolhe a direção", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const longe = world.addPlayer("b", "enemy", "B");

        attacker.teleport(FORA_X, FORA_Y);
        // Bem além do alcance do peão (80 px de forma + os raios).
        longe.teleport(FORA_X + 400, FORA_Y);
        longe.invulnUntil = 0;

        // Mira absurda: se o módulo dela vazasse para a geometria, viraria
        // alcance de graça.
        world.setInput(attacker, 0, 0, 1, 9999, 0);
        assert.strictEqual(attacker.aimDx, 1, "o módulo da mira é limitado a 1");

        // Limitar o módulo não pode GIRAR a mira: cortando cada eixo por si,
        // (9999, 1000) viraria 45° em vez dos ~5,7° apontados.
        world.setInput(attacker, 0, 0, 2, 9999, 1000);
        assert.ok(Math.hypot(attacker.aimDx, attacker.aimDy) <= 1 + 1e-9);
        assert.ok(
            Math.abs(Math.atan2(attacker.aimDy, attacker.aimDx) - Math.atan2(1000, 9999)) < 1e-9,
            "a normalização girou a mira",
        );

        swing(world, attacker);
        advance(world, 300);

        assert.strictEqual(
            longe.currentHealth, longe.maxHealth,
            "a mira não pode aumentar o alcance do golpe",
        );
    });

    it("o bot ataca em qualquer direção, não só leste e oeste", () => {
        // Antes nenhum bot escrevia mira e todos caíam no fallback do `flipX`:
        // um alvo exatamente ao NORTE era imbatível.
        const world = new World();
        const bot = world.addBot("ally");
        const target = world.addPlayer("b", "enemy", "B");

        const posiciona = (): void => {
            bot.teleport(FORA_X, FORA_Y);
            target.teleport(FORA_X, FORA_Y - 90);
            target.invulnUntil = 0;
        };

        posiciona();
        for (let i = 0; i < 120 && target.currentHealth === target.maxHealth; i++) {
            posiciona(); // o bot anda; a pose é reposta a cada passo
            world.tick(TICK_MS);
        }

        assert.ok(
            target.currentHealth < target.maxHealth,
            "o bot devia ter acertado o alvo que está ao norte",
        );
        assert.ok(
            Math.abs(bot.atkAngle + Math.PI / 2) < 0.2,
            `o golpe do bot devia ter saído para o norte, saiu em ${bot.atkAngle}`,
        );
    });

    it("a perna do L do cavalo acompanha a direção do golpe", () => {
        const world = new World();
        const attacker = world.addPlayer("a", "ally", "A");
        const target = world.addPlayer("b", "enemy", "B");
        attacker.setRank("HORSE");
        attacker.maxHealth = attacker.rank.health;
        attacker.currentHealth = attacker.maxHealth;

        // Alvo na PONTA do L: à frente na direção da mira (norte) e deslocado
        // para o lado. Com a perna medida no eixo Y do mundo, ela apontaria
        // para o lugar errado e o golpe erraria.
        attacker.teleport(FORA_X, FORA_Y);
        target.teleport(FORA_X + 70, FORA_Y - 120);
        target.invulnUntil = 0;

        entrada(world, attacker, 0, 0, 0, -1);
        swing(world, attacker);
        advance(world, 300);

        assert.ok(
            Math.abs(attacker.atkAngle + Math.PI / 2) < 1e-9,
            "a mira era para o norte",
        );
        assert.ok(
            target.currentHealth < target.maxHealth,
            "o alvo na ponta do L devia ter sido atingido",
        );
    });
});
