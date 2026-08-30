import { access, readdir } from "node:fs/promises";
import { join, normalize, isAbsolute, sep } from "node:path";
import { AmbiguousEntryError, InvalidSourceError } from "../core-engine/errors.js";

const MAX_SEARCH_DEPTH = 4;

/**
 * Valida y normaliza un `entryFile` pedido explícitamente por el request:
 * debe ser una ruta relativa DENTRO de `sourceDir` (sin `..`, sin ruta
 * absoluta), apuntar a un archivo existente y terminar en `.html`/`.htm`.
 */
async function resolveRequestedEntry(sourceDir: string, requested: string): Promise<string> {
  const clean = requested.replace(/^[/\\]+/, "");
  const normalized = normalize(clean);
  if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.includes(`${sep}..${sep}`)) {
    throw new InvalidSourceError(`"entryFile" inválido: "${requested}". Debe ser una ruta relativa dentro del paquete.`);
  }
  if (!/\.html?$/i.test(normalized)) {
    throw new InvalidSourceError(`"entryFile" debe apuntar a un archivo .html o .htm (se recibió "${requested}").`);
  }
  try {
    await access(join(sourceDir, normalized));
  } catch {
    const candidates = await listHtmlFiles(sourceDir);
    throw new InvalidSourceError(
      `El "entryFile" pedido ("${requested}") no existe en el paquete. Archivos HTML disponibles: ${candidates.join(", ") || "(ninguno)"}.`
    );
  }
  return normalized.split(sep).join("/");
}

/**
 * Resuelve qué archivo usar como entrada dentro de `sourceDir`:
 *  0. Si `requestedEntry` viene dado, se valida y se usa ese.
 *  1. `index.html` en la raíz, si existe (caso más común).
 *  2. Si hay exactamente un `*.html`/`*.htm` en el paquete, ese.
 *  3. Si hay varios y ninguno fue pedido → `AmbiguousEntryError` con la lista.
 * Lanza `InvalidSourceError` si no encuentra ningún candidato.
 */
export async function resolveEntryFile(sourceDir: string, requestedEntry?: string): Promise<string> {
  if (requestedEntry && requestedEntry.trim()) {
    return resolveRequestedEntry(sourceDir, requestedEntry.trim());
  }

  const rootEntries = await readdir(sourceDir, { withFileTypes: true });
  const rootIndex = rootEntries.find((e) => e.isFile() && e.name.toLowerCase() === "index.html");
  if (rootIndex) return rootIndex.name;

  const candidates = await listHtmlFiles(sourceDir);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new AmbiguousEntryError(candidates);

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

/**
 * Lista todas las rutas relativas `*.html`/`*.htm` del paquete (hasta
 * `MAX_SEARCH_DEPTH` niveles), ordenadas: primero las de la raíz, luego por
 * profundidad y alfabéticamente. Se usa para el selector de la UI y para el
 * mensaje de `AmbiguousEntryError`.
 */
export async function listHtmlFiles(sourceDir: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SEARCH_DEPTH) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (/\.html?$/i.test(entry.name)) {
        found.push(full.slice(sourceDir.length).replace(/^[/\\]/, "").split(sep).join("/"));
      }
    }
  };

  await walk(sourceDir, 0);

  return found.sort((a, b) => {
    const da = a.split("/").length;
    const db = b.split("/").length;
    return da !== db ? da - db : a.localeCompare(b);
  });
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
