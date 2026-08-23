type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveConfiguredLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

const configuredLevel = resolveConfiguredLevel();

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel]) return;

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
