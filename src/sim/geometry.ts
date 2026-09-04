/**
 * Testes de sobreposição forma-contra-elipse.
 *
 * Porte literal dos helpers estáticos de `PlayerBase` no cliente. Precisa
 * continuar idêntico: o cliente desenha a mesma geometria que estes testes
 * avaliam, e uma divergência faz o golpe acertar fora do que aparece na tela.
 */
import { clamp } from "./mathx.js";
import { AttackConfig } from "./constants.js";

export interface Rect { x: number; y: number; w: number; h: number }

export function ellipseContainsPoint(
    px: number, py: number, cx: number, cy: number, rx: number, ry: number,
): boolean {
    const dx = px - cx;
    const dy = py - cy;
    return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1.001;
}

export function rectangleOverlapsEllipse(
    rect: Rect, ellipseCx: number, ellipseCy: number, rx: number, ry: number,
): boolean {
    if (rx <= 0 || ry <= 0) return false;
    const closestX = clamp(ellipseCx, rect.x, rect.x + rect.w);
    const closestY = clamp(ellipseCy, rect.y, rect.y + rect.h);
    return ellipseContainsPoint(closestX, closestY, ellipseCx, ellipseCy, rx, ry);
}

/**
 * Raio da elipse na direção `angle`, medido do centro dela.
 *
 * Era uma expressão solta dentro de `circleOverlapsEllipse`; virou função
 * porque a origem do golpe passou a precisar dela — com o ataque preso ao eixo
 * X bastava `± rx`, e é exatamente o que ela devolve em 0 e em π.
 */
export function ellipseRadiusAt(rx: number, ry: number, angle: number): number {
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    return (rx * ry) / Math.sqrt((ry * cosA) ** 2 + (rx * sinA) ** 2);
}

export function circleOverlapsEllipse(
    circleCx: number, circleCy: number, radius: number,
    ellipseCx: number, ellipseCy: number, rx: number, ry: number,
): boolean {
    if (rx <= 0 || ry <= 0) return false;
    const dx = ellipseCx - circleCx;
    const dy = ellipseCy - circleCy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return true;

    return dist <= radius + ellipseRadiusAt(rx, ry, Math.atan2(dy, dx));
}

/**
 * Retângulo ORIENTADO contra elipse.
 *
 * Generaliza `rectangleOverlapsEllipse` para um retângulo girado, e é a única
 * peça de geometria nova que o golpe direcional pediu. A conta é a mesma de
 * sempre, num referencial diferente: leva o centro da elipse para o referencial
 * do retângulo, corta nas meias-extensões (o ponto mais próximo), volta ao
 * mundo e testa com o mesmo `ellipseContainsPoint`.
 *
 * Em ângulo 0 (ou π) `cos` é ±1 e `sin` é 0, então isto é LITERALMENTE o clamp
 * do `rectangleOverlapsEllipse`: o golpe que sai no eixo X — todo golpe de
 * teclado e todo golpe de bot — continua sendo avaliado exatamente como antes.
 *
 * @param cx,cy Centro do retângulo.
 * @param halfLength Meia extensão NA direção `angle`.
 * @param halfWidth Meia extensão na perpendicular.
 */
export function orientedRectOverlapsEllipse(
    cx: number, cy: number, halfLength: number, halfWidth: number, angle: number,
    eCx: number, eCy: number, rx: number, ry: number,
): boolean {
    if (rx <= 0 || ry <= 0) return false;

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = eCx - cx;
    const dy = eCy - cy;

    // Centro da elipse no referencial do retângulo, e o ponto do retângulo
    // mais próximo dele.
    const px = clamp(dx * cos + dy * sin, -halfLength, halfLength);
    const py = clamp(-dx * sin + dy * cos, -halfWidth, halfWidth);

    return ellipseContainsPoint(
        cx + px * cos - py * sin, cy + px * sin + py * cos, eCx, eCy, rx, ry,
    );
}

// ---------------------------------------------------------------------------
// FORMA DO GOLPE
//
// O layout da forma vive AQUI, num lugar só, e é consumido tanto pelo dano
// (`World.executeAttackHit`) quanto pelo desenho do cliente. Antes cada um
// montava a própria geometria num `switch` paralelo — cinco cópias contando os
// dois modos —, e o `CLAUDE.md` já anotava que era o ponto de divergência
// número um: dano e desenho saindo de lugares diferentes. Somar um ÂNGULO a
// cinco cópias à mão seria pedir esse bug.
//
// O cliente tem o espelho disto em `src/utils/AttackGeometry.js`.
// ---------------------------------------------------------------------------

/** Retângulo girado: `halfLength` na direção `angle`, `halfWidth` na perpendicular. */
export interface OrientedRect {
    cx: number; cy: number;
    halfLength: number; halfWidth: number;
    angle: number;
}

/**
 * Forma de um golpe, já posicionada no mundo.
 *
 * `rects` são os golpes DIRECIONAIS (peão e cavalo); `radial` são os que pegam
 * em volta do personagem (torre, bispo, rainha) e por isso não têm direção
 * nenhuma — eles não mudaram com o ataque direcional.
 */
