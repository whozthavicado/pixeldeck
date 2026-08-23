import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { convertRouter } from "./routes/convert.js";
import { logger } from "./logger.js";

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

app.use(convertRouter);
app.use(express.static(CLIENT_DIR));

app.use((_req, res) => {
  res.status(404).json({ error: "Ruta no encontrada." });
});

app.listen(PORT, () => {
  logger.info(`Servidor escuchando en http://localhost:${PORT}`);
  logger.info(`POST /convert  (multipart/form-data: file=<.html|.zip>, format=pdf|png|jpg, scale=1-4)`);
});
