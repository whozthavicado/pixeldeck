import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEntryFile, listHtmlFiles } from "../server/entry-file-resolver.js";
import { AmbiguousEntryError, InvalidSourceError } from "../core-engine/errors.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scaffold(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pixeldeck-entry-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

describe("resolveEntryFile", () => {
  it("prefiere index.html en la raíz", async () => {
    const root = await scaffold({ "index.html": "<html>", "otra.html": "<html>" });
    expect(await resolveEntryFile(root)).toBe("index.html");
  });

  it("con un solo HTML lo usa aunque no se llame index", async () => {
    const root = await scaffold({ "deck.dc.html": "<html>", "deck-stage.js": "//" });
    expect(await resolveEntryFile(root)).toBe("deck.dc.html");
  });

  it("con varios HTML y sin entryFile → AmbiguousEntryError con la lista", async () => {
    const root = await scaffold({ "Japon.dc.html": "<html>", "Suiza.dc.html": "<html>" });
    await expect(resolveEntryFile(root)).rejects.toBeInstanceOf(AmbiguousEntryError);
    try {
      await resolveEntryFile(root);
    } catch (e) {
      expect((e as AmbiguousEntryError).candidates).toEqual(["Japon.dc.html", "Suiza.dc.html"]);
    }
  });

  it("respeta un entryFile pedido que existe", async () => {
    const root = await scaffold({ "Japon.dc.html": "<html>", "Suiza.dc.html": "<html>" });
    expect(await resolveEntryFile(root, "Suiza.dc.html")).toBe("Suiza.dc.html");
  });

  it("rechaza un entryFile con traversal", async () => {
    const root = await scaffold({ "a.html": "<html>" });
    await expect(resolveEntryFile(root, "../../etc/passwd")).rejects.toBeInstanceOf(InvalidSourceError);
    await expect(resolveEntryFile(root, "/etc/hosts")).rejects.toBeInstanceOf(InvalidSourceError);
  });

  it("rechaza un entryFile que no existe", async () => {
    const root = await scaffold({ "a.html": "<html>" });
    await expect(resolveEntryFile(root, "b.html")).rejects.toBeInstanceOf(InvalidSourceError);
  });

  it("listHtmlFiles ordena raíz antes que anidados", async () => {
    const root = await scaffold({ "sub/deep.html": "<html>", "top.html": "<html>" });
    expect(await listHtmlFiles(root)).toEqual(["top.html", "sub/deep.html"]);
  });
});
