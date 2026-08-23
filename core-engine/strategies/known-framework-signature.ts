import type { DetectionStrategy, StrategyResult } from "../types.js";

/**
 * Firma de un framework/herramienta conocida: un selector CSS que identifica
 * sus slides de forma casi inequívoca, y la confianza a asignar si matchea.
 * Se mantiene como tabla de datos (no if/else) para que agregar soporte a
 * una herramienta nueva sea una línea, no una rama de lógica nueva.
 */
interface FrameworkSignature {
  name: string;
  selector: string;
  /** Confianza si el selector matchea 2+ elementos. */
  confidence: number;
}

const KNOWN_SIGNATURES: FrameworkSignature[] = [
  // Reveal.js: estructura muy estable y específica de esta librería.
  { name: "reveal.js", selector: ".reveal .slides > section", confidence: 0.97 },
  // Impress.js: cada "step" es una slide.
  { name: "impress.js", selector: "#impress > .step, .impress-container > .step", confidence: 0.93 },
  // Claude Design (Claude Artifacts canvas): artboards con clase .dc-artboard.
  { name: "claude-design", selector: ".dc-artboard", confidence: 0.93 },
  // Google Slides exportado a HTML estático suele envolver cada slide en
  // un contenedor con clase "punch-viewer-content" o similar por página.
  { name: "google-slides-export", selector: '[id^="slide-"], .punch-viewer-content', confidence: 0.7 },
  // Patrón genérico muy común en decks generados por IA: contenedor con
  // clase .slide o .slide-container como hijos directos de un wrapper.
  { name: "generic-.slide-class", selector: ".slides > .slide, .deck > .slide, body > .slide", confidence: 0.8 },
];

export const knownFrameworkSignatureStrategy: DetectionStrategy = {
  name: "known-framework-signature",

  detect(document: Document): StrategyResult {
    for (const signature of KNOWN_SIGNATURES) {
      const matches = Array.from(document.querySelectorAll<HTMLElement>(signature.selector));
      if (matches.length >= 2) {
        return {
          strategyName: this.name,
          confidence: signature.confidence,
          slides: matches,
          reason: `Firma de "${signature.name}" reconocida (${matches.length} elementos vía "${signature.selector}").`,
        };
      }
    }

    return {
      strategyName: this.name,
      confidence: 0,
      slides: [],
      reason: "Ninguna firma de framework/herramienta conocida coincidió.",
    };
  },
};
