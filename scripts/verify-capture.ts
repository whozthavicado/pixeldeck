/**
 * Script manual de verificación (no forma parte del pipeline de tests
 * automáticos) — corre captureDeck contra un directorio real y reporta
 * resultado + dimensiones de cada PNG generado.
 *
 * Uso: npx tsx scripts/verify-capture.ts <sourceDir> <outputDir>
 */
import { captureDeck } from "../core-engine/capture-engine.js";

const sourceDir = process.argv[2];
const outputDir = process.argv[3];

if (!sourceDir || !outputDir) {
  console.error("Uso: npx tsx scripts/verify-capture.ts <sourceDir> <outputDir>");
  process.exit(1);
}

const start = Date.now();
const result = await captureDeck({ sourceDir, outputDir });
const elapsed = Date.now() - start;

console.log(`Motor: ${result.browserEngine}`);
console.log(`Detección: ${result.detection.winningStrategy} (confianza ${result.detection.finalConfidence.toFixed(2)})`);
console.log(`Slides capturados: ${result.slides.length}`);
for (const slide of result.slides) {
  console.log(
    `  #${slide.index + 1} -> ${slide.filePath} (${slide.widthPx}x${slide.heightPx}px, estable: ${slide.stableBeforeCapture})`
  );
}
console.log(`Tiempo total: ${elapsed}ms`);
