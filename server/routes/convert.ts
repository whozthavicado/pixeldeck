import { Router, type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname } from "node:path";
import { nanoid } from "nanoid";
import { runConversionPipeline, type OutputFormat } from "../conversion-pipeline.js";
import { ConcurrencyLimiter, QueueFullError } from "../job-queue.js";
import { UnsafeZipError } from "../zip-extractor.js";
import { logger } from "../logger.js";
import { SlideDetectionError, InvalidSourceError, ConversionTimeoutError, TooManySlidesError } from "../../core-engine/errors.js";

const MAX_UPLOAD_BYTES = Number(process.env.FRAMEWRIGHT_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024); // 50MB
const ALLOWED_EXTENSIONS = new Set([".html", ".htm", ".zip"]);
// Cada conversión lanza un navegador Playwright completo — pesado en CPU/RAM.
// Este límite es POR PROCESO/réplica; para escalar horizontalmente, sube el
// número de réplicas del contenedor en vez de este valor (ver README §Escalado).
const MAX_CONCURRENT_CONVERSIONS = Number(process.env.FRAMEWRIGHT_MAX_CONCURRENCY ?? 2);

const limiter = new ConcurrencyLimiter(MAX_CONCURRENT_CONVERSIONS);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpdir()),
    filename: (_req, file, cb) => cb(null, `framewright-upload-${nanoid()}${extname(file.originalname)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      cb(new InvalidSourceError(`Extensión no permitida: "${ext}". Solo se aceptan .html, .htm o .zip.`));
      return;
    }
    cb(null, true);
  },
});

export const convertRouter = Router();

convertRouter.post("/convert", upload.single("file"), async (req: Request, res: Response, next: NextFunction) => {
  if (!req.file) {
    res.status(400).json({ error: "No se recibió ningún archivo. Envía un campo de formulario 'file' con un .html o .zip." });
    return;
  }

  const format = parseFormat(req.body?.format);
  if (!format) {
    await safeUnlink(req.file.path);
    res.status(400).json({ error: 'Parámetro "format" inválido. Valores aceptados: "pdf", "png", "jpg".' });
    return;
  }

  const scale = parseScale(req.body?.scale);
  if (scale === null) {
    await safeUnlink(req.file.path);
    res.status(400).json({ error: 'Parámetro "scale" inválido. Debe ser un número entre 1 y 4.' });
    return;
  }

  const requestStart = Date.now();
  logger.info("Solicitud de conversión recibida", {
    originalFileName: req.file.originalname,
    sizeBytes: req.file.size,
    format,
    scale: scale ?? "default",
    activeConversions: limiter.activeCount,
    queuedConversions: limiter.queuedCount,
  });

  try {
    const outcome = await limiter.run(() =>
      runConversionPipeline({
        uploadedFilePath: req.file!.path,
        originalFileName: req.file!.originalname,
        format,
        scale: scale ?? undefined,
      })
    );

    res.setHeader("X-Framewright-Slide-Count", String(outcome.slideCount));
    res.setHeader("X-Framewright-Detection-Strategy", outcome.detectionStrategy ?? "none");
    res.setHeader("X-Framewright-Detection-Confidence", outcome.detectionConfidence.toFixed(2));

    res.download(outcome.resultFilePath, outcome.resultFileName, async (downloadError) => {
      // res.download ya envió (o intentó enviar) la respuesta — recién ahora
      // es seguro borrar el workspace temporal.
      await outcome.cleanup();
      if (downloadError && !res.headersSent) {
        next(downloadError);
      } else if (!downloadError) {
        logger.info("Respuesta enviada", {
          originalFileName: req.file!.originalname,
          slideCount: outcome.slideCount,
          totalRequestMs: Date.now() - requestStart,
        });
      }
    });
  } catch (error) {
    next(error);
  } finally {
    await safeUnlink(req.file.path);
  }
});

/** Middleware de errores específico de esta ruta — mapea errores conocidos a códigos HTTP claros. */
convertRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    res.status(status).json({ error: `Error al subir el archivo: ${err.message}` });
    return;
  }
  if (err instanceof InvalidSourceError || err instanceof UnsafeZipError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof SlideDetectionError) {
    res.status(422).json({ error: err.message, detectionReport: err.report });
    return;
  }
  if (err instanceof TooManySlidesError) {
    res.status(422).json({ error: err.message });
    return;
  }
  if (err instanceof ConversionTimeoutError) {
    res.status(504).json({ error: err.message });
    return;
  }
  if (err instanceof QueueFullError) {
    res.status(503).json({ error: err.message });
    return;
  }

  logger.error("Error inesperado en /convert", { error: err instanceof Error ? err.stack ?? err.message : String(err) });
  res.status(500).json({ error: "Error interno durante la conversión." });
});

function parseFormat(value: unknown): OutputFormat | null {
  if (value === undefined || value === null || value === "") return "pdf";
  if (value === "pdf" || value === "png" || value === "jpg") return value;
  return null;
}

/** Devuelve `undefined` (usar default), un número válido, o `null` si es inválido. */
function parseScale(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 4) return null;
  return parsed;
}

async function safeUnlink(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}
