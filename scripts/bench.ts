/**
 * Benchmark manual: mide el pipeline de captura contra un deck real.
 * Uso: npx tsx scripts/bench.ts <sourceDir> <entryFile>
 */
import { captureDeck } from "../core-engine/capture-engine.js";
import { rm } from "node:fs/promises";

const sourceDir = process.argv[2];
const entryFile = process.argv[3];
const outputDir = "/tmp/fw-bench-output";

await rm(outputDir, { recursive: true, force: true });

const start = Date.now();
const result = await captureDeck({ sourceDir, entryFile, outputDir, timeoutMs: 600_000 });
const total = Date.now() - start;

console.log(`Estrategia: ${result.detection.winningStrategy} (${result.detection.finalConfidence.toFixed(2)})`);
console.log(`Slides: ${result.slides.length}`);
console.log(`Dimensiones: ${result.slides[0]?.widthPx}x${result.slides[0]?.heightPx}`);
console.log(`detectionMs=${result.timings.detectionMs} captureMs=${result.timings.captureMs} totalMs=${total}`);
console.log(`Promedio por slide: ${(result.timings.captureMs / result.slides.length).toFixed(0)}ms`);
