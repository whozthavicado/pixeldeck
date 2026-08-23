import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export interface StabilityOptions {
  /** Presupuesto total de espera antes de rendirse y seguir adelante. */
  maxWaitMs?: number;
  /** Pausa entre capturas sucesivas. */
  pollIntervalMs?: number;
  /** Sensibilidad de pixelmatch por píxel (0–1). Más alto = más tolerante a antialiasing. */
  pixelDiffThreshold?: number;
  /** Fracción de píxeles distintos por debajo de la cual dos capturas se consideran "iguales". */
  stablePixelRatio?: number;
  /** Cuántas comparaciones consecutivas estables se exigen antes de declarar "asentado". */
  consecutiveStableRequired?: number;
}

export interface StabilityResult {
  /** true si se alcanzó estabilidad antes del timeout; false si se agotó el presupuesto. */
  stable: boolean;
  finalSnapshot: Buffer;
  attempts: number;
  elapsedMs: number;
}

const DEFAULTS: Required<StabilityOptions> = {
  maxWaitMs: 4000,
  pollIntervalMs: 150,
  pixelDiffThreshold: 0.1,
  stablePixelRatio: 0.001, // 0.1% de píxeles distintos
  consecutiveStableRequired: 2,
};

/**
 * Espera hasta que capturas sucesivas de `captureSnapshot()` sean
 * prácticamente idénticas, en vez de esperar un tiempo fijo o depender
 * solo de `fonts.ready`/fin de animaciones CSS declaradas. Cubre
 * animaciones controladas por JS, fuentes que tardan en aplicar, e
 * imágenes remotas de carga lenta — cualquier cosa que siga cambiando el
 * render tras el "load" del documento.
 *
 * Si nunca se alcanza estabilidad dentro de `maxWaitMs`, se devuelve
 * `stable: false` con la última captura disponible — el caller decide si
 * continuar de todos modos (loggeando una advertencia) o fallar.
 */
export async function waitForVisualStability(
  captureSnapshot: () => Promise<Buffer>,
  options: StabilityOptions = {}
): Promise<StabilityResult> {
  const opts = { ...DEFAULTS, ...options };
  const start = Date.now();

  let previous = await captureSnapshot();
  let attempts = 1;
  let consecutiveStable = 0;

  while (Date.now() - start < opts.maxWaitMs) {
    await delay(opts.pollIntervalMs);
    const current = await captureSnapshot();
    attempts++;

    const diffRatio = diffRatioBetween(previous, current, opts.pixelDiffThreshold);
    consecutiveStable = diffRatio <= opts.stablePixelRatio ? consecutiveStable + 1 : 0;
    previous = current;

    if (consecutiveStable >= opts.consecutiveStableRequired) {
      return { stable: true, finalSnapshot: current, attempts, elapsedMs: Date.now() - start };
    }
  }

  return { stable: false, finalSnapshot: previous, attempts, elapsedMs: Date.now() - start };
}

function diffRatioBetween(bufferA: Buffer, bufferB: Buffer, pixelDiffThreshold: number): number {
  let pngA: PNG;
  let pngB: PNG;
  try {
    pngA = PNG.sync.read(bufferA);
    pngB = PNG.sync.read(bufferB);
  } catch {
    // Si alguna captura no es un PNG decodificable (raro, pero posible con
    // un frame parcial), lo tratamos como "no estable" y seguimos intentando.
    return 1;
  }

  if (pngA.width !== pngB.width || pngA.height !== pngB.height) {
    // Un cambio de dimensiones entre capturas (ej. reflow por fuente
    // cargando) es en sí evidencia de que el layout NO se ha asentado.
    return 1;
  }

  const { width, height } = pngA;
  const numDiffPixels = pixelmatch(pngA.data, pngB.data, null, width, height, {
    threshold: pixelDiffThreshold,
  });

  return numDiffPixels / (width * height);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
