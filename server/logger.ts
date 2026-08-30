type Level = "debug" | "info" | "warn" | "error";
type ConfiguredLevel = Level | "silent";

const LEVEL_ORDER: Record<ConfiguredLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function resolveConfiguredLevel(): ConfiguredLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "silent" || raw === "off" || raw === "none") return "silent";
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

// Se resuelve en cada llamada (no una sola vez al cargar el módulo) para que
// un consumidor — p. ej. la CLI — pueda ajustar LOG_LEVEL después de haber
// importado este módulo. "silent"/"off"/"none" suprime todo.
function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[resolveConfiguredLevel()]) return;

  const timestamp = new Date().toISOString();
  const metaSuffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${metaSuffix}`;

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * Logger mínimo, sin dependencias externas: timestamps ISO, niveles
 * filtrables vía `LOG_LEVEL` (debug|info|warn|error, default "info"), y
 * metadata estructurada opcional. Suficiente para depurar el pipeline de
 * conversión sin traer un framework de logging completo.
 */
export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => emit("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit("error", message, meta),
};
