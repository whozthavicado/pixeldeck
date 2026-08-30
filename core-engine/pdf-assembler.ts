import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { PDFDocument, PDFName, PDFString, type PDFPage } from "pdf-lib";
import type { LinkAnnotation } from "./types.js";

export interface AssemblableSlide {
  filePath: string;
  /** Tamaño lógico de la slide en px CSS — se usa 1:1 como tamaño de página en puntos PDF. */
  widthPx: number;
  heightPx: number;
  links?: LinkAnnotation[];
}

export type PdfLayout = "one-per-page" | "handout-2up";

export interface AssemblePdfOptions {
  /** Slides ya en el orden final de presentación. */
  slides: AssemblableSlide[];
  outputPath: string;
  /**
   * Disposición de página. `one-per-page` (default): una slide por página, a
   * su tamaño exacto, con anotaciones de link. `handout-2up`: dos slides por
   * página A4 apaisada, centradas y escaladas para caber — pensado para
   * imprimir. En 2-up no se insertan anotaciones de link.
   */
  layout?: PdfLayout;
}

/** A4 apaisada en puntos PDF (72 pt/in). */
const A4_LANDSCAPE = { width: 841.89, height: 595.28 };
const HANDOUT_MARGIN = 28;

export interface AssemblePdfResult {
  outputPath: string;
  pageCount: number;
  linkAnnotationCount: number;
}

/**
 * Ensambla una lista de imágenes (una por slide) en un único PDF, con el
 * tamaño de página EXACTO al tamaño lógico de cada slide (no un tamaño de
 * papel estándar tipo A4/Carta) e inserta anotaciones de link reconstruidas
 * por `link-mapper.ts`.
 *
 * Convención deliberada: 1 px CSS = 1 punto PDF. No es "físicamente exacto"
 * (un px CSS a 96dpi equivale a 0.75pt), pero es la convención que usan la
 * mayoría de herramientas HTML→PDF orientadas a reproducción visual en
 * pantalla — mantiene el PDF con las mismas proporciones y resolución
 * relativa que el HTML original sin necesidad de reescalar nada.
 */
export async function assemblePdf(options: AssemblePdfOptions): Promise<AssemblePdfResult> {
  if (options.slides.length === 0) {
    throw new Error("assemblePdf: no se recibió ninguna slide para ensamblar.");
  }

  const pdfDoc = await PDFDocument.create();

  if (options.layout === "handout-2up") {
    await assembleHandout2Up(pdfDoc, options.slides);
    const pdfBytes = await pdfDoc.save();
    await writeFile(options.outputPath, pdfBytes);
    return {
      outputPath: options.outputPath,
      pageCount: Math.ceil(options.slides.length / 2),
      linkAnnotationCount: 0,
    };
  }

  let linkAnnotationCount = 0;

  for (const slide of options.slides) {
    const imageBytes = await readFile(slide.filePath);
    const image = await embedImageAuto(pdfDoc, imageBytes, slide.filePath);

    const page = pdfDoc.addPage([slide.widthPx, slide.heightPx]);
    page.drawImage(image, { x: 0, y: 0, width: slide.widthPx, height: slide.heightPx });

    for (const link of slide.links ?? []) {
      addLinkAnnotation(pdfDoc, page, link, slide.heightPx);
      linkAnnotationCount++;
    }
  }

  const pdfBytes = await pdfDoc.save();
  await writeFile(options.outputPath, pdfBytes);

  return {
    outputPath: options.outputPath,
    pageCount: options.slides.length,
    linkAnnotationCount,
  };
}

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

      // j=0 → celda superior, j=1 → celda inferior. Origen PDF abajo-izquierda.
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
 * se construye el diccionario `/Annot /Link` manualmente y se registra en
 * el array `/Annots` de la página. El sistema de coordenadas de PDF tiene
 * su origen en la esquina INFERIOR izquierda (Y crece hacia arriba), por
 * eso se invierte `y` usando la altura de la página.
 */
function addLinkAnnotation(pdfDoc: PDFDocument, page: PDFPage, link: LinkAnnotation, pageHeightPt: number): void {
  const x0 = link.x;
  const x1 = link.x + link.width;
  const y0 = pageHeightPt - (link.y + link.height); // borde inferior en coords PDF
  const y1 = pageHeightPt - link.y; // borde superior en coords PDF

  const linkAnnotation = pdfDoc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [x0, y0, x1, y1],
    Border: [0, 0, 0], // sin borde visible dibujado por el visor de PDF
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
