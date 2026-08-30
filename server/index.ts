import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { convertRouter } from "./routes/convert.js";
import { logger } from "./logger.js";
import { closeAllBrowsers } from "../core-engine/browser-pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(__dirname, "..", "client");
const PORT = Number(process.env.PORT ?? 4000);

const app = express();

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    // /health se excluye para no ensuciar los logs con pings de monitoreo.
    if (req.path === "/health") return;
    logger.info("request", { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// La UI consulta esto al cargar para saber si debe pedir la clave de acceso.
app.get("/config", (_req, res) => {
  res.json({ authRequired: Boolean(process.env.PIXELDECK_KEY), remoteUrl: process.env.PIXELDECK_ALLOW_REMOTE_URL === "1" });
});

app.use(convertRouter);
app.use(express.static(CLIENT_DIR));

app.use((_req, res) => {
  res.status(404).json({ error: "Ruta no encontrada." });
});

const server = app.listen(PORT, () => {
  logger.info(`Servidor escuchando en http://localhost:${PORT}`);
  logger.info(`POST /convert  (multipart/form-data: file=<.html|.zip>, format=pdf|png|jpg, scale=1-4,`);
  logger.info(`               sourceKind, contentShape, nativeSize, expectedResult — todos opcionales)`);
  if (process.env.PIXELDECK_HEADED === "1" || process.env.PIXELDECK_HEADED === "true") {
    logger.info(`PIXELDECK_HEADED activo — el navegador se lanzará con ventana visible (slowMo ${process.env.PIXELDECK_SLOWMO ?? 250}ms)`);
  }
  if (process.env.PIXELDECK_VERIFY === "0" || process.env.PIXELDECK_VERIFY === "false") {
    logger.info(`PIXELDECK_VERIFY=0 — verificación pixel-diff desactivada`);
  }
});

// El pool de navegadores mantiene procesos Chromium vivos entre conversiones;
// hay que cerrarlos ordenadamente al recibir una señal de apagado.
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} recibido — cerrando servidor y navegadores…`);
  server.close(async () => {
    await closeAllBrowsers();
    process.exit(0);
  });
  // Red de seguridad: si algo se cuelga, forzar salida.
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
