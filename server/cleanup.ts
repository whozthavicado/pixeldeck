import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_PREFIX = "pixeldeck-";

/** Registro de directorios temporales vivos, para el borrado de emergencia al salir del proceso. */
const liveTempDirs = new Set<string>();

let exitHandlersRegistered = false;

function registerExitHandlersOnce(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;

  const cleanupAllOnExit = () => {
    for (const dir of liveTempDirs) {
      // Best-effort y síncrono: en un handler de salida no podemos await.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Nada más que hacer si esto falla durante el apagado del proceso.
      }
    }
  };

  process.on("exit", cleanupAllOnExit);
  process.on("SIGINT", () => {
    cleanupAllOnExit();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanupAllOnExit();
    process.exit(143);
  });
}

export interface ConversionWorkspace {
  root: string;
  sourceDir: string;
  outputDir: string;
  cleanup(): Promise<void>;
}

/**
 * Crea un directorio temporal exclusivo para una conversión, con
 * subcarpetas `source/` (HTML extraído) y `output/` (capturas + PDF).
 * Queda registrado para borrado de emergencia si el proceso muere antes
 * de que el caller llame a `cleanup()` explícitamente.
 */
export async function createConversionWorkspace(): Promise<ConversionWorkspace> {
  registerExitHandlersOnce();

  const root = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const sourceDir = join(root, "source");
  const outputDir = join(root, "output");

  await Promise.all([mkdir(sourceDir, { recursive: true }), mkdir(outputDir, { recursive: true })]);

  liveTempDirs.add(root);

  return {
    root,
    sourceDir,
    outputDir,
    async cleanup() {
      liveTempDirs.delete(root);
      await rm(root, { recursive: true, force: true });
    },
  };
}
