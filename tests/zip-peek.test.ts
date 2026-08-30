import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import AdmZip from "adm-zip";

const __dirname = dirname(fileURLToPath(import.meta.url));

// zip-peek.js es código de navegador (IIFE que asigna window.zipPeek). Se
// carga aquí con un `window` postizo para poder probar el parser del central
// directory en Node, sin navegador.
type ZipPeek = (file: File) => Promise<{ entries: Array<{ name: string; size: number }>; totalUncompressed: number }>;

let zipPeek: ZipPeek;

beforeAll(() => {
  const src = readFileSync(join(__dirname, "..", "client", "zip-peek.js"), "utf-8");
  const fakeWindow: Record<string, unknown> = {};
  new Function("window", src)(fakeWindow);
  zipPeek = fakeWindow.zipPeek as ZipPeek;
});

function zipFile(files: Record<string, string>): File {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, "utf-8"));
  }
  return new File([zip.toBuffer()], "deck.zip", { type: "application/zip" });
}

describe("zipPeek", () => {
  it("lista los archivos con su tamaño descomprimido y localiza el index.html", async () => {
    const file = zipFile({
      "index.html": "<html><body>hola</body></html>",
      "assets/reveal.min.js": "// reveal " + "x".repeat(500),
      "fonts/Inter.woff2": "woff2data",
    });
    const { entries, totalUncompressed } = await zipPeek(file);

    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["assets/reveal.min.js", "fonts/Inter.woff2", "index.html"]);
    expect(entries.find((e) => e.name === "index.html")!.size).toBe(30);
    expect(totalUncompressed).toBeGreaterThan(500);
  });

  it("ignora las entradas de directorio", async () => {
    const zip = new AdmZip();
    zip.addFile("sub/", Buffer.alloc(0));
    zip.addFile("sub/a.html", Buffer.from("a"));
    const file = new File([zip.toBuffer()], "d.zip");
    const { entries } = await zipPeek(file);
    expect(entries.map((e) => e.name)).toEqual(["sub/a.html"]);
  });

  it("lanza si no es un ZIP", async () => {
    await expect(zipPeek(new File([Buffer.from("no soy zip")], "x.zip"))).rejects.toThrow();
  });
});
