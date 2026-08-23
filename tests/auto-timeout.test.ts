import { describe, it, expect } from "vitest";
import { computeAutoTimeout, resolveTimeoutBudget } from "../core-engine/timeout-budget.js";

describe("presupuesto de tiempo automático", () => {
  it("crece con el número de slides", () => {
    expect(computeAutoTimeout(30)).toBeGreaterThan(computeAutoTimeout(3));
    expect(computeAutoTimeout(100)).toBeGreaterThan(computeAutoTimeout(30));
  });

  it("da a un deck de 30 slides un margen holgado sobre su tiempo real (~76s medido)", () => {
    expect(computeAutoTimeout(30)).toBeGreaterThan(150_000);
  });

  it("se corona para que un deck enorme no bloquee un worker indefinidamente", () => {
    expect(computeAutoTimeout(100_000)).toBeLessThanOrEqual(15 * 60_000);
  });

  it("respeta un timeout explícito y NO lo sustituye por el automático", () => {
    // Regresión: un default fijo en la desestructuración de opciones hacía
    // que `undefined` nunca llegara, desactivando en silencio el escalado.
    expect(resolveTimeoutBudget(5_000, 30)).toBe(5_000);
  });

  it("usa el automático cuando no se pasa timeout explícito", () => {
    expect(resolveTimeoutBudget(undefined, 30)).toBe(computeAutoTimeout(30));
  });
});
