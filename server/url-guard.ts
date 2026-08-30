import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Guarda contra SSRF para la captura por URL en el servidor HTTP.
 *
 * `POST /convert` puede recibir una `url` que el navegador headless va a
 * cargar. Sin control, un cliente podría apuntar el servidor a recursos
 * internos: el endpoint de metadatos de la nube (169.254.169.254), servicios
 * en loopback, la red privada del clúster, etc., y filtrar su contenido en
 * el PDF resultante.
 *
 * Por eso la captura por URL en el servidor:
 *  1. está DESACTIVADA por defecto — se habilita con `PIXELDECK_ALLOW_REMOTE_URL=1`,
 *  2. y aun habilitada, solo permite http/https hacia direcciones IP públicas
 *     (se resuelve el hostname y se rechaza si CUALQUIER dirección resuelta
 *     cae en un rango privado/loopback/link-local/ULA/CGNAT).
 *
 * La CLI NO pasa por aquí: quien la corre ya tiene acceso a su propia red.
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

export function remoteUrlCaptureEnabled(): boolean {
  return process.env.PIXELDECK_ALLOW_REMOTE_URL === "1" || process.env.PIXELDECK_ALLOW_REMOTE_URL === "true";
}

/** true si la IP (v4 o v6) NO es enrutable públicamente. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true; // no parseable → trátalo como no seguro
}

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this host"
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local + metadatos de la nube
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast / reservado
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapeada (::ffff:a.b.c.d)
  const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/**
 * Chequeo SÍNCRONO y barato (sin DNS) de una URL, para el guard de peticiones
 * del navegador (redirecciones incluidas): bloquea esquemas no http/https,
 * IPs literales privadas y `localhost`. No resuelve hostnames — de eso se
 * encarga `assertPublicUrl` en la validación previa.
 */
export function isBlockedRequestUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) && isPrivateAddress(host)) return true;
  return false;
}

/**
 * Valida que `rawUrl` sea http/https y que todas sus direcciones resueltas
 * sean públicas. Lanza `BlockedUrlError` si no.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError("URL mal formada.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`Esquema no permitido: "${url.protocol}". Solo http/https.`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  // Si el host ya es una IP literal, se comprueba directo.
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedUrlError("La URL apunta a una dirección IP no pública.");
    return;
  }

  if (host.toLowerCase() === "localhost" || host.toLowerCase().endsWith(".localhost")) {
    throw new BlockedUrlError("La URL apunta a localhost.");
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(`No se pudo resolver el host "${host}".`);
  }
  if (addresses.length === 0) throw new BlockedUrlError(`El host "${host}" no resolvió a ninguna dirección.`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedUrlError(`El host "${host}" resuelve a una dirección no pública (${address}).`);
    }
  }
}
