/**
 * Separação corpo-a-corpo pelas ELIPSES. Porte de
 * `chess-armageddon/src/utils/CollisionResolver.js` — a explicação completa do
 * truque está lá; o resumo:
 *
 * Todas as elipses têm a mesma proporção (rx = ELLIPSE_RATIO * ry), porque
 * `collisionRx/Ry` escalam a base 50x25 pelo mesmo fator (sprites quadrados).
 * Multiplicando Y por ELLIPSE_RATIO, cada elipse vira um círculo de raio
 * `collisionRx` e a separação vira um empurrão radial exato.
 *
 * Roda depois da integração da velocidade e ANTES do clamp nos limites do mapa.
 */
import { Actor } from "./Actor.js";

/** Proporção rx/ry compartilhada por todas as elipses. */
export const ELLIPSE_RATIO = 2;

/** Passes por tick — mais passes acomodam melhor aglomerados. */
const ITERATIONS = 3;

/** Fração da sobreposição corrigida por passe (< 1 suaviza o empurrão). */
const SEPARATION_STRENGTH = 0.8;

/** Sobreposição ignorada, em pixels: evita micro-correções e tremedeira. */
const OVERLAP_SLOP = 0.5;

/** Distância abaixo da qual os centros são considerados coincidentes. */
const EPSILON = 0.0001;

/** Ângulo áureo: espalha os desempates de forma determinística. */
const GOLDEN_ANGLE = 2.39996;

interface Entry {
    actor: Actor;
    index: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    radius: number;
    mass: number;
}

export function resolveCollisions(actors: Iterable<Actor>): void {
    const entries: Entry[] = [];

    for (const actor of actors) {
        if (!actor.alive) continue;
        const center = actor.ellipseCenter();
        entries.push({
            actor,
            index: entries.length,
            x: center.x,
            y: center.y * ELLIPSE_RATIO,
            startX: center.x,
            startY: center.y * ELLIPSE_RATIO,
            radius: actor.collisionRx,
            mass: actor.mass,
        });
    }

    if (entries.length < 2) return;

    for (let pass = 0; pass < ITERATIONS; pass++) {
        let separatedAny = false;

        for (let i = 0; i < entries.length - 1; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                if (separate(entries[i], entries[j])) separatedAny = true;
            }
        }

        // Nenhum par se sobrepõe: não adianta gastar os passes restantes.
        if (!separatedAny) break;
    }

    for (const entry of entries) {
        const dx = entry.x - entry.startX;
        const dy = (entry.y - entry.startY) / ELLIPSE_RATIO;
        if (dx === 0 && dy === 0) continue;
        entry.actor.x += dx;
        entry.actor.y += dy;
    }
}

/** @returns true se houve sobreposição relevante. */
function separate(a: Entry, b: Entry): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const minDist = a.radius + b.radius;
    const distSq = dx * dx + dy * dy;

    if (distSq >= minDist * minDist) return false;

    const dist = Math.sqrt(distSq);
    const overlap = minDist - dist;
    if (overlap < OVERLAP_SLOP) return false;

    let nx: number;
    let ny: number;

    if (dist > EPSILON) {
        nx = dx / dist;
        ny = dy / dist;
    } else {
        // Centros coincidentes (respawn em cima um do outro): sem direção
        // definida os dois travariam. Ângulo determinístico mantém o desempate
        // estável entre ticks.
        const angle = (a.index + b.index) * GOLDEN_ANGLE;
        nx = Math.cos(angle);
        ny = Math.sin(angle);
    }

    const push = overlap * SEPARATION_STRENGTH;

    // Cada um absorve a fração da massa DO OUTRO: o mais pesado cede menos.
    const totalMass = a.mass + b.mass;
    const aShare = b.mass / totalMass;
    const bShare = a.mass / totalMass;

    a.x -= nx * push * aShare;
    a.y -= ny * push * aShare;
    b.x += nx * push * bShare;
    b.y += ny * push * bShare;

    return true;
}
