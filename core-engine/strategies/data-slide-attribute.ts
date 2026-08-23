import type { DetectionStrategy, StrategyResult } from "../types.js";

/**
 * Estrategia: elementos marcados explícitamente con `data-slide` (o
 * `data-slide-index`, `data-slide-id`, etc.) — la señal más inequívoca
 * posible, porque es una intención explícita del autor del HTML.
 */
export const dataSlideAttributeStrategy: DetectionStrategy = {
  name: "data-slide-attribute",

  detect(document: Document): StrategyResult {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>("[data-slide], [data-slide-index], [data-slide-id]")
    );

    if (candidates.length === 0) {
      return {
        strategyName: this.name,
        confidence: 0,
        slides: [],
        reason: "No se encontraron elementos con atributos data-slide*.",
      };
    }

    // Si hay un índice numérico explícito, ordenamos por él para respetar
    // el orden de presentación pretendido aunque el DOM esté en otro orden.
    const withIndex = candidates.map((el, domOrder) => {
      const raw = el.getAttribute("data-slide-index") ?? el.getAttribute("data-slide");
      const parsed = raw !== null ? Number.parseInt(raw, 10) : NaN;
      return { el, domOrder, explicitIndex: Number.isNaN(parsed) ? null : parsed };
    });

    const allHaveExplicitIndex = withIndex.every((c) => c.explicitIndex !== null);
    const ordered = allHaveExplicitIndex
      ? [...withIndex].sort((a, b) => (a.explicitIndex as number) - (b.explicitIndex as number))
      : withIndex;

    // Confianza alta y fija: es una señal explícita del autor, no una inferencia.
    // Baja levemente si solo hay 1 candidato (podría ser un atributo suelto,
    // no necesariamente "el sistema de slides" del documento).
    const confidence = candidates.length >= 2 ? 0.95 : 0.6;

    return {
      strategyName: this.name,
      confidence,
      slides: ordered.map((c) => c.el),
      reason: `${candidates.length} elemento(s) con data-slide* encontrados` +
        (allHaveExplicitIndex ? ", ordenados por índice explícito." : ", en orden de aparición en el DOM."),
    };
  },
};
