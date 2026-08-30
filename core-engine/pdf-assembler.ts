import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { PDFDocument, PDFName, PDFString, StandardFonts, type PDFFont, type PDFPage, type PDFRef } from "pdf-lib";
import type { LinkAnnotation } from "./types.js";
import type { TextRun } from "./slide-content.js";

export interface AssemblableSlide {
  filePath: string;
  /** Tamaño lógico de la slide en px CSS — se usa 1:1 como tamaño de página en puntos PDF. */
  widthPx: number;
  heightPx: number;
  links?: LinkAnnotation[];
  /** Etiqueta de la slide, para el índice (outline) del PDF. */
  label?: string | null;
  /** Fragmentos de texto posicionados, para la capa de texto invisible seleccionable. */
  textRuns?: TextRun[];
}

export type PdfLayout = "one-per-page" | "handout-2up";

export interface AssemblePdfOptions {
  /** Slides ya en el orden final de presentación. */
  slides: AssemblableSlide[];
  outputPath: string;
  /**
   * Disposición de página. `one-per-page` (default): una slide por página, a
   * su tamaño exacto, con anotaciones de link, capa de texto seleccionable e
   * índice. `handout-2up`: dos slides por página A4 apaisada — sin capa de
   * texto ni índice.
   */
  layout?: PdfLayout;
  /** Dibujar una capa de texto invisible pero seleccionable/buscable. Default: true. */
  textLayer?: boolean;
  /** Generar el índice (outline / bookmarks) del PDF desde las etiquetas. Default: true. */
  outline?: boolean;
  /** Fechas de creación/modificación fijas (salida reproducible). Default: false. */
  deterministic?: boolean;
  title?: string;
  author?: string;
  subject?: string;
}

/** A4 apaisada en puntos PDF (72 pt/in). */
const A4_LANDSCAPE = { width: 841.89, height: 595.28 };
const HANDOUT_MARGIN = 28;
const PRODUCER = "PixelDeck";

export interface AssemblePdfResult {
  outputPath: string;
  pageCount: number;
  linkAnnotationCount: number;
  /** Fragmentos de texto dibujados en la capa invisible. */
  textRunCount: number;
  /** Entradas creadas en el índice del PDF. */
  outlineEntryCount: number;
}

/**
 * Ensambla una lista de imágenes (una por slide) en un único PDF, con el
 * tamaño de página EXACTO al tamaño lógico de cada slide.
 *
 * Además del ráster pixel-perfect, el PDF lleva:
 *  - una **capa de texto invisible** posicionada sobre cada palabra, para que
 *    el resultado se pueda seleccionar, copiar y buscar (y sea accesible),
 *  - **anotaciones de link** reconstruidas por `link-mapper.ts`,
 *  - un **índice** (outline/bookmarks) generado desde las etiquetas de slide,
 *  - metadatos (título, autor, productor).
 *
 * Convención: 1 px CSS = 1 punto PDF.
 */
