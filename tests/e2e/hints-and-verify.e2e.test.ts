import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { captureDeck } from "../../core-engine/capture-engine.js";
import { assemblePdf } from "../../core-engine/pdf-assembler.js";
import { acquireBrowser } from "../../core-engine/browser-pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");
const VIEWPORT = { width: 800, height: 400 };

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function outDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `pixeldeck-e2e-${tag}-`));
  cleanupDirs.push(dir);
  return dir;
}

describe("hints declarativos + verificación pixel-diff", () => {
  it("sourceKind=claude-design salta el scoring y usa la estrategia forzada", async () => {
    const result = await captureDeck({
      sourceDir: join(FIXTURES_DIR, "claude-design-deck"),
      outputDir: await outDir("forced"),
      viewport: VIEWPORT,
      scale: 1,
      sourceKind: "claude-design",
    });

    expect(result.slides).toHaveLength(3);
    expect(result.detection.winningStrategy).toBe("forced:claude-design");
    expect(result.detection.finalConfidence).toBe(1);
    // Solo corrió la estrategia forzada, no las 4 de scoring.
    expect(result.detection.allResults).toHaveLength(1);
  });

  it("un sourceKind equivocado cae a la detección automática sin fallar", async () => {
    const result = await captureDeck({
      sourceDir: join(FIXTURES_DIR, "js-navigated"),
      outputDir: await outDir("fallback"),
      viewport: VIEWPORT,
      scale: 1,
      sourceKind: "claude-design", // este fixture NO es deck-stage
    });
    expect(result.slides.length).toBeGreaterThanOrEqual(2);
    expect(result.detection.winningStrategy).not.toBe("forced:claude-design");
  });

  it("verifica cada slide de un deck estable (verifiedCount === slideCount)", async () => {
    const result = await captureDeck({
      sourceDir: join(FIXTURES_DIR, "claude-design-deck"),
      outputDir: await outDir("verify-ok"),
      viewport: VIEWPORT,
      scale: 1,
      sourceKind: "claude-design",
    });
    expect(result.verifiedCount).toBe(result.slides.length);
    expect(result.slides.every((s) => s.verified)).toBe(true);
  });

  it("una slide con animación infinita queda no verificada, sin lanzar error", async () => {
    const result = await captureDeck({
      sourceDir: join(FIXTURES_DIR, "unstable-animation"),
      outputDir: await outDir("verify-fail"),
      viewport: VIEWPORT,
      scale: 1,
      verify: { enabled: true, maxRetries: 1, resettleMs: 100 },
    });
    expect(result.slides).toHaveLength(2);
    expect(result.verifiedCount).toBeLessThan(result.slides.length);
  });

  it("expectedResult handout-2up produce ceil(slides/2) páginas", async () => {
    const dir = await outDir("handout");
    const result = await captureDeck({
      sourceDir: join(FIXTURES_DIR, "claude-design-deck"),
      outputDir: dir,
      viewport: VIEWPORT,
      scale: 1,
      sourceKind: "claude-design",
    });
    const pdfPath = join(dir, "out.pdf");
    await assemblePdf({
      slides: result.slides.map((s) => ({ filePath: s.filePath, widthPx: s.widthPx, heightPx: s.heightPx })),
      outputPath: pdfPath,
      layout: "handout-2up",
    });
    const pdf = await PDFDocument.load(await readFile(pdfPath));
    expect(pdf.getPageCount()).toBe(2); // 3 slides → 2 páginas
  });

  it("el pool reutiliza el mismo proceso de navegador entre conversiones", async () => {
    const a = await acquireBrowser("chromium");
    const b = await acquireBrowser("chromium");
    expect(a.browser).toBe(b.browser);
    a.release();
    b.release();
  });
});
