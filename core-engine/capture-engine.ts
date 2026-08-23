import { access } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { startStaticHost } from "../server/static-host.js";
import { getDetectorBundle } from "./bundle-detector.js";
import { waitForVisualStability, type StabilityOptions } from "./stability-watcher.js";
import { extractLinkAnnotations } from "./link-mapper.js";
import type { DetectedDimensions } from "./deck-dimensions.js";
import { computeAutoTimeout, resolveTimeoutBudget } from "./timeout-budget.js";
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
  /**
   * Presupuesto total absoluto para toda la conversión. Si se omite, se
   * calcula automáticamente a partir del número de slides detectadas
   * (ver TIMEOUT_BASE_MS / TIMEOUT_PER_SLIDE_MS): un deck de 3 slides y
   * uno de 200 no pueden compartir el mismo límite fijo.
   */
  timeoutMs?: number;
  /** Máximo de slides a aceptar. Se valida justo después de detectar, ANTES de capturar ninguna. Default: 300. */
  maxSlides?: number;
  /**
   * Detectar el tamaño nativo del deck y ajustar el viewport a él antes de
   * capturar (ver deck-dimensions.ts). Default: true. Ponlo en false para
   * forzar la captura al `viewport` que pases explícitamente.
   */
  autoDetectDimensions?: boolean;
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
  /** Tamaño nativo detectado y aplicado al viewport, o null si no se detectó ninguno. */
  detectedDimensions: DetectedDimensions | null;
  /** deviceScaleFactor realmente usado (puede ser mayor que el pedido si se compensó el encogido del visor). */
  appliedScale: number;
  timings: {
    detectionMs: number;
    captureMs: number;
    totalMs: number;
  };
}

