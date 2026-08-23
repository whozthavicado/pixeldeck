import type { DetectionStrategy } from "../types.js";
import { dataSlideAttributeStrategy } from "./data-slide-attribute.js";
import { fullscreenSectionStrategy } from "./fullscreen-section.js";
import { ariaTabpanelStrategy } from "./aria-tabpanel.js";
import { knownFrameworkSignatureStrategy } from "./known-framework-signature.js";

/**
 * Registro de estrategias activas. Agregar una nueva heurística de
 * detección es: crear el archivo, exportar su `DetectionStrategy`, y
 * añadirla aquí — el orquestador no necesita ningún otro cambio.
 */
export const ALL_STRATEGIES: DetectionStrategy[] = [
  dataSlideAttributeStrategy,
  knownFrameworkSignatureStrategy,
  fullscreenSectionStrategy,
  ariaTabpanelStrategy,
];

export {
  dataSlideAttributeStrategy,
  fullscreenSectionStrategy,
  ariaTabpanelStrategy,
  knownFrameworkSignatureStrategy,
};
