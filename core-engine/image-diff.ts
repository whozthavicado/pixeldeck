import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

/**
 * Fracción de píxeles distintos entre dos capturas PNG (0 = idénticas,
 * 1 = totalmente distintas o incomparables).
 *
 * Se extrajo de `stability-watcher.ts` para poder reutilizarlo tanto en el
 * sondeo de estabilidad (¿sigue cambiando el render?) como en la
 * verificación de la captura final (¿la imagen que entregamos es
 * reproducible?). Un cambio de dimensiones entre capturas se trata como
 * "totalmente distintas": si el layout cambió de tamaño, no se ha asentado.
 *
 * @param pixelDiffThreshold Sensibilidad por píxel de pixelmatch (0–1). Más
 *   alto = más tolerante al antialiasing. Default 0.1 (igual que el watcher).
 */
export function diffRatio(bufferA: Buffer, bufferB: Buffer, pixelDiffThreshold = 0.1): number {
  let pngA: PNG;
  let pngB: PNG;
  try {
    pngA = PNG.sync.read(bufferA);
    pngB = PNG.sync.read(bufferB);
  } catch {
    return 1;
  }

  if (pngA.width !== pngB.width || pngA.height !== pngB.height) {
    return 1;
  }

  const { width, height } = pngA;
  const numDiffPixels = pixelmatch(pngA.data, pngB.data, null, width, height, {
    threshold: pixelDiffThreshold,
  });

  return numDiffPixels / (width * height);
}
