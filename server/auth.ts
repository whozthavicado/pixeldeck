import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Puerta de acceso opcional por clave para `/convert`.
 *
 * Si `PIXELDECK_KEY` NO está definida, no hay autenticación (uso local /
 * detrás de tu propia red). Si SÍ está definida, cada petición a `/convert`
 * debe traer esa clave en el header `X-PixelDeck-Key` o en
 * `Authorization: Bearer <clave>`. La comparación es de tiempo constante.
 *
 * Los archivos estáticos (la UI) y `/health` quedan siempre abiertos: la UI
 * es solo un formulario y no hace nada sin la clave.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.PIXELDECK_KEY;
  if (!expected) {
    next();
    return;
  }

  const provided =
    (typeof req.headers["x-pixeldeck-key"] === "string" ? req.headers["x-pixeldeck-key"] : "") ||
    bearerToken(req.headers.authorization);

  if (provided && safeEqual(provided, expected)) {
    next();
    return;
  }

  res.status(401).json({ error: "Clave de acceso requerida o inválida (header X-PixelDeck-Key)." });
}

function bearerToken(header: string | undefined): string {
  if (!header) return "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : "";
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
