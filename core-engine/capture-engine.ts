import { access } from "node:fs/promises";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { startStaticHost } from "../server/static-host.js";
import { getDetectorBundle } from "./bundle-detector.js";
import { waitForVisualStability, type StabilityOptions } from "./stability-watcher.js";
import { diffRatio } from "./image-diff.js";
import { extractLinkAnnotations } from "./link-mapper.js";
import type { DetectedDimensions } from "./deck-dimensions.js";
import { computeAutoTimeout, resolveTimeoutBudget } from "./timeout-budget.js";
import { SlideDetectionError, InvalidSourceError, ConversionTimeoutError, TooManySlidesError } from "./errors.js";
import { acquireBrowser, type BrowserLease } from "./browser-pool.js";
import { isSourceKind, type SourceKind } from "./forced-strategy.js";
import type { LinkAnnotation, SerializableDetectionReport } from "./types.js";

export type BrowserEngine = "chromium" | "firefox" | "webkit";

/** Forma del contenido subido — declarada por el usuario, o "deck" por defecto. */
export type ContentShape = "deck" | "single-page" | "long-scroll";

export interface VerifyOptions {
  /** Verificar cada captura final re-capturándola y comparándola. Default: true. */
  enabled?: boolean;
  /** Fracción de píxeles distintos por encima de la cual la captura se considera no reproducible. Default: 0.001. */
  threshold?: number;
  /** Espera extra antes de reintentar una slide que no verificó. Default: 400 ms. */
  resettleMs?: number;
  /** Reintentos por slide antes de aceptar la captura marcándola como no verificada. Default: 1. */
  maxRetries?: number;
}

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
  /** Verificación pixel-diff de la captura final de cada slide (ver VerifyOptions). */
  verify?: VerifyOptions;
  /**
   * Presupuesto total absoluto para toda la conversión. Si se omite, se
   * calcula automáticamente a partir del número de slides detectadas.
   */
  timeoutMs?: number;
  /** Máximo de slides a aceptar. Se valida justo después de detectar, ANTES de capturar ninguna. Default: 300. */
  maxSlides?: number;
  /**
   * Detectar el tamaño nativo del deck y ajustar el viewport a él antes de
   * capturar (ver deck-dimensions.ts). Default: true. Ponlo en false para
   * forzar la captura al `viewport` que pases explícitamente (ej. cuando el
   * usuario declaró un `nativeSize` conocido).
   */
  autoDetectDimensions?: boolean;
  /**
   * Reutilizar un navegador del pool compartido en vez de lanzar uno nuevo
   * para esta conversión. Default: true. Los tests que corren muchos
   * archivos deberían pasar false o llamar a `closeAllBrowsers()` al final.
   */
  reuseBrowser?: boolean;
  /**
   * Hint del usuario: qué herramienta generó el deck. Si se pasa, se salta
   * el scoring de estrategias y se usan directamente los selectores de esa
   * herramienta; si no matchean nada, se cae a la detección automática.
   */
  sourceKind?: SourceKind;
  /** Hint del usuario: forma del contenido. Default: "deck". */
  contentShape?: ContentShape;
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
  /** true si una segunda captura idéntica coincidió con la entregada (ver VerifyOptions). */
  verified: boolean;
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
  /** Cuántas slides pasaron la verificación pixel-diff (de `slides.length`). */
  verifiedCount: number;
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

const VERIFY_DEFAULTS: Required<VerifyOptions> = {
  enabled: true,
  threshold: 0.001,
  resettleMs: 400,
  maxRetries: 1,
};

/**
 * Pipeline completo de captura: sirve `sourceDir` por HTTP, detecta la
 * estructura de slides dentro de un navegador real, y captura cada slide
 * como PNG de alta resolución, esperando estabilidad visual antes de cada
 * captura y verificándola después.
 */