const ENGINES = { chromium, firefox, webkit } as const;

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const ISOLATE_STYLE_TAG_ID = "__pixeldeck_isolate__";
/** Tope del deviceScaleFactor tras compensar: más allá, el costo de memoria/CPU no compensa la ganancia visual. */
const MAX_DEVICE_SCALE_FACTOR = 4;

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
  // Sin default aquí a propósito: si queda `undefined`, el presupuesto se
  // calcula tras la detección a partir del número real de slides (ver la
  // reprogramación del timer más abajo). Ponerle un default fijo aquí
  // desactivaría por completo ese auto-escalado.
  const timeoutMs = options.timeoutMs;
  const maxSlides = options.maxSlides ?? 300;
  const autoDetectDimensions = options.autoDetectDimensions ?? true;
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
  const killBrowser = () => {
    timedOut = true;
    void browser.close();
  };
  // Arranca con el presupuesto "sin deck conocido"; una vez detectadas las
  // slides se reprograma con el presupuesto real (ver reprogramación abajo).
  let effectiveTimeoutMs = timeoutMs ?? computeAutoTimeout(0);
  let timer = setTimeout(killBrowser, effectiveTimeoutMs);

  const bundle = await getDetectorBundle();

  try {
    let context = await browser.newContext({ viewport, deviceScaleFactor: scale });
    let page = await context.newPage();

    const loadPage = async (target: Page) => {
      await target.goto(`${host.url}/${entryFile}`, { waitUntil: "load" });
      await target.evaluate(() => document.fonts.ready.then(() => undefined));
      await target.addScriptTag({ content: bundle });
    };

    await loadPage(page);

    // Auto-detección del tamaño nativo del deck: muchos formatos declaran
    // un artboard fijo (típicamente 1920x1080) y lo escalan para caber en
    // el viewport. Ajustar el viewport a ese tamaño le da al deck espacio
    // para maquetar a escala 1:1.
    let detectedDimensions: DetectedDimensions | null = null;
    let effectiveViewport = viewport;
    if (autoDetectDimensions) {
      detectedDimensions = await page.evaluate(() => window.__pixeldeck.detectDeckDimensions());

      if (detectedDimensions && (detectedDimensions.width !== viewport.width || detectedDimensions.height !== viewport.height)) {
        effectiveViewport = { width: detectedDimensions.width, height: detectedDimensions.height };
        await page.setViewportSize(effectiveViewport);
        // setViewportSize no recarga, pero sí dispara relayout y algunos
        // visores recalculan su escala en el resize — damos un respiro
        // para que ese recálculo termine antes de medir nada.
        await page.waitForTimeout(150);
      }
    }

    let detectionStart = Date.now();
    let detection = await page.evaluate<SerializableDetectionReport>(() => window.__pixeldeck.detectSlides());
    let detectionMs = Date.now() - detectionStart;

    // Compensación de resolución: algunos visores encogen el artboard para
    // que quepa junto a su propio chrome (barra de miniaturas, controles).
    // Ese encogimiento es una pérdida de resolución irrecuperable en la
    // captura. En vez de reescribir el layout del visor (frágil, y el
    // transform suele vivir en su shadow DOM), se sube el deviceScaleFactor
    // en la misma proporción: la caja CSS sigue siendo la que el visor
    // decidió, pero el PNG recupera la densidad de píxeles que el diseño
    // original merece.
    let appliedScale = scale;
    if (autoDetectDimensions && detection.slides.length > 0) {
      const firstSelector = detection.slides[0].selector;
      const effectiveScale = await page.evaluate((sel) => window.__pixeldeck.measureEffectiveScale(sel), firstSelector);

      if (effectiveScale < 0.98) {
        appliedScale = Math.min(MAX_DEVICE_SCALE_FACTOR, scale / effectiveScale);

        await context.close();
        context = await browser.newContext({ viewport: effectiveViewport, deviceScaleFactor: appliedScale });
        page = await context.newPage();
        await loadPage(page);

        detectionStart = Date.now();
        detection = await page.evaluate<SerializableDetectionReport>(() => window.__pixeldeck.detectSlides());
        detectionMs = Date.now() - detectionStart;
      }
    }

    if (detection.slides.length === 0 || detection.finalConfidence < minConfidence) {
      throw new SlideDetectionError(detection, minConfidence);
    }

    // Se valida el límite de slides ANTES de capturar ninguna imagen — un
    // deck con miles de slides no debe pagar el costo de renderizarlas
    // todas solo para ser rechazado al final.
    if (detection.slides.length > maxSlides) {
      throw new TooManySlidesError(detection.slides.length, maxSlides);
    }

    // Ya sabemos cuántas slides hay: reprogramamos el presupuesto de tiempo
    // al tamaño real del deck (salvo que el caller haya fijado uno explícito).
    clearTimeout(timer);
    effectiveTimeoutMs = resolveTimeoutBudget(timeoutMs, detection.slides.length);
    timer = setTimeout(killBrowser, Math.max(0, effectiveTimeoutMs - (Date.now() - totalStart)));

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
      detectedDimensions,
      appliedScale,
      timings: { detectionMs, captureMs, totalMs: Date.now() - totalStart },
    };
  } catch (error) {
    if (timedOut) {
      throw new ConversionTimeoutError(effectiveTimeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => undefined);
    await host.close();
  }
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Playwright rechaza un `clip` que se salga del viewport. Una slide puede
 * asomarse fuera de él (más alta que la ventana, o desplazada), así que el
 * recorte del sondeo de estabilidad se acota a la intersección con el
 * viewport. Solo afecta al muestreo de estabilidad — la captura FINAL usa
 * el bounding box completo sin acotar.
 */
function clampClipToViewport(box: Rect, viewport: { width: number; height: number } | null): Rect {
  if (!viewport) return box;

  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(viewport.width, box.x + box.width);
  const y1 = Math.min(viewport.height, box.y + box.height);

  // Si la intersección es vacía (slide totalmente fuera de vista) caemos a
  // un recorte mínimo válido: es mejor muestrear 1px que reventar.
  return {
    x: x0,
    y: y0,
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0),
  };
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

  const boxBeforeStability = await locator.boundingBox();
  if (!boxBeforeStability) {
    throw new Error(
      `No se pudo obtener el bounding box de la slide ${slideIndex} (selector: "${currentSelector}") ` +
        `tras aislarla — puede que el elemento siga sin ser visible.`
    );
  }

  // El sondeo de estabilidad solo necesita detectar CAMBIO, no fidelidad:
  // se recorta a la slide (no la página entera) y se fuerza `scale: "css"`
  // para ignorar el deviceScaleFactor. Con scale=2 eso es 4x menos píxeles
  // por captura, y cada una se decodifica y compara con pixelmatch en cada
  // sondeo — es el costo dominante del pipeline.
  const stability = await waitForVisualStability(
    () =>
      page.screenshot({
        type: "png",
        scale: "css",
        clip: clampClipToViewport(boxBeforeStability, page.viewportSize()),
      }),
    stabilityOptions
  );

  // Se relee el box tras la estabilización: si el layout se movió mientras
  // se asentaba, el recorte final debe usar la posición definitiva.
  const box = (await locator.boundingBox()) ?? boxBeforeStability;

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