export async function assemblePdf(options: AssemblePdfOptions): Promise<AssemblePdfResult> {
  if (options.slides.length === 0) {
    throw new Error("assemblePdf: no se recibió ninguna slide para ensamblar.");
  }

  const pdfDoc = await PDFDocument.create();
  if (options.title) pdfDoc.setTitle(options.title);
  if (options.author) pdfDoc.setAuthor(options.author);
  if (options.subject) pdfDoc.setSubject(options.subject);
  pdfDoc.setCreator(PRODUCER);
  // pdf-lib solo autocompleta las fechas si están sin fijar — fijándolas
  // aquí, dos ensamblados del mismo input dan bytes idénticos en modo
  // determinista.
  const stamp = options.deterministic ? new Date(0) : new Date();
  pdfDoc.setCreationDate(stamp);
  pdfDoc.setModificationDate(stamp);

  if (options.layout === "handout-2up") {
    await assembleHandout2Up(pdfDoc, options.slides);
    await save(pdfDoc, options.outputPath);
    return {
      outputPath: options.outputPath,
      pageCount: Math.ceil(options.slides.length / 2),
      linkAnnotationCount: 0,
      textRunCount: 0,
      outlineEntryCount: 0,
    };
  }

  const textLayer = options.textLayer ?? true;
  const wantOutline = options.outline ?? true;
  const font = textLayer ? await pdfDoc.embedFont(StandardFonts.Helvetica) : null;

  let linkAnnotationCount = 0;
  let textRunCount = 0;
  const pages: PDFPage[] = [];

  for (const slide of options.slides) {
    const imageBytes = await readFile(slide.filePath);
    const image = await embedImageAuto(pdfDoc, imageBytes, slide.filePath);

    const page = pdfDoc.addPage([slide.widthPx, slide.heightPx]);
    pages.push(page);
    page.drawImage(image, { x: 0, y: 0, width: slide.widthPx, height: slide.heightPx });

    if (font && slide.textRuns) {
      textRunCount += drawTextLayer(page, font, slide.textRuns, slide.heightPx);
    }

    for (const link of slide.links ?? []) {
      addLinkAnnotation(pdfDoc, page, link, slide.heightPx);
      linkAnnotationCount++;
    }
  }

  let outlineEntryCount = 0;
  if (wantOutline) {
    outlineEntryCount = buildOutline(
      pdfDoc,
      options.slides.map((s, i) => ({ label: s.label ?? null, page: pages[i] }))
    );
  }

  await save(pdfDoc, options.outputPath);

  return {
    outputPath: options.outputPath,
    pageCount: options.slides.length,
    linkAnnotationCount,
    textRunCount,
    outlineEntryCount,
  };
}

async function save(pdfDoc: PDFDocument, outputPath: string): Promise<void> {
  const bytes = await pdfDoc.save();
  await writeFile(outputPath, bytes);
}

// ── Capa de texto invisible ──────────────────────────────────────────────

/** Caracteres fuera de WinAnsi (el encoding de las fuentes estándar de PDF). */
const WINANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019,
  0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

function sanitizeForWinAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x2019 || cp === 0x2018) out += "'";
    else if (cp === 0x201c || cp === 0x201d) out += '"';
    else if (cp === 0x2013 || cp === 0x2014) out += "-";
    else if (cp === 0x2026) out += "...";
    else if (cp < 0x100 || WINANSI_EXTRAS.has(cp)) out += ch;
    // cualquier otro (emoji, flechas, CJK…) se omite del layer invisible.
  }
  return out;
}

/**
 * Dibuja cada fragmento de texto con alfa 0 — invisible a la vista pero
 * presente en el content stream, así que el visor lo puede seleccionar y
 * buscar. La fuente exacta no importa (es invisible); solo se usa Helvetica
 * para posicionar. Devuelve cuántos fragmentos se dibujaron.
 */
function drawTextLayer(page: PDFPage, font: PDFFont, runs: TextRun[], pageHeightPt: number): number {
  let drawn = 0;
  for (const run of runs) {
    const text = sanitizeForWinAnsi(run.text).trim();
    if (!text) continue;
    const size = Math.min(1000, Math.max(1, run.height * 0.72));
    // El baseline va cerca del borde inferior de la caja de la línea.
    const y = pageHeightPt - run.y - run.height * 0.82;
    try {
      page.drawText(text, { x: run.x, y, size, font, opacity: 0 });
      drawn++;
    } catch {
      // Carácter que la fuente no puede codificar pese al saneo — se omite.
    }
  }
  return drawn;
}

// ── Índice / outline ─────────────────────────────────────────────────────

interface OutlineSlide {
  label: string | null;
  page: PDFPage;
}

/**
 * Construye el diccionario `/Outlines` a mano (pdf-lib no tiene API de alto
 * nivel). Cada slide con etiqueta se vuelve un bookmark que salta a su página.
 * Devuelve el número de entradas creadas.
 */
