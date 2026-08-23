import { copyFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { captureDeck, type BrowserEngine, type CapturedSlide } from "../core-engine/capture-engine.js";
import { assemblePdf } from "../core-engine/pdf-assembler.js";
import { convertPngToJpeg } from "../core-engine/image-converter.js";
import { InvalidSourceError } from "../core-engine/errors.js";
import { createConversionWorkspace } from "./cleanup.js";
import { extractZipSafely } from "./zip-extractor.js";
import { resolveEntryFile } from "./entry-file-resolver.js";
import { buildZip } from "./zip-builder.js";
import { logger } from "./logger.js";

// Configurable porque el tiempo real de captura varía bastante según el
// entorno de despliegue — en particular, dentro de un contenedor Docker
// virtualizado (ej. Docker Desktop en macOS) un deck de 3 slides puede
// tardar 2-3x más que corriendo nativo. Ver README §Variables de entorno.
// Sin valor por defecto a propósito: si no se fija explícitamente, el motor
// de captura calcula el presupuesto a partir del número de slides detectadas
// (un deck de 3 y uno de 200 no pueden compartir un límite fijo). La env var
// sigue disponible para imponer un tope duro en despliegues concretos.
const TIMEOUT_MS = process.env.PIXELDECK_TIMEOUT_MS ? Number(process.env.PIXELDECK_TIMEOUT_MS) : undefined;

export type OutputFormat = "pdf" | "png" | "jpg";

export interface ConversionRequest {
  /** Ruta del archivo ya subido a disco (por multer). */
  uploadedFilePath: string;
  /** Nombre original del archivo subido, usado solo para inferir su extensión. */
  originalFileName: string;
  format: OutputFormat;
  browserEngine?: BrowserEngine;
  scale?: number;
}

export interface ConversionOutcome {
  resultFilePath: string;
  resultFileName: string;
  mimeType: string;
  slideCount: number;
  detectionStrategy: string | null;
  detectionConfidence: number;
  /** Debe llamarse SOLO después de que la respuesta HTTP terminó de enviarse. */
  cleanup: () => Promise<void>;
}

/**
 * Orquesta un ciclo de conversión completo: coloca el input (extrae .zip o
 * copia el .html suelto) en un workspace temporal aislado, corre el motor
 * de captura, y ensambla la salida en el formato pedido.
 *
 * En caso de error, limpia el workspace antes de relanzar — en caso de
 * éxito, deja la limpieza en manos del caller (`outcome.cleanup()`), para
 * no borrar el archivo resultante antes de que termine de enviarse por HTTP.
 * El límite de número de slides se aplica dentro de `captureDeck` mismo
 * (antes de capturar ninguna imagen), no aquí.
 */
export async function runConversionPipeline(request: ConversionRequest): Promise<ConversionOutcome> {
  const workspace = await createConversionWorkspace();
  const pipelineStart = Date.now();
  logger.info("Conversión iniciada", { workspace: workspace.root, format: request.format, originalFileName: request.originalFileName });

  try {
    await placeInput(request.uploadedFilePath, request.originalFileName, workspace.sourceDir);
    const entryFile = await resolveEntryFile(workspace.sourceDir);
    logger.debug("Input listo", { workspace: workspace.root, entryFile });

    const captureResult = await captureDeck({
      sourceDir: workspace.sourceDir,
      entryFile,
      outputDir: workspace.outputDir,
      scale: request.scale,
      browserEngine: request.browserEngine,
      timeoutMs: TIMEOUT_MS,
    });

    const detectionStrategy = captureResult.detection.winningStrategy;
    const detectionConfidence = captureResult.detection.finalConfidence;
    const slideCount = captureResult.slides.length;

    logger.info("Detección y captura completas", {
      workspace: workspace.root,
      slideCount,
      detectionStrategy,
      detectionConfidence,
      detectionMs: captureResult.timings.detectionMs,
      captureMs: captureResult.timings.captureMs,
    });

    if (request.format === "pdf") {
      const pdfPath = join(workspace.outputDir, "presentation.pdf");
      await assemblePdf({
        slides: captureResult.slides.map((s) => ({ filePath: s.filePath, widthPx: s.widthPx, heightPx: s.heightPx, links: s.links })),
        outputPath: pdfPath,
      });

      logger.info("Conversión terminada", { workspace: workspace.root, format: "pdf", totalMs: Date.now() - pipelineStart });
      return {
        resultFilePath: pdfPath,
        resultFileName: "presentation.pdf",
        mimeType: "application/pdf",
        slideCount,
        detectionStrategy,
        detectionConfidence,
        cleanup: workspace.cleanup,
      };
    }

    // format === "png" | "jpg"
    const imageSlides = await prepareImageSlides(captureResult.slides, request.format, workspace.outputDir);
    const ext = request.format;
    const mimeType = request.format === "jpg" ? "image/jpeg" : "image/png";

    if (slideCount === 1) {
      logger.info("Conversión terminada", { workspace: workspace.root, format: request.format, totalMs: Date.now() - pipelineStart });
      return {
        resultFilePath: imageSlides[0].path,
        resultFileName: `slide-01.${ext}`,
        mimeType,
        slideCount,
        detectionStrategy,
        detectionConfidence,
        cleanup: workspace.cleanup,
      };
    }

    const zipPath = join(workspace.outputDir, "slides.zip");
    await buildZip(imageSlides, zipPath);

    logger.info("Conversión terminada", { workspace: workspace.root, format: request.format, totalMs: Date.now() - pipelineStart });
    return {
      resultFilePath: zipPath,
      resultFileName: "slides.zip",
      mimeType: "application/zip",
      slideCount,
      detectionStrategy,
      detectionConfidence,
      cleanup: workspace.cleanup,
    };
  } catch (error) {
    logger.warn("Conversión fallida", {
      workspace: workspace.root,
      totalMs: Date.now() - pipelineStart,
      errorName: error instanceof Error ? error.name : "unknown",
      errorMessage: error instanceof Error ? error.message.split("\n")[0] : String(error),
    });
    await workspace.cleanup();
    throw error;
  }
}

/**
 * Devuelve la lista de imágenes finales a entregar: los PNG del motor de
 * captura tal cual si `format === "png"`, o cada uno convertido a JPEG
 * (vía sharp) si `format === "jpg"`.
 */
async function prepareImageSlides(
  slides: CapturedSlide[],
  format: "png" | "jpg",
  outputDir: string
): Promise<Array<{ path: string; nameInZip: string }>> {
  if (format === "png") {
    return slides.map((s) => ({
      path: s.filePath,
      nameInZip: `slide-${String(s.index + 1).padStart(2, "0")}.png`,
    }));
  }

  const converted: Array<{ path: string; nameInZip: string }> = [];
  for (const slide of slides) {
    const name = `slide-${String(slide.index + 1).padStart(2, "0")}.jpg`;
    const jpegPath = join(outputDir, name);
    await convertPngToJpeg(slide.filePath, jpegPath);
    converted.push({ path: jpegPath, nameInZip: name });
  }
  return converted;
}

async function placeInput(uploadedFilePath: string, originalFileName: string, sourceDir: string): Promise<void> {
  const ext = extname(originalFileName).toLowerCase();

  if (ext === ".zip") {
    await extractZipSafely(uploadedFilePath, sourceDir);
    return;
  }

  if (ext === ".html" || ext === ".htm") {
    await copyFile(uploadedFilePath, join(sourceDir, "index.html"));
    return;
  }

  throw new InvalidSourceError(`Extensión de archivo no soportada: "${ext}". Se esperaba .html, .htm o .zip.`);
}
