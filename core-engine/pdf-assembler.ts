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

export interface AssemblePdfOptions {
  /** Slides ya en el orden final de presentación. */
  slides: AssemblableSlide[];
  outputPath: string;
}

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