function buildOutline(pdfDoc: PDFDocument, slides: OutlineSlide[]): number {
  const entries = slides.map((s, index) => ({
    title: s.label?.trim() || `Slide ${index + 1}`,
    pageRef: s.page.ref,
  }));

  if (entries.length === 0) return 0;

  const context = pdfDoc.context;
  const outlinesRef = context.nextRef();
  const itemRefs: PDFRef[] = entries.map(() => context.nextRef());

  entries.forEach((entry, i) => {
    const dict = context.obj({
      Title: PDFString.of(entry.title.slice(0, 200)),
      Parent: outlinesRef,
      Dest: [entry.pageRef, PDFName.of("Fit")],
      ...(i > 0 ? { Prev: itemRefs[i - 1] } : {}),
      ...(i < entries.length - 1 ? { Next: itemRefs[i + 1] } : {}),
    });
    context.assign(itemRefs[i], dict);
  });

  context.assign(
    outlinesRef,
    context.obj({
      Type: "Outlines",
      First: itemRefs[0],
      Last: itemRefs[itemRefs.length - 1],
      Count: itemRefs.length,
    })
  );

  pdfDoc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  pdfDoc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));

  return entries.length;
}

// ── handout 2-up ─────────────────────────────────────────────────────────

/**
 * Dos slides por página A4 apaisada: mitad superior y mitad inferior, cada
 * una escalada para caber en su celda conservando proporción, y centrada.
 */
async function assembleHandout2Up(pdfDoc: PDFDocument, slides: AssemblableSlide[]): Promise<void> {
  const cellWidth = A4_LANDSCAPE.width - HANDOUT_MARGIN * 2;
  const cellHeight = (A4_LANDSCAPE.height - HANDOUT_MARGIN * 3) / 2;

  for (let i = 0; i < slides.length; i += 2) {
    const page = pdfDoc.addPage([A4_LANDSCAPE.width, A4_LANDSCAPE.height]);
    const pair = slides.slice(i, i + 2);

    for (let j = 0; j < pair.length; j++) {
      const slide = pair[j];
      const image = await embedImageAuto(pdfDoc, await readFile(slide.filePath), slide.filePath);

      const fit = Math.min(cellWidth / slide.widthPx, cellHeight / slide.heightPx);
      const drawWidth = slide.widthPx * fit;
      const drawHeight = slide.heightPx * fit;

      const cellBottom = j === 0 ? HANDOUT_MARGIN * 2 + cellHeight : HANDOUT_MARGIN;
      const x = (A4_LANDSCAPE.width - drawWidth) / 2;
      const y = cellBottom + (cellHeight - drawHeight) / 2;

      page.drawImage(image, { x, y, width: drawWidth, height: drawHeight });
    }
  }
}

async function embedImageAuto(pdfDoc: PDFDocument, bytes: Buffer, filePath: string) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return pdfDoc.embedJpg(bytes);
  }
  if (ext === ".png") {
    return pdfDoc.embedPng(bytes);
  }
  throw new Error(`assemblePdf: formato de imagen no soportado "${ext}" (${filePath}). Se esperaba .png o .jpg/.jpeg.`);
}

/**
 * pdf-lib no expone una API de alto nivel para anotaciones de link, así que
 * se construye el diccionario `/Annot /Link` manualmente. El origen de PDF
 * está abajo-izquierda, por eso se invierte `y`.
 */
function addLinkAnnotation(pdfDoc: PDFDocument, page: PDFPage, link: LinkAnnotation, pageHeightPt: number): void {
  const x0 = link.x;
  const x1 = link.x + link.width;
  const y0 = pageHeightPt - (link.y + link.height);
  const y1 = pageHeightPt - link.y;

  const linkAnnotation = pdfDoc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [x0, y0, x1, y1],
    Border: [0, 0, 0],
    A: {
      Type: "Action",
      S: "URI",
      URI: PDFString.of(link.href),
    },
  });

  const linkRef = pdfDoc.context.register(linkAnnotation);
  const existingAnnots = page.node.Annots();

  if (existingAnnots) {
    existingAnnots.push(linkRef);
  } else {
    page.node.set(PDFName.of("Annots"), pdfDoc.context.obj([linkRef]));
  }
}
