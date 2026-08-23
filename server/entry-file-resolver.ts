import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { InvalidSourceError } from "../core-engine/errors.js";

const MAX_SEARCH_DEPTH = 4;

/**
 * Resuelve qué archivo usar como entrada dentro de `sourceDir`:
 *  1. `index.html` en la raíz, si existe (caso más común).
 *  2. Si no, busca recursivamente (hasta `MAX_SEARCH_DEPTH` niveles) el
 *     primer `*.html`/`*.htm` encontrado — cubre .zip exportados con el
 *     HTML dentro de una subcarpeta.
 * Lanza `InvalidSourceError` si no encuentra ningún candidato.
 */
export async function resolveEntryFile(sourceDir: string): Promise<string> {
  const rootEntries = await readdir(sourceDir, { withFileTypes: true });
  const rootIndex = rootEntries.find((e) => e.isFile() && e.name.toLowerCase() === "index.html");
  if (rootIndex) return rootIndex.name;

  const found = await findFirstHtmlFile(sourceDir, sourceDir, 0);
  if (found) return found;

  // Decir solo "no hay HTML" deja al usuario sin pistas — y el caso real más
  // común es haber subido el .zip equivocado (p. ej. uno con los PDF ya
  // exportados, no el paquete HTML). Enumerar lo que SÍ había convierte un
  // callejón sin salida en un diagnóstico.
  const inventory = await summarizeContents(sourceDir);
  throw new InvalidSourceError(
    `No se encontró ningún archivo .html dentro del contenido subido ` +
      `(buscado hasta ${MAX_SEARCH_DEPTH} niveles de profundidad). ` +
      `El paquete contiene: ${inventory}. ` +
      `Asegúrate de subir el export HTML de la presentación, no un archivo ya convertido.`
  );
}

/** Resumen legible del contenido, agrupado por extensión, para el mensaje de error. */
async function summarizeContents(sourceDir: string): Promise<string> {
  const counts = new Map<string, number>();
  let total = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SEARCH_DEPTH || total >= 200) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (total >= 200) return;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), depth + 1);
        continue;
      }
      const dot = entry.name.lastIndexOf(".");
      const ext = dot > 0 ? entry.name.slice(dot).toLowerCase() : "(sin extensión)";
      counts.set(ext, (counts.get(ext) ?? 0) + 1);
      total++;
    }
  };

  await walk(sourceDir, 0);

  if (counts.size === 0) return "nada (paquete vacío)";

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([ext, n]) => `${n} ${ext}`)
    .join(", ");
}

async function findFirstHtmlFile(baseDir: string, currentDir: string, depth: number): Promise<string | null> {
  if (depth > MAX_SEARCH_DEPTH) return null;

  const entries = await readdir(currentDir, { withFileTypes: true });

  const htmlFile = entries.find((e) => e.isFile() && /\.html?$/i.test(e.name));
  if (htmlFile) {
    return relativeFromBase(baseDir, join(currentDir, htmlFile.name));
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nested = await findFirstHtmlFile(baseDir, join(currentDir, entry.name), depth + 1);
      if (nested) return nested;
    }
  }

  return null;
}

function relativeFromBase(baseDir: string, fullPath: string): string {
  return fullPath.slice(baseDir.length).replace(/^[/\\]/, "");
}
