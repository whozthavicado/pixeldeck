import type { DetectionStrategy, StrategyResult } from "../types.js";

/**
 * Estrategia: elementos con `role="tabpanel"` (o `role="region"` combinado
 * con `aria-label` que sugiera slide/section) que comparten un padre común.
 * Señal de accesibilidad relativamente confiable, pero menos inequívoca que
 * data-slide porque `tabpanel` a veces se usa para paneles que no son slides
 * de una presentación (ej. pestañas de configuración).
 */
export const ariaTabpanelStrategy: DetectionStrategy = {
  name: "aria-tabpanel",

  detect(document: Document): StrategyResult {
    const tabpanels = Array.from(document.querySelectorAll<HTMLElement>('[role="tabpanel"]'));

    if (tabpanels.length < 2) {
      return {
        strategyName: this.name,
        confidence: 0,
        slides: [],
        reason: `Se encontraron ${tabpanels.length} tabpanel(es); se requieren al menos 2 para inferir un deck.`,
      };
    }

    // Agrupamos por padre inmediato: un deck real de slides comparte contenedor.
    const groups = new Map<Element | null, HTMLElement[]>();
    for (const el of tabpanels) {
      const parent = el.parentElement;
      const group = groups.get(parent) ?? [];
      group.push(el);
      groups.set(parent, group);
    }

    let bestGroup: HTMLElement[] = [];
    for (const group of groups.values()) {
      if (group.length > bestGroup.length) bestGroup = group;
    }

    if (bestGroup.length < 2) {
      return {
        strategyName: this.name,
        confidence: 0.2,
        slides: bestGroup,
        reason: "Los tabpanel encontrados no comparten un padre común consistente.",
      };
    }

    // Confianza moderada: es una señal de accesibilidad válida, pero role="tabpanel"
    // se usa en más contextos que solo presentaciones (por eso no llega a 0.9).
    const allShareLabel = bestGroup.every((el) => el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby"));
    const confidence = allShareLabel ? 0.75 : 0.65;

    return {
      strategyName: this.name,
      confidence,
      slides: bestGroup,
      reason: `${bestGroup.length} elementos [role="tabpanel"] bajo un padre común` +
        (allShareLabel ? ", todos con aria-label/aria-labelledby." : "."),
    };
  },
};
