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
