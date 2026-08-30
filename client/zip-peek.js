/**
 * Lector mínimo del *central directory* de un archivo ZIP, en JS vanilla y
 * sin dependencias. NO descomprime nada: el central directory guarda los
 * nombres de archivo y sus tamaños sin comprimir, al final del archivo, así
 * que basta leer los últimos KB del File para inventariar el .zip antes de
 * subirlo — lo suficiente para recomendarle al usuario qué opciones marcar.
 *
 * Estructura relevante del ZIP (little-endian):
 *   - End Of Central Directory (EOCD): firma 0x06054b50, en los últimos
 *     ~22 bytes + comentario (máx 65535). Da offset y tamaño del directorio.
 *   - Cada entrada del directorio: firma 0x02014b50, seguida de tamaños y
 *     longitudes, luego nombre + extra + comentario.
 *
 * Expone `window.zipPeek(file) -> Promise<{ entries, totalUncompressed }>`.
 */
(() => {
  "use strict";

  const EOCD_SIG = 0x06054b50;
  const CEN_SIG = 0x02014b50;
  const MAX_COMMENT = 65535;
  const EOCD_MIN = 22;

  async function readTail(file, bytes) {
    const start = Math.max(0, file.size - bytes);
    const buf = await file.slice(start, file.size).arrayBuffer();
    return { view: new DataView(buf), baseOffset: start, byteLength: buf.byteLength };
  }

  function findEocd(view, byteLength) {
    // Buscar la firma EOCD desde el final hacia atrás.
    for (let i = byteLength - EOCD_MIN; i >= 0; i--) {
      if (view.getUint32(i, true) === EOCD_SIG) return i;
    }
    return -1;
  }

  function decodeName(view, offset, length) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return "";
    }
  }

  async function zipPeek(file) {
    // El central directory completo puede ser más grande que un tail corto;
    // se lee un tramo generoso y, si el EOCD dice que el directorio empieza
    // antes de lo leído, se hace una segunda lectura acotada a él.
    const firstTail = await readTail(file, Math.min(file.size, EOCD_MIN + MAX_COMMENT + 4096));
    const eocdRel = findEocd(firstTail.view, firstTail.byteLength);
    if (eocdRel < 0) throw new Error("No es un ZIP válido (sin EOCD).");

    const cdSize = firstTail.view.getUint32(eocdRel + 12, true);
    const cdOffset = firstTail.view.getUint32(eocdRel + 16, true);
    const totalEntries = firstTail.view.getUint16(eocdRel + 10, true);

    let cdView;
    let cdBase;
    if (cdOffset >= firstTail.baseOffset) {
      cdView = firstTail.view;
      cdBase = cdOffset - firstTail.baseOffset;
    } else {
      const buf = await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
      cdView = new DataView(buf);
      cdBase = 0;
    }

    const entries = [];
    let p = cdBase;
    let totalUncompressed = 0;

    for (let i = 0; i < totalEntries; i++) {
      if (p + 46 > cdView.byteLength) break;
      if (cdView.getUint32(p, true) !== CEN_SIG) break;

      const uncompressedSize = cdView.getUint32(p + 24, true);
      const nameLen = cdView.getUint16(p + 28, true);
      const extraLen = cdView.getUint16(p + 30, true);
      const commentLen = cdView.getUint16(p + 32, true);
      const name = decodeName(cdView, p + 46, nameLen);

      if (name && !name.endsWith("/")) {
        entries.push({ name, size: uncompressedSize });
        totalUncompressed += uncompressedSize;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }

    return { entries, totalUncompressed };
  }

  window.zipPeek = zipPeek;
})();
