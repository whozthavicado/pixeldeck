import type { DetectionReport, DetectionStrategy, StrategyResult } from "./types.js";
import { getUniqueSelector } from "./dom-utils.js";
import { ALL_STRATEGIES } from "./strategies/index.js";

/**
 * Orquestador del sistema de detección de slides por scoring.
 *
 * En vez de una cadena fija de heurísticas ("si es Reveal.js haz X, si no
 * si tiene 100vh haz Y..."), cada estrategia registrada en `ALL_STRATEGIES`
 * corre de forma independiente y devuelve una confianza 0–1. Este
 * orquestador:
 *
 *   1. Ejecuta todas las estrategias.
 *   2. Agrupa los resultados que llegaron exactamente al mismo conjunto de
 *      elementos (sin importar cuál estrategia los encontró).
 *   3. Para cada grupo, combina las confianzas individuales con una unión
 *      probabilística (`1 - Π(1 - cᵢ)`), de forma que dos estrategias
 *      débiles que coinciden en el mismo resultado suben la confianza
 *      compuesta por encima de cualquiera de ellas por separado — el
 *      "acuerdo entre heurísticas independientes" es en sí una señal.
 *   4. Elige el grupo con mayor confianza compuesta como ganador.
 *
 * @param document Documento sobre el que detectar. Puede ser el `Document`
 *   real de un navegador (Playwright, vía `page.evaluate`) o un documento
 *   de jsdom en tests — la única dependencia es la API DOM estándar.
 * @param strategies Lista de estrategias a evaluar. Por defecto, todas las
 *   registradas en `strategies/index.ts`; parametrizable para tests que
 *   quieran aislar una sola estrategia.
 */
export function detectSlides(
  document: Document,
  strategies: DetectionStrategy[] = ALL_STRATEGIES
): DetectionReport {
  const allResults = strategies.map((strategy) => runSafely(strategy, document));
  const applicable = allResults.filter((r) => r.confidence > 0 && r.slides.length > 0);

  if (applicable.length === 0) {
    return {
      winningStrategy: null,
      finalConfidence: 0,
      slides: [],
      allResults,
    };
  }

  const groups = groupByElementSet(applicable);

  let winningGroup = groups[0];
  for (const group of groups) {
    if (group.compositeConfidence > winningGroup.compositeConfidence) {
      winningGroup = group;
    }
  }

  const resolvedSlides = winningGroup.slides.map((element, index) => ({
    index,
    element,
    selector: getUniqueSelector(element),
  }));

  const winningStrategyNames = winningGroup.results.map((r) => r.strategyName).join(" + ");

  return {
    winningStrategy: winningStrategyNames,
    finalConfidence: winningGroup.compositeConfidence,
    slides: resolvedSlides,
    allResults,
  };
}

function runSafely(strategy: DetectionStrategy, document: Document): StrategyResult {
  try {
    return strategy.detect(document);
  } catch (error) {
    return {
      strategyName: strategy.name,
      confidence: 0,
      slides: [],
      reason: `La estrategia lanzó un error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface ResultGroup {
  slides: Element[];
  results: StrategyResult[];
  compositeConfidence: number;
}

/** Agrupa resultados cuyo conjunto de elementos es idéntico (mismo tamaño, mismos elementos, sin importar orden). */
function groupByElementSet(results: StrategyResult[]): ResultGroup[] {
  const groups: ResultGroup[] = [];

  for (const result of results) {
    const existing = groups.find((g) => sameElementSet(g.slides, result.slides));
    if (existing) {
      existing.results.push(result);
      existing.compositeConfidence = combineConfidences(existing.results.map((r) => r.confidence));
    } else {
      groups.push({
        slides: result.slides,
        results: [result],
        compositeConfidence: result.confidence,
      });
    }
  }

  return groups;
}

function sameElementSet(a: Element[], b: Element[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((el) => setB.has(el));
}

/** Unión probabilística: P(al menos una estrategia acierta) asumiendo independencia. */
function combineConfidences(confidences: number[]): number {
  const productOfComplements = confidences.reduce((acc, c) => acc * (1 - c), 1);
  return Math.min(0.99, 1 - productOfComplements);
}
