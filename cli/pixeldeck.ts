#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, writeFile, access } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runConversionPipeline, type OutputFormat, type ExpectedResult, type NativeSize } from "../server/conversion-pipeline.js";
import type { ContentShape, BrowserEngine } from "../core-engine/capture-engine.js";
import type { SourceKind } from "../core-engine/forced-strategy.js";
import { closeAllBrowsers } from "../core-engine/browser-pool.js";

/** Busca el package.json hacia arriba — funciona en dev (cli/) y en el build (dist/cli/). */
function pkgVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const v = (JSON.parse(readFileSync(candidate, "utf8")) as { version?: string }).version;
        if (v) return v;
      } catch {
        /* sigue subiendo */
      }
    }
    dir = dirname(dir);
  }
  return "0.0.0";
}

const pkg = { version: pkgVersion() };

const HELP = `
pixeldeck ${pkg.version} — HTML/CSS decks → PDF/PNG/JPG pixel-perfect

USO
  pixeldeck <entrada.html|entrada.zip> [opciones]

OPCIONES
  -o, --out <ruta>          Archivo de salida. Default: ./<nombre>.<pdf|zip|png>
  -f, --format <fmt>        Formato de imagen: pdf | png | jpg          (default: pdf)
  -s, --scale <1-4>         Densidad / DPR                              (default: 2)
  -r, --result <modo>       pdf-multipage | handout-2up |
                            image-per-slide | single-image             (default: según --format)
  -e, --entry <archivo>     Qué HTML del .zip convertir (ruta relativa)
      --source-kind <k>     claude-design | reveal | impress |
                            google-slides | generic-slide-class        (salta la autodetección)
      --content-shape <s>   deck | single-page | long-scroll           (default: deck)
      --native-size <t>     1920x1080 | 1280x720 | 1024x768 | a4-portrait
      --engine <e>          chromium | firefox | webkit                (default: chromium)
      --no-verify           Desactiva la verificación pixel-diff
      --json                Imprime el resultado como JSON en stdout
  -q, --quiet               Sin salida de progreso
  -h, --help                Esta ayuda
  -v, --version             Versión

EJEMPLOS
  pixeldeck deck.html
  pixeldeck deck.zip --source-kind claude-design -o out/deck.pdf
  pixeldeck deck.zip --entry "Suiza - Avance.dc.html" -r handout-2up
  pixeldeck poster.html --content-shape single-page -f png
  pixeldeck deck.zip --json > result.json

Docs: https://github.com/whozthavicado/pixeldeck
`;

function fail(message: string, code = 1): never {
  process.stderr.write(`pixeldeck: ${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        format: { type: "string", short: "f" },
        scale: { type: "string", short: "s" },
        result: { type: "string", short: "r" },
        entry: { type: "string", short: "e" },
        "source-kind": { type: "string" },
        "content-shape": { type: "string" },
        "native-size": { type: "string" },
        engine: { type: "string" },
        "no-verify": { type: "boolean" },
        json: { type: "boolean" },
        quiet: { type: "boolean", short: "q" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 2);
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  const input = positionals[0];
  if (!input) fail("falta el archivo de entrada. Usa `pixeldeck --help`.", 2);
  if (positionals.length > 1) fail(`se esperaba un solo archivo de entrada (recibido: ${positionals.length}).`, 2);

  const inputPath = resolve(input);
  try {
    await access(inputPath);
  } catch {
    fail(`no se encontró el archivo "${input}".`);
  }
  const ext = extname(inputPath).toLowerCase();
  if (![".html", ".htm", ".zip"].includes(ext)) {
    fail(`extensión no soportada "${ext}". Se espera .html, .htm o .zip.`, 2);
  }

  const format = pickEnum<OutputFormat>(values.format, ["pdf", "png", "jpg"], "format") ?? "pdf";
  const scale = values.scale === undefined ? undefined : parseScale(values.scale);
  const expectedResult = pickEnum<ExpectedResult>(
    values.result,
    ["pdf-multipage", "handout-2up", "image-per-slide", "single-image"],
    "result"
  );
  const sourceKind = pickEnum<SourceKind>(
    values["source-kind"],
    ["claude-design", "reveal", "impress", "google-slides", "generic-slide-class"],
    "source-kind"
  );
  const contentShape = pickEnum<ContentShape>(values["content-shape"], ["deck", "single-page", "long-scroll"], "content-shape");
  const nativeSize = pickEnum<NativeSize>(values["native-size"], ["1920x1080", "1280x720", "1024x768", "a4-portrait"], "native-size");
  const engine = pickEnum<BrowserEngine>(values.engine, ["chromium", "firefox", "webkit"], "engine");

  // Los logs del pipeline van a stderr vía el logger (nivel warn+); stdout
  // queda limpio para --json.
  process.env.LOG_LEVEL ??= values.json ? "error" : "warn";

  const progress = (msg: string) => {
    if (!values.quiet && !values.json) process.stderr.write(`${msg}\n`);
  };

  progress(`▸ Rasterizando ${basename(inputPath)} …`);
  const started = Date.now();

  const outcome = await runConversionPipeline({
    uploadedFilePath: inputPath,
    originalFileName: basename(inputPath),
    format,
    scale,
    entryFile: values.entry,
    sourceKind,
    contentShape,
    nativeSize,
    expectedResult,
    browserEngine: engine,
  }).catch(async (err) => {
    await closeAllBrowsers().catch(() => undefined);
    fail(err instanceof Error ? err.message.split("\n")[0] : String(err));
  });

  const defaultName = outcome.resultFileName;
  const outPath = resolve(values.out ?? defaultName);
  await writeFile(outPath, await readFile(outcome.resultFilePath));
  await outcome.cleanup();
  await closeAllBrowsers().catch(() => undefined);

  const elapsedMs = Date.now() - started;

  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          output: outPath,
          slideCount: outcome.slideCount,
          verified: `${outcome.verifiedCount}/${outcome.slideCount}`,
          detectionStrategy: outcome.detectionStrategy,
          detectionConfidence: Number(outcome.detectionConfidence.toFixed(2)),
          elapsedMs,
        },
        null,
        2
      )}\n`
    );
  } else {
    progress(
      `✓ ${outcome.slideCount} slide(s) · verificadas ${outcome.verifiedCount}/${outcome.slideCount} · ` +
        `${(elapsedMs / 1000).toFixed(1)}s`
    );
    process.stdout.write(`${outPath}\n`);
  }
}

function pickEnum<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined || value === "" || value === "auto") return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    fail(`valor inválido para --${name}: "${value}". Opciones: ${allowed.join(", ")}.`, 2);
  }
  return value as T;
}

function parseScale(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 4) fail(`--scale debe ser un número entre 1 y 4 (recibido "${raw}").`, 2);
  return n;
}

main().catch((err) => {
  process.stderr.write(`pixeldeck: error inesperado: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
