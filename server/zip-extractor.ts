import AdmZip from "adm-zip";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";

export interface ZipExtractionLimits {
  /** Máximo de entradas (archivos+carpetas) permitidas en el .zip. */
  maxEntries?: number;
  /** Máximo de bytes descomprimidos en total, para frenar zip bombs. */
  maxUncompressedBytes?: number;
}

const DEFAULT_LIMITS: Required<ZipExtractionLimits> = {
  maxEntries: 500,
  maxUncompressedBytes: 300 * 1024 * 1024, // 300MB
};

export class UnsafeZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeZipError";
  }
}

/**
 * Extrae un .zip a `destDir` de forma segura:
 *  - Rechaza "zip slip" (entradas cuyo path resuelto cae fuera de destDir,
 *    vía "../" o rutas absolutas) — adm-zip 0.6 ya sanea esto internamente,
 *    pero lo validamos también aquí como defensa en profundidad, ya que es
 *    el vector de ataque más común contra un endpoint que acepta .zip de
 *    usuarios no confiables.
 *  - Aplica límites de número de entradas y de tamaño descomprimido total,
 *    para frenar zip bombs (ver también el CVE de adm-zip <0.6 corregido
 *    en package.json — este límite es una capa adicional, no un sustituto).
 */
export async function extractZipSafely(zipPath: string, destDir: string, limits: ZipExtractionLimits = {}): Promise<void> {
  const opts = { ...DEFAULT_LIMITS, ...limits };
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  if (entries.length > opts.maxEntries) {
    throw new UnsafeZipError(`El .zip contiene ${entries.length} entradas, más del máximo permitido (${opts.maxEntries}).`);
  }

  let totalUncompressed = 0;
  const normalizedDestDir = normalize(destDir + sep);

  for (const entry of entries) {
    totalUncompressed += entry.header.size;
    if (totalUncompressed > opts.maxUncompressedBytes) {
      throw new UnsafeZipError(
        `El contenido descomprimido del .zip supera el máximo permitido (${opts.maxUncompressedBytes} bytes) — posible zip bomb.`
      );
    }

    const resolvedPath = normalize(join(destDir, entry.entryName));
    if (!resolvedPath.startsWith(normalizedDestDir) && resolvedPath !== normalize(destDir)) {
      throw new UnsafeZipError(`Entrada de .zip fuera del directorio de destino (zip slip): "${entry.entryName}".`);
    }
  }

  for (const entry of entries) {
    const resolvedPath = normalize(join(destDir, entry.entryName));

    if (entry.isDirectory) {
      await mkdir(resolvedPath, { recursive: true });
      continue;
    }

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, entry.getData());
  }
}
