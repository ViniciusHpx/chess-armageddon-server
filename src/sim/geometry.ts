/**
 * Testes de sobreposição forma-contra-elipse.
 *
 * Porte literal dos helpers estáticos de `PlayerBase` no cliente. Precisa
 * continuar idêntico: o cliente desenha a mesma geometria que estes testes
 * avaliam, e uma divergência faz o golpe acertar fora do que aparece na tela.
 */
import { clamp } from "./mathx.js";

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

export function circleOverlapsEllipse(
    circleCx: number, circleCy: number, radius: number,
    ellipseCx: number, ellipseCy: number, rx: number, ry: number,
): boolean {
    if (rx <= 0 || ry <= 0) return false;
    const dx = ellipseCx - circleCx;
    const dy = ellipseCy - circleCy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return true;

    const angle = Math.atan2(dy, dx);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const ellipseRadius = (rx * ry) / Math.sqrt((ry * cosA) ** 2 + (rx * sinA) ** 2);
    return dist <= radius + ellipseRadius;
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
