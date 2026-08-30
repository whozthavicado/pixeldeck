import type { SerializableDetectionReport } from "./types.js";
import { getUniqueSelector } from "./dom-utils.js";

/**
 * Vía declarativa de detección: el usuario ya sabe qué herramienta generó el
 * deck, así que en vez de correr las 4 estrategias de scoring probamos
 * directamente los selectores de esa herramienta. Si ninguno matchea (el
 * usuario se equivocó, o el export cambió), el caller cae a la detección
 * automática completa — nunca se falla en duro por un hint.
 */

export type SourceKind =
  | "claude-design"
  | "reveal"
  | "impress"
  | "google-slides"
  | "generic-slide-class";

export const SOURCE_KINDS: readonly SourceKind[] = [
  "claude-design",
  "reveal",
  "impress",
  "google-slides",
  "generic-slide-class",
] as const;

/**
 * Selectores por herramienta, en orden de preferencia (el primero que
 * matchee 1+ elementos gana). Alineados con `KNOWN_SIGNATURES` de
 * `strategies/known-framework-signature.ts` pero sin el umbral de 2+
 * elementos: aquí es una elección explícita del usuario.
 */
export const SELECTORS_BY_KIND: Record<SourceKind, string[]> = {
  "claude-design": [
    "x-dc section[data-label][data-screen-label]",
    "section[data-label][data-screen-label]",
    ".dc-artboard",
  ],
  reveal: [".reveal .slides > section"],
  impress: ["#impress > .step", ".impress-container > .step"],
  "google-slides": ['[id^="slide-"]', ".punch-viewer-content"],
  "generic-slide-class": [
    ".slides > .slide",
    ".deck > .slide",
    "body > .slide",
    ".slide",
  ],
};

export function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === "string" && (SOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * Corre la detección forzada dentro del documento (real o jsdom). Devuelve un
 * reporte serializable idéntico en forma al de `detectSlides`, con
 * `winningStrategy = "forced:<kind>"` y `finalConfidence` 1 cuando hay match,
 * o `slides: []` y confidence 0 cuando no — señal para que el caller haga
 * fallback.
 */
export function detectSlidesForced(document: Document, kind: SourceKind): SerializableDetectionReport {
  const selectors = SELECTORS_BY_KIND[kind] ?? [];

  for (const selector of selectors) {
    let matches: Element[];
    try {
      matches = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    if (matches.length >= 1) {
      return {
        winningStrategy: `forced:${kind}`,
        finalConfidence: 1,
        slides: matches.map((el, index) => ({ index, selector: getUniqueSelector(el) })),
        allResults: [
          {
            strategyName: `forced:${kind}`,
            confidence: 1,
            slideCount: matches.length,
            reason: `Hint del usuario "${kind}": ${matches.length} elemento(s) vía "${selector}".`,
          },
        ],
      };
    }
  }

  return {
    winningStrategy: null,
    finalConfidence: 0,
    slides: [],
    allResults: [
      {
        strategyName: `forced:${kind}`,
        confidence: 0,
        slideCount: 0,
        reason: `Hint del usuario "${kind}" no matcheó ningún elemento (${selectors.join(", ")}). Se usará detección automática.`,
      },
    ],
  };
}

/**
 * Trata la raíz del deck como una única "slide" — para `contentShape`
 * `single-page` (poster/portada) y `long-scroll` (página larga). Elige el
 * contenedor más específico disponible; cae a `<body>`.
 */
export function detectSingleRoot(document: Document): SerializableDetectionReport {
  const candidates = [
    "x-dc",
    "[data-deck-root]",
    "main",
    ".deck",
    ".slides",
    "#app > *:only-child",
  ];

  let root: Element | null = null;
  for (const selector of candidates) {
    try {
      root = document.querySelector(selector);
    } catch {
      root = null;
    }
    if (root) break;
  }
  root = root ?? document.body ?? document.documentElement;

  const selector = root === document.body ? "body" : getUniqueSelector(root);

  return {
    winningStrategy: "forced:single-root",
    finalConfidence: 1,
    slides: [{ index: 0, selector }],
    allResults: [
      {
        strategyName: "forced:single-root",
        confidence: 1,
        slideCount: 1,
        reason: `contentShape de página única: raíz "${selector}" tratada como una sola slide.`,
      },
    ],
  };
}
