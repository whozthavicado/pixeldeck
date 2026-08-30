import { describe, it, expect } from "vitest";
import { PNG } from "pngjs";
import { diffRatio } from "../core-engine/image-diff.js";

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgba[0];
    png.data[i * 4 + 1] = rgba[1];
    png.data[i * 4 + 2] = rgba[2];
    png.data[i * 4 + 3] = rgba[3];
  }
  return PNG.sync.write(png);
}

describe("diffRatio", () => {
  it("dos PNG idénticos → ratio 0", () => {
    const a = solidPng(40, 30, [10, 20, 30, 255]);
    expect(diffRatio(a, Buffer.from(a))).toBe(0);
  });

  it("~10% de píxeles cambiados → ratio ≈ 0.1", () => {
    const base = new PNG({ width: 100, height: 100 });
    base.data.fill(255);
    const changed = new PNG({ width: 100, height: 100 });
    changed.data.fill(255);
    // Cambia las primeras 1000 filas-píxel (10% de 10000) a negro.
    for (let i = 0; i < 1000; i++) {
      changed.data[i * 4] = 0;
      changed.data[i * 4 + 1] = 0;
      changed.data[i * 4 + 2] = 0;
    }
    const ratio = diffRatio(PNG.sync.write(base), PNG.sync.write(changed));
    expect(ratio).toBeGreaterThan(0.08);
    expect(ratio).toBeLessThan(0.12);
  });

  it("dimensiones distintas → ratio 1", () => {
    const a = solidPng(10, 10, [0, 0, 0, 255]);
    const b = solidPng(20, 10, [0, 0, 0, 255]);
    expect(diffRatio(a, b)).toBe(1);
  });

  it("buffer no decodificable → ratio 1", () => {
    expect(diffRatio(Buffer.from("no soy un png"), solidPng(4, 4, [0, 0, 0, 255]))).toBe(1);
  });
});
