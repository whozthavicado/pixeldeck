import { access } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { startStaticHost } from "../server/static-host.js";
import { getDetectorBundle } from "./bundle-detector.js";
import { waitForVisualStability, type StabilityOptions } from "./stability-watcher.js";
import { extractLinkAnnotations } from "./link-mapper.js";
import { SlideDetectionError, InvalidSourceError, ConversionTimeoutError, TooManySlidesError } from "./errors.js";
import type { LinkAnnotation, SerializableDetectionReport } from "./types.js";

export type BrowserEngine = "chromium" | "firefox" | "webkit";

export interface CaptureOptions {
  /** Carpeta con el HTML/CSS/JS/imágenes/fuentes ya extraídos (relativos entre sí). */
  sourceDir: string;
  /** Archivo de entrada dentro de sourceDir. Default: "index.html". */
  entryFile?: string;
  /** Carpeta donde escribir los PNG capturados, uno por slide. */
  outputDir: string;
  /** Factor de resolución (deviceScaleFactor). 2 o 3 recomendado para "alta resolución". Default: 2. */
  scale?: number;
  /** Tamaño de viewport lógico (antes de aplicar `scale`). Default: 1920x1080. */
  viewport?: { width: number; height: number };
  /** Motor de navegador de Playwright a usar. Default: "chromium". */
  browserEngine?: BrowserEngine;
  /** Confianza mínima de detección para proceder; si no se alcanza, se lanza SlideDetectionError. Default: 0.4. */
  minConfidence?: number;
  /** Overrides para el watcher de estabilidad visual (ver stability-watcher.ts). */
  stability?: StabilityOptions;
  /** Presupuesto total para toda la conversión (servidor + navegador + captura). Default: 90000ms. */
  timeoutMs?: number;
  /** Máximo de slides a aceptar. Se valida justo después de detectar, ANTES de capturar ninguna. Default: 300. */
  maxSlides?: number;
}

export interface CapturedSlide {
  index: number;
  selector: string;
  filePath: string;
  /** Ancho en px CSS lógicos (NO multiplicado por `scale`) — es el tamaño "físico" de la slide. */
  widthPx: number;
  /** Alto en px CSS lógicos (NO multiplicado por `scale`). */
  heightPx: number;
  stableBeforeCapture: boolean;
  links: LinkAnnotation[];
}

export interface CaptureResult {
  slides: CapturedSlide[];
  detection: SerializableDetectionReport;
  browserEngine: BrowserEngine;
  timings: {
    detectionMs: number;
    captureMs: number;
    totalMs: number;
  };
}

const ENGINES = { chromium, firefox, webkit } as const;

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const ISOLATE_STYLE_TAG_ID = "__framewright_isolate__";

/**
 * Pipeline completo de captura: sirve `sourceDir` por HTTP, detecta la
 * estructura de slides dentro de un navegador real, y captura cada slide
 * como PNG de alta resolución, esperando estabilidad visual antes de cada
 * captura final.
 */
export async function captureDeck(options: CaptureOptions): Promise<CaptureResult> {
  const entryFile = options.entryFile ?? "index.html";
  const scale = options.scale ?? 2;
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const browserEngine = options.browserEngine ?? "chromium";
  const minConfidence = options.minConfidence ?? 0.4;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const maxSlides = options.maxSlides ?? 300;
  const totalStart = Date.now();

  await assertEntryFileExists(options.sourceDir, entryFile);
  await mkdir(options.outputDir, { recursive: true });

  const host = await startStaticHost(options.sourceDir);
  const launcher = ENGINES[browserEngine];
  const browser: Browser = await launcher.launch();

  // Si se agota el presupuesto de tiempo, forzamos el cierre del navegador:
  // cualquier llamada de Playwright en curso (goto, evaluate, screenshot...)
  // rechaza inmediatamente con un error de "target closed", que abajo
  // reinterpretamos como ConversionTimeoutError. Esto cancela de verdad el
  // trabajo en curso, no solo dejamos de esperar su resultado.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void browser.close();
  }, timeoutMs);

  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: scale });
    const page = await context.newPage();

    await page.goto(`${host.url}/${entryFile}`, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    const bundle = await getDetectorBundle();
    await page.addScriptTag({ content: bundle });

    const detectionStart = Date.now();
    const detection = await page.evaluate<SerializableDetectionReport>(() => window.__framewright.detectSlides());
    const detectionMs = Date.now() - detectionStart;

    if (detection.slides.length === 0 || detection.finalConfidence < minConfidence) {
      throw new SlideDetectionError(detection, minConfidence);
    }

    // Se valida el límite de slides ANTES de capturar ninguna imagen — un
    // deck con miles de slides no debe pagar el costo de renderizarlas
    // todas solo para ser rechazado al final.
    if (detection.slides.length > maxSlides) {
      throw new TooManySlidesError(detection.slides.length, maxSlides);
    }

    // Preparamos un único <style> reutilizable para el aislamiento de cada
    // slide durante su captura (ver captureSingleSlide) — se reescribe su
    // contenido en cada iteración en vez de crear un tag nuevo por slide.
    await page.evaluate((id) => {
      const style = document.createElement("style");
      style.id = id;
      document.head.appendChild(style);
    }, ISOLATE_STYLE_TAG_ID);

    const allSelectors = detection.slides.map((s) => s.selector);
    const capturedSlides: CapturedSlide[] = [];
    const captureStart = Date.now();

    for (const slide of detection.slides) {
      const captured = await captureSingleSlide({
        page,
        allSelectors,
        currentSelector: slide.selector,
        slideIndex: slide.index,
        outputDir: options.outputDir,
        stabilityOptions: options.stability,
      });
      capturedSlides.push(captured);
    }

    const captureMs = Date.now() - captureStart;

    return {
      slides: capturedSlides,
      detection,
      browserEngine,
      timings: { detectionMs, captureMs, totalMs: Date.now() - totalStart },
    };
  } catch (error) {
    if (timedOut) {
      throw new ConversionTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => undefined);
    await host.close();
  }
}

