import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { PDFDocument } from "pdf-lib";
import { assemblePdf } from "../core-engine/pdf-assembler.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeSlides(n: number): Promise<Array<{ filePath: string; widthPx: number; heightPx: number }>> {
  const dir = await mkdtemp(join(tmpdir(), "pixeldeck-handout-"));
  dirs.push(dir);
  const slides = [];
  for (let i = 0; i < n; i++) {
    const png = new PNG({ width: 320, height: 180 });
    png.data.fill(200);
    const filePath = join(dir, `slide-${i}.png`);
    await writeFile(filePath, PNG.sync.write(png));
    slides.push({ filePath, widthPx: 1920, heightPx: 1080 });
  }
  return slides;
}

describe("assemblePdf — handout-2up", () => {
  it("5 slides → 3 páginas A4 apaisada", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pixeldeck-handout-out-"));
    dirs.push(dir);
    const out = join(dir, "h.pdf");

    const result = await assemblePdf({ slides: await makeSlides(5), outputPath: out, layout: "handout-2up" });
    expect(result.pageCount).toBe(3);

    const pdf = await PDFDocument.load(await (await import("node:fs/promises")).readFile(out));
    expect(pdf.getPageCount()).toBe(3);
    const { width, height } = pdf.getPage(0).getSize();
    expect(Math.round(width)).toBe(842);
    expect(Math.round(height)).toBe(595);
  });

  it("one-per-page sigue produciendo una página por slide", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pixeldeck-oneper-"));
    dirs.push(dir);
    const out = join(dir, "p.pdf");
    const result = await assemblePdf({ slides: await makeSlides(4), outputPath: out });
    expect(result.pageCount).toBe(4);
  });
});

describe("assemblePdf — capa de texto, índice, metadatos y determinismo", () => {
  it("dibuja la capa de texto y genera una entrada de índice por slide con etiqueta", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pixeldeck-textlayer-"));
    dirs.push(dir);
    const base = await makeSlides(3);
    const slides = base.map((s, i) => ({
      ...s,
      label: `Slide ${i + 1}`,
      textRuns: [
        { text: "Título de prueba", x: 40, y: 40, width: 400, height: 48 },
        { text: "cuerpo con acentos áéíóú ñ", x: 40, y: 120, width: 500, height: 28 },
      ],
    }));
    const out = join(dir, "t.pdf");
    const result = await assemblePdf({ slides, outputPath: out, title: "Deck de prueba" });

    expect(result.textRunCount).toBe(6); // 2 runs × 3 slides
    expect(result.outlineEntryCount).toBe(3);

    const pdf = await PDFDocument.load(await (await import("node:fs/promises")).readFile(out));
    expect(pdf.getTitle()).toBe("Deck de prueba");
  });

  it("--no-text-layer no dibuja nada de texto", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pixeldeck-notext-"));
    dirs.push(dir);
    const slides = (await makeSlides(2)).map((s) => ({
      ...s,
      textRuns: [{ text: "no debería aparecer", x: 0, y: 0, width: 100, height: 20 }],
    }));
    const result = await assemblePdf({ slides, outputPath: join(dir, "n.pdf"), textLayer: false });
    expect(result.textRunCount).toBe(0);
  });

  it("modo determinista → dos ensamblados producen bytes idénticos", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pixeldeck-det-"));
    dirs.push(dir);
    const slides = await makeSlides(2);
    const a = join(dir, "a.pdf");
    const b = join(dir, "b.pdf");
    await assemblePdf({ slides, outputPath: a, deterministic: true });
    await assemblePdf({ slides, outputPath: b, deterministic: true });
    const fs = await import("node:fs/promises");
    expect(Buffer.compare(await fs.readFile(a), await fs.readFile(b))).toBe(0);
  });
});
