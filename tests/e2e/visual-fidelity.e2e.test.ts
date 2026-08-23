import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureDeck, type CaptureResult } from "../../core-engine/capture-engine.js";
import { loadPng, getPixel, colorsClose, colorDistance, anyPixelInRegionMatches } from "./pixel-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");
const VIEWPORT = { width: 800, height: 400 };

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function capture(fixtureName: string): Promise<CaptureResult> {
  const outputDir = await mkdtemp(join(tmpdir(), `framewright-e2e-${fixtureName}-`));
  cleanupDirs.push(outputDir);
  return captureDeck({
    sourceDir: join(FIXTURES_DIR, fixtureName),
    outputDir,
    viewport: VIEWPORT,
    scale: 1, // simplifica la aritmética de coordenadas de los tests (1 px CSS = 1 px de imagen)
  });
}

describe("fidelidad visual end-to-end — decks reales que estresan cada falla documentada del pipeline de impresión", () => {
  it("gradient-text: background-clip:text con gradiente no se vuelve negro sólido ni desaparece", async () => {
    const result = await capture("gradient-text");
    expect(result.slides).toHaveLength(2);

    const slide1 = loadPng(result.slides[0].filePath);
    const slide2 = loadPng(result.slides[1].filePath);

    // Aislamiento correcto: cada slide muestra su propio color de fondo, sin mezcla.
    expect(colorsClose(getPixel(slide1, 5, 5), { r: 20, g: 20, b: 40, a: 255 })).toBe(true);
    expect(colorsClose(getPixel(slide2, 5, 5), { r: 180, g: 70, b: 40, a: 255 })).toBe(true);

    // El texto con gradiente debe pintar ALGÚN píxel con color real (no
    // fondo, no negro puro) dentro de su bounding box — así se ve un texto
    // roto por el pipeline de impresión (se vuelve negro sólido o invisible).
    const hasRealInk = anyPixelInRegionMatches(
      slide1,
      { x: 40, y: 100, width: 600, height: 150 },
      (p) => !colorsClose(p, { r: 20, g: 20, b: 40, a: 255 }, 20) && (p.r > 60 || p.g > 60 || p.b > 60),
      3
    );
    expect(hasRealInk).toBe(true);
  }, 30_000);

  it("box-shadow: no desaparece ni se convierte en una mancha negra sólida", async () => {
    const result = await capture("box-shadow");
    expect(result.slides).toHaveLength(2);

    const slide1 = loadPng(result.slides[0].filePath);
    const slide2 = loadPng(result.slides[1].filePath);

    expect(colorsClose(getPixel(slide1, 5, 5), { r: 255, g: 255, b: 255, a: 255 })).toBe(true);
    expect(colorsClose(getPixel(slide2, 5, 5), { r: 10, g: 80, b: 160, a: 255 })).toBe(true);

    // Justo a la izquierda de la tarjeta (que empieza en x=250) debe haber
    // halo de sombra: ni blanco puro (sombra ausente) ni negro puro (mancha).
    const hasShadowHalo = anyPixelInRegionMatches(
      slide1,
      { x: 200, y: 130, width: 45, height: 140 },
      (p) => {
        const brightness = (p.r + p.g + p.b) / 3;
        return brightness > 25 && brightness < 245;
      },
      2
    );
    expect(hasShadowHalo).toBe(true);
  }, 30_000);

  it("backdrop-filter: el blur realmente mezcla los píxeles bajo el panel (no solo desaparece)", async () => {
    const result = await capture("backdrop-filter");
    expect(result.slides).toHaveLength(2);

    const slide1 = loadPng(result.slides[0].filePath);

    // Fuera del panel, las franjas rojo/azul deben seguir totalmente nítidas.
    const outsideRed = getPixel(slide1, 50, 50);
    const outsideBlue = getPixel(slide1, 56, 50);
    const outsideDistance = colorDistance(outsideRed, outsideBlue);
    expect(outsideDistance).toBeGreaterThan(300); // rojo puro vs azul puro: distancia grande

    // Dentro del panel (glass: left 250-550, top 125-275), el blur de 16px
    // (más ancho que el período de 12px de las franjas) debe difuminarlas
    // entre sí — la distancia de color entre dos x adyacentes de distinta
    // franja debe reducirse drásticamente frente al caso "fuera del panel".
    const insideRed = getPixel(slide1, 300, 200);
    const insideBlue = getPixel(slide1, 308, 200);
    const insideDistance = colorDistance(insideRed, insideBlue);

    expect(insideDistance).toBeLessThan(outsideDistance * 0.4);
  }, 30_000);

  it("relative-assets: una imagen referenciada por ruta relativa se resuelve vía el servidor estático (no file://)", async () => {
    const result = await capture("relative-assets");
    expect(result.slides).toHaveLength(2);

    const slide1 = loadPng(result.slides[0].filePath);
    const slide2 = loadPng(result.slides[1].filePath);

    // Centro de la imagen marker.png (magenta sólido), colocada en left:100,top:100,200x200.
    expect(colorsClose(getPixel(slide1, 200, 200), { r: 230, g: 20, b: 200, a: 255 })).toBe(true);
    expect(colorsClose(getPixel(slide2, 5, 5), { r: 40, g: 40, b: 40, a: 255 })).toBe(true);
  }, 30_000);

  it("cutoff-100vh: cada slide se captura completa, sin cortarse a la mitad entre páginas", async () => {
    const result = await capture("cutoff-100vh");
    expect(result.slides).toHaveLength(3);

    for (const slide of result.slides) {
      expect(slide.heightPx).toBe(VIEWPORT.height);
      expect(slide.widthPx).toBe(VIEWPORT.width);
    }

    const expectedColors = [
      { r: 200, g: 40, b: 40, a: 255 },
      { r: 40, g: 180, b: 90, a: 255 },
      { r: 40, g: 90, b: 200, a: 255 },
    ];

    result.slides.forEach((slide, i) => {
      const png = loadPng(slide.filePath);
      const center = getPixel(png, VIEWPORT.width / 2, VIEWPORT.height / 2);
      expect(colorsClose(center, expectedColors[i])).toBe(true);
      // Ningún slide debe mostrar el color de otro (evidencia de que no se
      // capturó la región equivocada).
      for (let j = 0; j < expectedColors.length; j++) {
        if (j === i) continue;
        expect(colorsClose(center, expectedColors[j])).toBe(false);
      }
    });
  }, 30_000);

  it("js-navigated: captura las 4 slides aunque el DOM solo muestre la .is-active (display:none en las demás)", async () => {
    const result = await capture("js-navigated");
    expect(result.slides).toHaveLength(4);

    const expectedColors = [
      { r: 210, g: 30, b: 30, a: 255 },
      { r: 30, g: 210, b: 30, a: 255 },
      { r: 30, g: 30, b: 210, a: 255 },
      { r: 210, g: 210, b: 30, a: 255 },
    ];

    result.slides.forEach((slide, i) => {
      const png = loadPng(slide.filePath);
      const center = getPixel(png, VIEWPORT.width / 2, VIEWPORT.height / 2);
      expect(colorsClose(center, expectedColors[i])).toBe(true);
    });
  }, 30_000);
});
