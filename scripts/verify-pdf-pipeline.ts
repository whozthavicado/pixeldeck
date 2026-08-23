/**
 * Script manual de verificación fase 4: captura un deck con un link real,
 * ensambla el PDF, y vuelve a leer el PDF con pdf-lib para confirmar que
 * la anotación de link quedó bien formada (Rect + URI correctos).
 *
 * Uso: npx tsx scripts/verify-pdf-pipeline.ts <sourceDir> <workDir>
 */
import { captureDeck } from "../core-engine/capture-engine.js";
import { assemblePdf } from "../core-engine/pdf-assembler.js";
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFString } from "pdf-lib";
import { join } from "node:path";

const sourceDir = process.argv[2];
const workDir = process.argv[3];

if (!sourceDir || !workDir) {
  console.error("Uso: npx tsx scripts/verify-pdf-pipeline.ts <sourceDir> <workDir>");
  process.exit(1);
}

const outputDir = join(workDir, "captures");
const pdfPath = join(workDir, "output.pdf");

const captureResult = await captureDeck({ sourceDir, outputDir });
console.log(`Capturadas ${captureResult.slides.length} slides.`);
for (const slide of captureResult.slides) {
  console.log(`  #${slide.index + 1}: ${slide.links.length} link(s) detectado(s)`);
  for (const link of slide.links) {
    console.log(`    -> ${link.href} @ (${link.x.toFixed(1)}, ${link.y.toFixed(1)}) ${link.width.toFixed(1)}x${link.height.toFixed(1)}`);
  }
}

const assembleResult = await assemblePdf({
  slides: captureResult.slides.map((s) => ({ filePath: s.filePath, widthPx: s.widthPx, heightPx: s.heightPx, links: s.links })),
  outputPath: pdfPath,
});
console.log(`PDF ensamblado: ${assembleResult.outputPath} (${assembleResult.pageCount} páginas, ${assembleResult.linkAnnotationCount} anotaciones de link)`);

// Releer el PDF generado para confirmar que la anotación quedó bien formada.
const savedBytes = await import("node:fs/promises").then((fs) => fs.readFile(pdfPath));
const reloaded = await PDFDocument.load(savedBytes);
const pages = reloaded.getPages();
console.log(`Verificación de relectura: ${pages.length} página(s) en el PDF guardado.`);

for (let i = 0; i < pages.length; i++) {
  const annotsRef = pages[i].node.get(PDFName.of("Annots"));
  const annots = annotsRef instanceof PDFArray ? annotsRef : undefined;
  if (!annots || annots.size() === 0) {
    console.log(`  Página ${i + 1}: sin anotaciones.`);
    continue;
  }
  for (let j = 0; j < annots.size(); j++) {
    const annotDict = reloaded.context.lookup(annots.get(j), PDFDict);
    const rect = annotDict.get(PDFName.of("Rect"));
    const action = reloaded.context.lookup(annotDict.get(PDFName.of("A")), PDFDict);
    const uri = action?.get(PDFName.of("URI"));
    console.log(`  Página ${i + 1}: Rect=${rect?.toString()} URI=${uri instanceof PDFString ? uri.decodeText() : String(uri)}`);
  }
}
