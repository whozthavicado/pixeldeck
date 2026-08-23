import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const currentModulePath = fileURLToPath(import.meta.url);
const __dirname = dirname(currentModulePath);

// En desarrollo (tsx transpila .ts al vuelo) este propio módulo se carga
// como bundle-detector.ts, así que browser-entry.ts existe junto a él. En
// producción (node ejecutando el build de tsc en dist/) este módulo se
// carga como bundle-detector.js, y solo existe browser-entry.js compilado
// — no hay .ts en dist/. Se resuelve la extensión del entry point según la
// extensión con la que ESTE módulo fue cargado, para funcionar en ambos casos.
const ENTRY_EXTENSION = extname(currentModulePath) === ".ts" ? ".ts" : ".js";
const ENTRY_POINT = join(__dirname, `browser-entry${ENTRY_EXTENSION}`);

let cachedBundle: string | null = null;

/**
 * Empaqueta `browser-entry.ts` (y todo lo que importa: slide-detector,
 * estrategias, dom-utils) en un único script IIFE apto para inyectar en una
 * página real vía `page.addScriptTag({ content })`.
 *
 * Se cachea en memoria tras la primera compilación — el motor de captura
 * puede llamar a esto una vez por proceso, no una vez por conversión.
 */
export async function getDetectorBundle(): Promise<string> {
  if (cachedBundle) return cachedBundle;

  const result = await build({
    entryPoints: [ENTRY_POINT],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: false,
    logLevel: "silent",
  });

  const output = result.outputFiles[0];
  if (!output) {
    throw new Error(`esbuild no produjo ningún archivo de salida para ${ENTRY_POINT}`);
  }

  cachedBundle = output.text;
  return cachedBundle;
}

/** Solo para tests: fuerza una recompilación en la siguiente llamada. */
export function invalidateDetectorBundleCache(): void {
  cachedBundle = null;
}
