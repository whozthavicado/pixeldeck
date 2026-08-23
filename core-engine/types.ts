/**
 * Tipos compartidos por el motor de detección de slides.
 *
 * Todo el módulo opera sobre la interfaz DOM estándar (Document/Element),
 * no sobre un tipo de "página de Playwright" ni sobre un tipo específico
 * de jsdom. Esto es intencional: la misma lógica corre sin cambios tanto
 * inyectada en un navegador real (vía page.evaluate) como en tests
 * unitarios con jsdom.
 */

/** Resultado crudo que devuelve una única estrategia de detección. */
export interface StrategyResult {
  /** Nombre único de la estrategia, usado en logs y en el reporte final. */
  strategyName: string;
  /** Confianza de 0 (no aplica) a 1 (certeza total) de que estos son "los" slides. */
  confidence: number;
  /** Elementos candidatos a ser slides, en el orden en que deben presentarse. */
  slides: Element[];
  /** Explicación breve de por qué se llegó a esta confianza (para debugging/logs). */
  reason: string;
}

/** Contrato que debe implementar cada estrategia de detección. */
export interface DetectionStrategy {
  name: string;
  detect(document: Document): StrategyResult;
}

/** Un slide ya resuelto por el orquestador, con su índice final de presentación. */
export interface ResolvedSlide {
  index: number;
  element: Element;
  /** Selector CSS único generado para poder re-ubicar este elemento en Playwright. */
  selector: string;
}

/** Reporte completo devuelto por el orquestador `detectSlides`. */
export interface DetectionReport {
  /** Estrategia elegida (la de mayor confianza compuesta) o null si ninguna aplicó. */
  winningStrategy: string | null;
  /** Confianza final (puede subir por acuerdo entre estrategias — ver orchestrator). */
  finalConfidence: number;
  /** Lista final de slides resueltos, en orden de presentación. */
  slides: ResolvedSlide[];
  /** Resultado crudo de cada estrategia evaluada, para auditoría/logging. */
  allResults: StrategyResult[];
}

/**
 * Anotación de hipervínculo reconstruida a partir de un elemento `<a href>`
 * visible dentro de una slide. Las coordenadas son en px CSS (lógicos,
 * no multiplicados por deviceScaleFactor), relativas a la esquina superior
 * izquierda de la propia slide en el instante de la captura — ver
 * `link-mapper.ts` y `capture-engine.ts`.
 */
export interface LinkAnnotation {
  href: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Variante 100% serializable de `DetectionReport` (sin referencias a
 * `Element`), usada para cruzar el puente `page.evaluate` de Playwright.
 * Ver `browser-entry.ts` y `capture-engine.ts`.
 */
export interface SerializableDetectionReport {
  winningStrategy: string | null;
  finalConfidence: number;
  slides: Array<{ index: number; selector: string }>;
  allResults: Array<{
    strategyName: string;
    confidence: number;
    slideCount: number;
    reason: string;
  }>;
}
