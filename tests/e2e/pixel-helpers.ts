import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function loadPng(path: string): PNG {
  return PNG.sync.read(readFileSync(path));
}

export function getPixel(png: PNG, x: number, y: number): RGBA {
  const idx = (png.width * Math.round(y) + Math.round(x)) << 2;
  return { r: png.data[idx], g: png.data[idx + 1], b: png.data[idx + 2], a: png.data[idx + 3] };
}

export function colorsClose(a: RGBA, b: RGBA, tolerance = 12): boolean {
  return Math.abs(a.r - b.r) <= tolerance && Math.abs(a.g - b.g) <= tolerance && Math.abs(a.b - b.b) <= tolerance;
}

export function colorDistance(a: RGBA, b: RGBA): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/** Escanea una región en pasos de `step` px buscando al menos un píxel que cumpla `predicate`. Más robusto que un solo punto exacto frente a variaciones de fuente/antialiasing. */
export function anyPixelInRegionMatches(png: PNG, region: Region, predicate: (p: RGBA) => boolean, step = 4): boolean {
  for (let y = region.y; y < region.y + region.height; y += step) {
    for (let x = region.x; x < region.x + region.width; x += step) {
      if (predicate(getPixel(png, x, y))) return true;
    }
  }
  return false;
}
