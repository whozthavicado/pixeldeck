/**
 * Punto de entrada que se empaqueta (con esbuild, ver `bundle-detector.ts`)
 * en un único script IIFE y se inyecta en la página real vía
 * `page.addScriptTag`. Expone `window.__framewright.detectSlides()`.
 *
 * Existe porque `detectSlides` trabaja con referencias a `Element` del DOM,
 * que no son serializables a través del puente `page.evaluate` de
 * Playwright (structured clone no soporta nodos DOM anidados dentro de un
 * objeto). Este wrapper corre íntegramente DENTRO de la página y devuelve
 * únicamente datos planos (selectores ya resueltos, no elementos), que sí
 * cruzan el puente sin problema.
 */
import { detectSlides } from "./slide-detector.js";
import { detectDeckDimensions, measureEffectiveScale } from "./deck-dimensions.js";
import type { SerializableDetectionReport } from "./types.js";

function detectSlidesForBrowser(): SerializableDetectionReport {
  const report = detectSlides(document);

  return {
    winningStrategy: report.winningStrategy,
    finalConfidence: report.finalConfidence,
    slides: report.slides.map((s) => ({ index: s.index, selector: s.selector })),
    allResults: report.allResults.map((r) => ({
      strategyName: r.strategyName,
      confidence: r.confidence,
      slideCount: r.slides.length,
      reason: r.reason,
    })),
  };
}

declare global {
  interface Window {
    __framewright: {
      detectSlides: typeof detectSlidesForBrowser;
      detectDeckDimensions: typeof detectDeckDimensions;
      measureEffectiveScale: typeof measureEffectiveScale;
    };
  }
}

window.__framewright = { detectSlides: detectSlidesForBrowser, detectDeckDimensions, measureEffectiveScale };
