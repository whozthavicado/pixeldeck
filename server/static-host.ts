import express from "express";
import type { Server } from "node:http";
import getPort from "get-port";

export interface StaticHost {
  /** URL base del servidor, ej. "http://127.0.0.1:53211". Sin slash final. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Levanta un servidor HTTP estático temporal sobre `rootDir`, en un puerto
 * libre de la máquina, escuchando solo en loopback (127.0.0.1) — nunca
 * expuesto a la red. Necesario porque `file://` rompe rutas relativas,
 * fuentes con CORS y en general no se comporta como un navegador real
 * apuntando a una URL http(s).
 *
 * El caller es responsable de llamar a `close()` cuando termine — el
 * cleanup de archivos temporales del `rootDir` en sí es responsabilidad de
 * quien extrajo el .zip/.html, no de este módulo.
 */
export async function startStaticHost(rootDir: string): Promise<StaticHost> {
  const app = express();

  app.use(
    express.static(rootDir, {
      // No cache: cada conversión es efímera, no queremos respuestas 304
      // basadas en un ETag de un directorio temporal que va a desaparecer.
      etag: false,
      cacheControl: false,
      // Evita que "/" resuelva a un listado de directorio si no hay index.html.
      index: ["index.html"],
      dotfiles: "ignore",
    })
  );

  const port = await getPort();

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