export type AttackShape =
    | { kind: "rects"; rects: OrientedRect[] }
    | { kind: "radial"; type: "circle" | "diamond"; cx: number; cy: number; radius: number };

/**
 * Monta a forma do golpe.
 *
 * @param attack Configuração do rank (`RANKS[x].attack`).
 * @param mult Multiplicador de área da carga (`chargeAreaMult(power)`).
 * @param centerX,centerY Centro da elipse do atacante.
 * @param rx,ry Raios da elipse do atacante.
 * @param angle Direção do golpe, em radianos (`Actor.atkAngle`).
 * @param side Lado da perna do L, -1 ou 1, medido na PERPENDICULAR ao golpe.
 */
export function attackShapes(
    attack: AttackConfig, mult: number,
    centerX: number, centerY: number, rx: number, ry: number,
    angle: number, side: number,
): AttackShape {
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);

    // Origem do golpe: a borda da elipse NA DIREÇÃO do ataque. Com o golpe
    // preso ao eixo X isto era sempre `center.x ± collisionRx`, que é o que
    // `ellipseRadiusAt` devolve em 0 e em π.
    const borda = ellipseRadiusAt(rx, ry, angle);
    const startX = centerX + ux * borda;
    const startY = centerY + uy * borda;

    switch (attack.type) {
        case "rectangle": {
            const length = attack.length * mult;
            const width = attack.width * mult;
            return {
                kind: "rects",
                rects: [{
                    cx: startX + (ux * length) / 2,
                    cy: startY + (uy * length) / 2,
                    halfLength: length / 2,
                    halfWidth: width / 2,
                    angle,
                }],
            };
        }

        case "lshape": {
            const forward = attack.forwardLength * mult;
            const lado = attack.sideLength * mult;
            const width = attack.width * mult;

            // Perpendicular ao golpe. Com o golpe em X ela é o eixo Y, então a
            // perna do L cai onde caía antes.
            const px = -uy;
            const py = ux;
            const endX = startX + ux * forward;
            const endY = startY + uy * forward;

            return {
                kind: "rects",
                rects: [
                    {
                        cx: startX + (ux * forward) / 2,
                        cy: startY + (uy * forward) / 2,
                        halfLength: forward / 2,
                        halfWidth: width / 2,
                        angle,
                    },
                    {
                        cx: endX + (px * side * lado) / 2,
                        cy: endY + (py * side * lado) / 2,
                        halfLength: lado / 2,
                        halfWidth: width / 2,
                        angle: angle + Math.PI / 2,
                    },
                ],
            };
        }

        case "circle":
        case "diamond":
            // Golpes RADIAIS: pegam em volta, então a direção não os altera.
            return {
                kind: "radial",
                type: attack.type,
                cx: centerX,
                cy: centerY,
                radius: attack.radius * mult,
            };
    }
}

/** A forma do golpe encosta nesta elipse? */
export function attackShapeHitsEllipse(
    shape: AttackShape, eCx: number, eCy: number, rx: number, ry: number,
): boolean {
    if (shape.kind === "radial") {
        return shape.type === "circle"
            ? circleOverlapsEllipse(shape.cx, shape.cy, shape.radius, eCx, eCy, rx, ry)
            : diamondOverlapsEllipse(shape.cx, shape.cy, shape.radius, eCx, eCy, rx, ry);
    }

    for (const r of shape.rects) {
        if (orientedRectOverlapsEllipse(
            r.cx, r.cy, r.halfLength, r.halfWidth, r.angle, eCx, eCy, rx, ry,
        )) return true;
    }
    return false;
}

/**
 * Lado da perna do L, medido na PERPENDICULAR ao golpe.
 *
 * Com o golpe preso ao eixo X isto era só comparar o Y do alvo com o do
 * atacante — a conta antiga —, e em ângulo 0 é exatamente o que esta devolve.
 * Fora do eixo X, comparar Y do mundo mandaria a perna para o lado errado.
 */
export function attackSideFor(
    angle: number, fromX: number, fromY: number, toX: number, toY: number,
): number {
    const px = -Math.sin(angle);
    const py = Math.cos(angle);
    return (toX - fromX) * px + (toY - fromY) * py > 0 ? 1 : -1;
}

export function diamondOverlapsEllipse(
    dCx: number, dCy: number, radius: number,
    eCx: number, eCy: number, rx: number, ry: number,
): boolean {
    if (rx <= 0 || ry <= 0) return false;
    const dx = eCx - dCx;
    const dy = eCy - dCy;
    const u = dx + dy;
    const v = dx - dy;

    if (Math.abs(u) <= radius && Math.abs(v) <= radius) return true;

    const closestU = clamp(u, -radius, radius);
    const closestV = clamp(v, -radius, radius);

    const closestX = (closestU + closestV) / 2 + dCx;
    const closestY = (closestU - closestV) / 2 + dCy;

    return ellipseContainsPoint(closestX, closestY, eCx, eCy, rx, ry);
}
