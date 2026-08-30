import type { SerializableDetectionReport } from "./types.js";

/**
 * Se lanza cuando el sistema de detección de slides no encuentra ningún
 * candidato con confianza suficiente. Lleva el reporte completo adjunto
 * para que capas superiores (API, fase 5) puedan devolver al usuario un
 * mensaje claro de por qué falló cada estrategia, no solo "no se pudo".
 */
export class SlideDetectionError extends Error {
  readonly report: SerializableDetectionReport;

  constructor(report: SerializableDetectionReport, minConfidence: number) {
    const reasons = report.allResults
      .map((r) => `  - ${r.strategyName}: confianza ${r.confidence.toFixed(2)} — ${r.reason}`)
      .join("\n");

    super(
      `No se detectó una estructura de slides con confianza suficiente ` +
        `(mínimo requerido: ${minConfidence}, mejor resultado: ${report.finalConfidence.toFixed(2)}).\n` +
        `Detalle por estrategia:\n${reasons || "  (ninguna estrategia encontró candidatos)"}`
    );
    this.name = "SlideDetectionError";
    this.report = report;
  }
}

/** Se lanza cuando el directorio/archivo fuente no tiene el entry file esperado. */
export class InvalidSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSourceError";
  }
}

/**
 * Se lanza cuando el .zip contiene varios archivos HTML y el request no
 * especificó cuál usar. Lleva la lista de candidatos para que la UII pueda
 * pedirle al usuario que elija.
 */
export class AmbiguousEntryError extends Error {
  readonly candidates: string[];

  constructor(candidates: string[]) {
    super(
      `El paquete contiene varios archivos HTML y no se indicó cuál convertir. ` +
        `Especifica "entryFile" con uno de: ${candidates.join(", ")}.`
    );
    this.name = "AmbiguousEntryError";
    this.candidates = candidates;
  }
}

/** Se lanza cuando una conversión excede su presupuesto de tiempo total. */
export class ConversionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`La conversión excedió el tiempo límite de ${timeoutMs}ms y fue cancelada.`);
    this.name = "ConversionTimeoutError";
  }
}

/**
 * Se lanza cuando la detección encuentra más slides que el máximo
 * permitido — ANTES de capturar ninguna, para no gastar tiempo/recursos
 * renderizando un deck que de todos modos se va a rechazar.
 */
export class TooManySlidesError extends Error {
  constructor(detectedCount: number, maxSlides: number) {
    super(`Se detectaron ${detectedCount} slides, más del máximo soportado (${maxSlides}).`);
    this.name = "TooManySlidesError";
  }
}