async function assertEntryFileExists(sourceDir: string, entryFile: string): Promise<void> {
  const fullPath = join(sourceDir, entryFile);
  try {
    await access(fullPath);
  } catch {
    throw new InvalidSourceError(
      `No se encontró el archivo de entrada "${entryFile}" dentro de "${sourceDir}". ` +
        `Verifica que el .zip contenga ese archivo en su raíz, o especifica otro entryFile.`
    );
  }
}

interface CaptureSingleSlideArgs {
  page: Page;
  allSelectors: string[];
  currentSelector: string;
  slideIndex: number;
  outputDir: string;
  stabilityOptions?: StabilityOptions;
}

/**
 * Captura una slide de forma robusta frente a frameworks que ocultan las
 * slides inactivas (`display: none`, como Reveal.js sin su runtime de
 * navegación activo): aísla la slide actual mediante un `<style>` con
 * reglas `!important` que ocultan a las demás y fuerzan la visibilidad de
 * la actual, espera estabilidad visual, y recorta exactamente al bounding
 * box del elemento.
 */
async function captureSingleSlide(args: CaptureSingleSlideArgs): Promise<CapturedSlide> {
  const { page, allSelectors, currentSelector, slideIndex, outputDir, stabilityOptions } = args;

  await page.evaluate(
    ({ id, allSelectors, currentSelector }) => {
      const style = document.getElementById(id) as HTMLStyleElement | null;
      if (!style) return;
      const hideRules = allSelectors
        .filter((sel) => sel !== currentSelector)
        .map((sel) => `${sel} { display: none !important; }`)
        .join("\n");
      const showRule = `${currentSelector} { display: block !important; opacity: 1 !important; visibility: visible !important; }`;
      style.textContent = `${hideRules}\n${showRule}`;
    },
    { id: ISOLATE_STYLE_TAG_ID, allSelectors, currentSelector }
  );

  const locator = page.locator(currentSelector);
  await locator.scrollIntoViewIfNeeded();

  const stability = await waitForVisualStability(
    () => page.screenshot({ type: "png" }),
    stabilityOptions
  );

  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(
      `No se pudo obtener el bounding box de la slide ${slideIndex} (selector: "${currentSelector}") ` +
        `tras aislarla — puede que el elemento siga sin ser visible.`
    );
  }

  const fileName = `slide-${String(slideIndex + 1).padStart(2, "0")}.png`;
  const filePath = join(outputDir, fileName);

  await page.screenshot({
    path: filePath,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    type: "png",
  });

  // Se extrae DESPUÉS de la captura final, con la slide en el mismo estado
  // exacto (aislada, ya estable) que produjo la imagen — así las coordenadas
  // de los links coinciden con lo que terminó en el PNG.
  const links = await extractLinkAnnotations(page, currentSelector, box);

  return {
    index: slideIndex,
    selector: currentSelector,
    filePath,
    widthPx: Math.round(box.width),
    heightPx: Math.round(box.height),
    stableBeforeCapture: stability.stable,
    links,
  };
}
