import type { DetectionStrategy, StrategyResult } from "../types.js";

/**
 * Firma de un framework/herramienta conocida: un selector CSS que identifica
 * sus slides de forma casi inequívoca, y la confianza a asignar si matchea.
 * Se mantiene como tabla de datos (no if/else) para que agregar soporte a
 * una herramienta nueva sea una línea, no una rama de lógica nueva.
 */
export interface FrameworkSignature {
  name: string;
  selector: string;
  /** Confianza si el selector matchea 2+ elementos. */
  confidence: number;
}

export const KNOWN_SIGNATURES: FrameworkSignature[] = [
  // Reveal.js: estructura muy estable y específica de esta librería.
  { name: "reveal.js", selector: ".reveal .slides > section", confidence: 0.97 },
  // Impress.js: cada "step" es una slide.
  { name: "impress.js", selector: "#impress > .step, .impress-container > .step", confidence: 0.93 },
  // Claude Design (Claude Artifacts canvas, formato "deck-stage"): cada
  // slide es un <section data-label="..." data-screen-label="NN"> dentro
  // de <x-dc><x-import component-from-global-scope="deck-stage">. Ni usa
  // height:100vh ni ningún framework conocido — la doble marca de datos es
  // la señal más específica y confiable disponible. Confirmado contra un
  // export real (verificado en desarrollo, no una suposición).
  { name: "claude-design-deck-stage", selector: "x-dc section[data-label][data-screen-label]", confidence: 0.96 },
  // Variante más laxa por si el wrapper <x-dc> cambia de nombre pero se
  // mantiene la convención de atributos data-label + data-screen-label.
  { name: "claude-design-deck-stage-loose", selector: "section[data-label][data-screen-label]", confidence: 0.9 },
  // Versiones anteriores/alternativas de Claude Design con artboards con
  // clase .dc-artboard (no confirmado contra un export real, se mantiene
  // como cobertura adicional de bajo riesgo).
  { name: "claude-design-artboard", selector: ".dc-artboard", confidence: 0.85 },
  // Google Slides exportado a HTML estático suele envolver cada slide en
  // un contenedor con clase "punch-viewer-content" o similar por página.
  { name: "google-slides-export", selector: '[id^="slide-"], .punch-viewer-content', confidence: 0.7 },
  // Marp: exporta cada slide como <section> hija de una raíz .marpit.
  { name: "marp", selector: ".marpit > svg > foreignObject > section, .marpit section", confidence: 0.92 },
  // Slidev (Vue): cada slide es un contenedor .slidev-page.
  { name: "slidev", selector: ".slidev-page, [id^='slide-'].slidev-page", confidence: 0.9 },
  // Gamma export: contenedores con clate data-card-id / .card-wrapper por slide.
  { name: "gamma", selector: "[data-card-id], .card-wrapper > .card", confidence: 0.82 },
  // Genially: cada "página" es un .genially-view-navigation-actions sibling
  // de contenedores .genially-view-canvas; el patrón más estable es .container-3d.
  { name: "genially", selector: ".genially-view-canvas, [data-slide-index]", confidence: 0.72 },
  // Beautiful.ai / Deck-style: .slide-container repetido.
  { name: "beautiful-ai", selector: ".slide-container, .slide-wrapper > .slide", confidence: 0.75 },
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
