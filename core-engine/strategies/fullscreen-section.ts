import type { DetectionStrategy, StrategyResult } from "../types.js";
import { collectInlineStylesheetText, isFullscreenHeightValue } from "../dom-utils.js";

/**
 * Estrategia: contenedores de "pantalla completa" (`height: 100vh/100dvh/...`)
 * que son hijos directos de `<body>` o de un único wrapper envolvente.
 * Es el patrón más común en decks generados por IA que no usan ningún
 * framework de slides (cada "sección" ocupa exactamente un viewport).
 *
 * Fuentes de evidencia, en orden de fiabilidad:
 *  1. Layout real (`getBoundingClientRect` vs. altura de viewport) — solo
 *     disponible cuando el documento corre dentro de un navegador real
 *     (Playwright). Es la señal más fiable porque captura CSS heredado,
 *     `calc()`, media queries, etc.
 *  2. `style` inline del propio elemento.
 *  3. Reglas declaradas en bloques `<style>` del documento, emparejadas por
 *     tag/clase/id contra el elemento (heurística de texto, no un motor CSS
 *     completo — suficiente como señal adicional, nunca como única fuente).
 */
export const fullscreenSectionStrategy: DetectionStrategy = {
  name: "fullscreen-section",

  detect(document: Document): StrategyResult {
    const container = findSlidesContainer(document);
    if (!container) {
      return {
        strategyName: this.name,
        confidence: 0,
        slides: [],
        reason: "No se encontró <body> ni un contenedor de hijos directos.",
      };
    }

    const children = Array.from(container.children).filter(isElementLike);
    if (children.length < 2) {
      return {
        strategyName: this.name,
        confidence: 0,
        slides: [],
        reason: "El contenedor candidato tiene menos de 2 hijos directos.",
      };
    }

    const stylesheetText = collectInlineStylesheetText(document);
    const viewportHeight = getViewportHeightIfAvailable(document);

    const matches: Element[] = [];
    let layoutEvidenceUsed = false;
    let staticEvidenceUsed = false;

    for (const child of children) {
      const layoutMatch = viewportHeight !== null && elementFillsViewport(child, viewportHeight);
      if (layoutMatch) layoutEvidenceUsed = true;

      const inlineMatch = isFullscreenHeightValue((child as HTMLElement).style?.height);
      const staticMatch = !inlineMatch && !layoutMatch && elementMatchedByStylesheetText(child, stylesheetText);
      if (staticMatch) staticEvidenceUsed = true;

      if (layoutMatch || inlineMatch || staticMatch) {
        matches.push(child);
      }
    }

    // Requerimos que la gran mayoría de los hijos (no solo un par) matcheen,
    // para no confundir "un par de secciones fullscreen sueltas" con "este
    // documento ES un deck de slides fullscreen".
    const matchRatio = matches.length / children.length;
    if (matchRatio < 0.6 || matches.length < 2) {
      return {
        strategyName: this.name,
        confidence: matches.length >= 2 ? 0.3 : 0,
        slides: matches,
        reason: `Solo ${matches.length}/${children.length} hijos directos tienen altura de pantalla completa.`,
      };
    }

    let confidence = layoutEvidenceUsed ? 0.9 : staticEvidenceUsed ? 0.7 : 0.5;
    if (matchRatio === 1) confidence = Math.min(1, confidence + 0.05);

    return {
      strategyName: this.name,
      confidence,
      slides: matches,
      reason: `${matches.length}/${children.length} hijos directos con altura de pantalla completa` +
        (layoutEvidenceUsed ? " (verificado por layout real)." : staticEvidenceUsed ? " (verificado por hoja de estilos)." : " (verificado por estilo inline)."),
    };
  },
};

function isElementLike(node: Element): boolean {
  // Descarta elementos de infraestructura que no son slides aunque sean
  // hijos directos de body (scripts inyectados, overlays de utilidades, etc.)
  const tag = node.tagName?.toLowerCase();
  return tag !== "script" && tag !== "style" && tag !== "link" && tag !== "noscript";
}

/**
 * Encuentra el contenedor cuyos hijos directos evaluaremos: `<body>` mismo,
 * o si `<body>` tiene un único hijo "envolvente" (patrón común: `<body><div id="app">...`),
 * bajamos un nivel hacia ese wrapper.
 */
function findSlidesContainer(document: Document): Element | null {
  const body = document.body;
  if (!body) return null;

  const meaningfulChildren = Array.from(body.children).filter(isElementLike);
  if (meaningfulChildren.length === 1) {
    return meaningfulChildren[0];
  }
  return body;
}

function getViewportHeightIfAvailable(document: Document): number | null {
  const win = document.defaultView;
  if (!win || typeof win.innerHeight !== "number" || win.innerHeight === 0) return null;
  return win.innerHeight;
}

const VIEWPORT_MATCH_TOLERANCE_PX = 4;

function elementFillsViewport(el: Element, viewportHeight: number): boolean {
  if (typeof el.getBoundingClientRect !== "function") return false;
  const rect = el.getBoundingClientRect();
  if (rect.height === 0) return false; // jsdom sin layout real devuelve 0; no es evidencia válida.
  return Math.abs(rect.height - viewportHeight) <= VIEWPORT_MATCH_TOLERANCE_PX;
}

/**
 * Heurística de texto: busca en el CSS del documento alguna regla cuyo
 * selector simple (tag, .clase o #id) coincida con el elemento y declare
 * height: 100vh (o variante). No es un parser CSS completo a propósito —
 * es una señal de apoyo, con confianza tope de 0.7.
 */
function elementMatchedByStylesheetText(el: Element, stylesheetText: string): boolean {
  if (!stylesheetText.trim()) return false;

  const candidateSelectors = [
    el.tagName.toLowerCase(),
    ...(el.id ? [`#${el.id}`] : []),
    ...Array.from(el.classList).map((c) => `.${c}`),
  ];

  const ruleBlocks = stylesheetText.split("}");
  for (const block of ruleBlocks) {
    const [selectorPart, bodyPart] = block.split("{");
    if (!selectorPart || !bodyPart) continue;
    if (!/height\s*:\s*100(vh|dvh|svh|lvh)/i.test(bodyPart)) continue;

    const selectorsInRule = selectorPart.split(",").map((s) => s.trim());
    const matchesThisElement = selectorsInRule.some((sel) =>
      candidateSelectors.some((candidate) => sel === candidate || sel.endsWith(` ${candidate}`) || sel.endsWith(`>${candidate}`))
    );
    if (matchesThisElement) return true;
  }

  return false;
}
