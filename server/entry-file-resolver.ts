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

  throw new InvalidSourceError(
    `No se encontró ningún archivo .html dentro del contenido subido (buscado hasta ${MAX_SEARCH_DEPTH} niveles de profundidad).`
  );
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
