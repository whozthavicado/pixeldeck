import sharp from "sharp";

const DEFAULT_JPEG_QUALITY = 90;

/**
 * Convierte un PNG (salida canónica del motor de captura) a JPEG. Se usa
 * solo para el formato de salida "jpg" — el PDF sigue empaquetando el PNG
 * original directamente (sin pérdida), y el formato "png" nunca pasa por
 * aquí.
 */
export async function convertPngToJpeg(pngPath: string, jpegPath: string, quality: number = DEFAULT_JPEG_QUALITY): Promise<void> {
  await sharp(pngPath)
    // Los PNG capturados pueden tener canal alfa (fondos transparentes);
    // JPEG no soporta transparencia, así que se aplana sobre blanco en vez
    // de dejar que cada visor decida un color de fondo distinto.
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality })
    .toFile(jpegPath);
}