export async function captureDeck(options: CaptureOptions): Promise<CaptureResult> {
  const entryFile = options.entryFile ?? "index.html";
  const scale = options.scale ?? 2;
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const browserEngine = options.browserEngine ?? "chromium";
  const minConfidence = options.minConfidence ?? 0.4;
  const timeoutMs = options.timeoutMs;
  const maxSlides = options.maxSlides ?? 300;
  const autoDetectDimensions = options.autoDetectDimensions ?? true;
  const reuseBrowser = options.reuseBrowser ?? true;
  const contentShape: ContentShape = options.contentShape ?? "deck";
  const sourceKind = isSourceKind(options.sourceKind) ? options.sourceKind : undefined;
  const verify = { ...VERIFY_DEFAULTS, ...options.verify };
  const isSinglePage = contentShape === "single-page" || contentShape === "long-scroll";
  const totalStart = Date.now();

  await assertEntryFileExists(options.sourceDir, entryFile);
  await mkdir(options.outputDir, { recursive: true });

  const host = await startStaticHost(options.sourceDir);

  let lease: BrowserLease | null = null;
  let ownBrowser: Browser | null = null;
  let browser: Browser;
  if (reuseBrowser) {
    lease = await acquireBrowser(browserEngine);
    browser = lease.browser;
  } else {
    ownBrowser = await ENGINES[browserEngine].launch();
    browser = ownBrowser;
  }

  // Contexto actual bajo captura — al agotarse el presupuesto de tiempo se
  // cierra ESTE (no el navegador, que puede ser compartido por el pool):
  // cualquier llamada de Playwright en curso rechaza con "target closed",
  // que reinterpretamos abajo como ConversionTimeoutError.
  let activeContext: BrowserContext | null = null;
  let timedOut = false;
  const killActive = () => {
    timedOut = true;
    if (activeContext) void activeContext.close().catch(() => undefined);
    if (ownBrowser) void ownBrowser.close().catch(() => undefined);
  };
  let effectiveTimeoutMs = timeoutMs ?? computeAutoTimeout(0);
  let timer = setTimeout(killActive, effectiveTimeoutMs);

  const bundle = await getDetectorBundle();

  try {
    let context = await browser.newContext({ viewport, deviceScaleFactor: scale });
    activeContext = context;
    let page = await context.newPage();

    const loadPage = async (target: Page) => {
      await target.goto(`${host.url}/${entryFile}`, { waitUntil: "load" });
      await target.evaluate(() => document.fonts.ready.then(() => undefined));
      await target.addScriptTag({ content: bundle });
    };

    await loadPage(page);

    let detectedDimensions: DetectedDimensions | null = null;
    let effectiveViewport = viewport;
    // El scroll largo se captura a lo natural — sin forzar un artboard fijo.
    if (autoDetectDimensions && contentShape !== "long-scroll") {
      detectedDimensions = await page.evaluate(() => window.__pixeldeck.detectDeckDimensions());

      if (detectedDimensions && (detectedDimensions.width !== viewport.width || detectedDimensions.height !== viewport.height)) {
        effectiveViewport = { width: detectedDimensions.width, height: detectedDimensions.height };
        await page.setViewportSize(effectiveViewport);
        await page.waitForTimeout(150);
      }
    }

    let detectionStart = Date.now();
    let detection = await runDetection(page, { sourceKind, isSinglePage });
    let detectionMs = Date.now() - detectionStart;

    // Compensación de resolución (solo para decks multi-slide con artboard
    // escalado por el visor).
    let appliedScale = scale;
    if (autoDetectDimensions && !isSinglePage && detection.slides.length > 0) {
      const firstSelector = detection.slides[0].selector;
      const effectiveScale = await page.evaluate((sel) => window.__pixeldeck.measureEffectiveScale(sel), firstSelector);

      if (effectiveScale < 0.98) {
        appliedScale = Math.min(MAX_DEVICE_SCALE_FACTOR, scale / effectiveScale);

        await context.close();
        context = await browser.newContext({ viewport: effectiveViewport, deviceScaleFactor: appliedScale });
        activeContext = context;
        page = await context.newPage();
        await loadPage(page);

        detectionStart = Date.now();
        detection = await runDetection(page, { sourceKind, isSinglePage });
        detectionMs = Date.now() - detectionStart;
      }
    }

    if (detection.slides.length === 0 || (!isSinglePage && detection.finalConfidence < minConfidence)) {
      throw new SlideDetectionError(detection, minConfidence);
    }

    if (detection.slides.length > maxSlides) {
      throw new TooManySlidesError(detection.slides.length, maxSlides);
    }

    // Ya sabemos cuántas slides hay: reprogramamos el presupuesto al tamaño real.
    clearTimeout(timer);
    effectiveTimeoutMs = resolveTimeoutBudget(timeoutMs, detection.slides.length);
    timer = setTimeout(killActive, Math.max(0, effectiveTimeoutMs - (Date.now() - totalStart)));

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
        verify,
        fullPage: contentShape === "long-scroll",
        isolate: !isSinglePage,
      });
      capturedSlides.push(captured);
    }

    const captureMs = Date.now() - captureStart;
    const verifiedCount = capturedSlides.filter((s) => s.verified).length;

    return {
      slides: capturedSlides,
      detection,
      browserEngine,
      detectedDimensions,
      appliedScale,
      verifiedCount,
      timings: { detectionMs, captureMs, totalMs: Date.now() - totalStart },
    };
  } catch (error) {
    if (timedOut) {
      throw new ConversionTimeoutError(effectiveTimeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (activeContext) await activeContext.close().catch(() => undefined);
    if (ownBrowser) await ownBrowser.close().catch(() => undefined);
    lease?.release();
    await host.close();
  }
}

interface RunDetectionOpts {
  sourceKind: SourceKind | undefined;
  isSinglePage: boolean;
}

/**
 * Elige la vía de detección según los hints del usuario:
 *  - `single-page`/`long-scroll` → la raíz del deck es una sola slide.
 *  - `sourceKind` presente → selectores forzados de esa herramienta; si no
 *    matchean, se cae a la detección automática completa.
 *  - por defecto → scoring de estrategias.
 */
async function runDetection(page: Page, opts: RunDetectionOpts): Promise<SerializableDetectionReport> {
  if (opts.isSinglePage) {
    return page.evaluate(() => window.__pixeldeck.detectSingleRoot());
  }

  if (opts.sourceKind) {
    const forced = await page.evaluate((kind) => window.__pixeldeck.detectSlidesForced(kind), opts.sourceKind);
    if (forced.slides.length > 0) return forced;
    // Hint no matcheó — fallback a detección automática, conservando el
    // resultado forzado en allResults para que quede en el log/reporte.
    const auto = await page.evaluate(() => window.__pixeldeck.detectSlides());
    return { ...auto, allResults: [...forced.allResults, ...auto.allResults] };
  }

  return page.evaluate(() => window.__pixeldeck.detectSlides());
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clampClipToViewport(box: Rect, viewport: { width: number; height: number } | null): Rect {
  if (!viewport) return box;

  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(viewport.width, box.x + box.width);
  const y1 = Math.min(viewport.height, box.y + box.height);

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
  verify: Required<VerifyOptions>;
  /** Captura de página completa (para `long-scroll`) en vez de recorte al elemento. */
  fullPage: boolean;
  /** Aislar la slide ocultando a las demás (falso para página única/scroll). */
  isolate: boolean;
}

/**
 * Captura una slide de forma robusta frente a frameworks que ocultan las
 * slides inactivas: aísla la slide actual, espera estabilidad visual,
 * recorta a su bounding box, y verifica que una segunda captura idéntica
 * coincida — reintentando si no.
 */
async function captureSingleSlide(args: CaptureSingleSlideArgs): Promise<CapturedSlide> {
  const { page, allSelectors, currentSelector, slideIndex, outputDir, stabilityOptions, verify, fullPage, isolate } = args;

  if (isolate) {
    await page.evaluate(
      ({ id, allSelectors, currentSelector }) => {
        const style = document.getElementById(id) as HTMLStyleElement | null;
        if (!style) return;
        const hideRules = allSelectors
          .filter((sel) => sel !== currentSelector)
          .map((sel) => `${sel} { display: none !important; }`)
          .join("\n");

        // Al revelar la slide actual NO se debe forzar `display: block`: muchas
        // slides son `display: grid`/`flex` (columnas, áreas) y aplastarlas a
        // block rompe su maquetación (una columna de mapa/gráfica se desborda
        // sobre el resto). Solo se fuerza un `display` cuando la slide está
        // realmente oculta, y se usa el valor que el autor puso inline
        // (típicamente `grid`/`flex`), cayendo a `block` si no hay ninguno.
        const el = document.querySelector(currentSelector) as HTMLElement | null;
        let displayRule = "";
        if (el) {
          const inlineDisplay = el.style.display;
          const computedDisplay = getComputedStyle(el).display;
          if (inlineDisplay) displayRule = `display: ${inlineDisplay} !important;`;
          else if (computedDisplay === "none") displayRule = "display: block !important;";
        }
        const showRule = `${currentSelector} { ${displayRule} opacity: 1 !important; visibility: visible !important; }`;
        style.textContent = `${hideRules}\n${showRule}`;
      },
      { id: ISOLATE_STYLE_TAG_ID, allSelectors, currentSelector }
    );
  }

  const locator = page.locator(currentSelector);
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);

  const boxBeforeStability = await locator.boundingBox();
  if (!boxBeforeStability) {
    throw new Error(
      `No se pudo obtener el bounding box de la slide ${slideIndex} (selector: "${currentSelector}") ` +
        `tras aislarla — puede que el elemento siga sin ser visible.`
    );
  }

  const stability = await waitForVisualStability(
    () =>
      page.screenshot({
        type: "png",
        scale: "css",
        clip: clampClipToViewport(boxBeforeStability, page.viewportSize()),
      }),
    stabilityOptions
  );

  const fileName = `slide-${String(slideIndex + 1).padStart(2, "0")}.png`;
  const filePath = join(outputDir, fileName);

  // Tres modos de captura:
  //  - fullpage: `long-scroll` — la página entera, con scroll.
  //  - element: página única (poster) — el elemento raíz completo aunque
  //    sea más alto que el viewport (`page.screenshot({clip})` recorta al
  //    viewport; `locator.screenshot` no).
  //  - clip: deck normal — recorte al bounding box de la slide aislada.
  const mode: "fullpage" | "element" | "clip" = fullPage ? "fullpage" : isolate ? "clip" : "element";

  const takeShot = (target?: string): Promise<Buffer> => {
    if (mode === "fullpage") return page.screenshot({ path: target, type: "png", fullPage: true });
    if (mode === "element") return locator.screenshot({ path: target, type: "png" });
    return page.screenshot({ path: target, type: "png", clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
  };

  const measure = async (): Promise<Rect> => {
    if (mode === "fullpage") {
      const size = await page.evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
        height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      }));
      return { x: 0, y: 0, width: size.width, height: size.height };
    }
    return (await locator.boundingBox()) ?? boxBeforeStability;
  };

  let box: Rect = boxBeforeStability;
  const shoot = async (): Promise<Rect> => {
    box = await measure();
    await takeShot(filePath);
    return box;
  };

  await shoot();
  let verified = true;

  if (verify.enabled) {
    verified = false;
    for (let attempt = 0; attempt <= verify.maxRetries; attempt++) {
      const delivered = await readFile(filePath);
      const second = await takeShot();
      if (diffRatio(delivered, second) <= verify.threshold) {
        verified = true;
        break;
      }
      if (attempt < verify.maxRetries) {
        await page.waitForTimeout(verify.resettleMs);
        box = await shoot();
      }
    }
  }

  const links = fullPage ? [] : await extractLinkAnnotations(page, currentSelector, box);

  return {
    index: slideIndex,
    selector: currentSelector,
    filePath,
    widthPx: Math.round(box.width),
    heightPx: Math.round(box.height),
    stableBeforeCapture: stability.stable,
    verified,
    links,
  };
}
