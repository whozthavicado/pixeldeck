/**
 * Presupuesto de tiempo por conversión.
 *
 * Vive en su propio módulo (en vez de como constantes sueltas dentro de
 * capture-engine) para poder probarlo sin arrancar un navegador: la
 * regresión que motivó extraerlo — un default fijo que desactivaba en
 * silencio el auto-escalado — era invisible salvo con un deck lo bastante
 * grande como para superar el límite viejo.
 */

// Arranque del navegador + carga + detección, más un margen por slide con
// holgura sobre el rendimiento real (~2.5 s/slide en portátil, ~5 s dentro
// de un contenedor virtualizado).
export const TIMEOUT_BASE_MS = 45_000;
export const TIMEOUT_PER_SLIDE_MS = 10_000;
export const TIMEOUT_MAX_MS = 15 * 60_000;

/** Presupuesto para un deck de `slideCount` diapositivas. */
export function computeAutoTimeout(slideCount: number): number {
  return Math.min(TIMEOUT_MAX_MS, TIMEOUT_BASE_MS + slideCount * TIMEOUT_PER_SLIDE_MS);
}

/**
 * Resuelve el presupuesto final: respeta el valor explícito del caller si
 * lo hay, y si no calcula uno a partir del tamaño del deck.
 */
export function resolveTimeoutBudget(explicitTimeoutMs: number | undefined, slideCount: number): number {
  return explicitTimeoutMs ?? computeAutoTimeout(slideCount);
}
