import { afterAll } from "vitest";
import { closeAllBrowsers } from "../../core-engine/browser-pool.js";

// El motor de captura reutiliza navegadores de un pool por proceso. En los
// tests hay que cerrarlos al terminar para que el runner no quede colgado
// esperando a que mueran procesos Chromium.
afterAll(async () => {
  await closeAllBrowsers();
});
