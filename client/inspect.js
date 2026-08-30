/**
 * Inspección local del archivo subido, antes de convertir. Mira el .html (o
 * el inventario del .zip vía zip-peek) y devuelve:
 *   - `recommendation`: valores sugeridos para los controles del formulario.
 *   - `notes`: frases legibles para el panel de reconocimiento.
 *
 * Todo ocurre en el navegador — nada se sube en esta fase. Para .zip solo se
 * leen nombres de archivo (el contenido va comprimido); por eso la
 * recomendación de framework para .zip se basa en nombres, no en el HTML.
 *
 * Expone `window.pixeldeckInspect(file) -> Promise<Result>`.
 */
(() => {
  "use strict";

  const MAX_HTML_SNIFF = 2 * 1024 * 1024; // leer como máx 2 MB del HTML

  async function readHtmlHead(file) {
    const slice = file.slice(0, Math.min(file.size, MAX_HTML_SNIFF));
    return slice.text();
  }

  function sniffHtml(html) {
    const rec = {};
    const notes = [];
    const lower = html.toLowerCase();

    // ── Framework / origen ──────────────────────────────────────────────
    if (/component-from-global-scope=["']deck-stage["']/.test(html) || /data-screen-label=/.test(html)) {
      rec.sourceKind = "claude-design";
      notes.push("Firma de Claude Design (deck-stage) detectada.");
    } else if (/class=["'][^"']*\breveal\b/.test(lower) || /reveal\.js|reveal\.min\.js/.test(lower)) {
      rec.sourceKind = "reveal";
      notes.push("Reveal.js detectado.");
    } else if (/\bimpress\s*\(/.test(lower) || /id=["']impress["']/.test(lower)) {
      rec.sourceKind = "impress";
      notes.push("impress.js detectado.");
    } else if (/punch-viewer|docs-slide/.test(lower)) {
      rec.sourceKind = "google-slides";
      notes.push("Export de Google Slides detectado.");
    }

    // ── Tamaño nativo ──────────────────────────────────────────────────
    const dcSize = /(?:x-import|deck-stage)[^>]*\bwidth=["'](\d{3,4})["'][^>]*\bheight=["'](\d{3,4})["']/i.exec(html);
    const revealSize = /width\s*:\s*(\d{3,4})\s*,\s*height\s*:\s*(\d{3,4})/.exec(html);
    const size = dcSize || revealSize;
    if (size) {
      const w = Number(size[1]);
      const h = Number(size[2]);
      const match = matchNativeSize(w, h);
      if (match) {
        rec.nativeSize = match;
        notes.push(`Artboard declarado ${w}×${h}.`);
      }
    }

    // ── Forma / conteo de slides ──────────────────────────────────────
    const sectionCount = (html.match(/<section[\s>]/gi) || []).length;
    const slideClassCount = (html.match(/class=["'][^"']*\bslide\b/gi) || []).length;
    const screenLabels = (html.match(/data-screen-label=/gi) || []).length;
    const slideGuess = Math.max(screenLabels, sectionCount, slideClassCount);
    if (slideGuess >= 2) {
      rec.contentShape = "deck";
      notes.push(`~${slideGuess} diapositivas detectadas → deck.`);
    } else if (slideGuess <= 1 && html.length > 0) {
      notes.push("Sin estructura de slides clara — considera Página o Scroll.");
    }

    // ── Riesgos del pipeline de impresión (informativo) ────────────────
    const risks = [];
    if (/@media\s+print/.test(lower)) risks.push("@media print");
    if (/background-clip\s*:\s*text|-webkit-background-clip\s*:\s*text/.test(lower)) risks.push("texto con gradiente");
    if (/backdrop-filter\s*:/.test(lower)) risks.push("backdrop-filter");
    if (/@font-face/.test(lower)) risks.push("fuentes @font-face");
    if (risks.length) notes.push(`Frágil al imprimir: ${risks.join(", ")} — PixelDeck lo preserva.`);

    return { rec, notes };
  }

  function matchNativeSize(w, h) {
    if (w === 1920 && h === 1080) return "1920x1080";
    if (w === 1280 && h === 720) return "1280x720";
    if (w === 1024 && h === 768) return "1024x768";
    if (w === 794 && h === 1123) return "a4-portrait";
    // Proporción 16:9 arbitraria → sugerir el preset 1920×1080 igualmente.
    if (Math.abs(w / h - 16 / 9) < 0.02) return "1920x1080";
    if (Math.abs(w / h - 4 / 3) < 0.02) return "1024x768";
    return null;
  }

  function sniffZip(entries, totalUncompressed) {
    const rec = {};
    const notes = [];
    const names = entries.map((e) => e.name.toLowerCase());

    if (names.some((n) => /reveal(\.min)?\.js$/.test(n))) {
      rec.sourceKind = "reveal";
      notes.push("Reveal.js en el paquete.");
    } else if (names.some((n) => /impress(\.min)?\.js$/.test(n))) {
      rec.sourceKind = "impress";
      notes.push("impress.js en el paquete.");
    }

    const htmlEntries = entries
      .filter((e) => /\.html?$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

    if (htmlEntries.length === 0) {
      notes.push("⚠ No se ve ningún .html en el .zip.");
    } else if (htmlEntries.length === 1) {
      notes.push(`HTML de entrada: ${htmlEntries[0]}`);
      rec.entryFile = htmlEntries[0];
    } else {
      const rooted = htmlEntries.find((n) => /(^|\/)index\.html?$/i.test(n));
      rec.entryFile = rooted || htmlEntries[0];
      rec.entryFiles = htmlEntries;
      notes.push(`⚠ El .zip trae ${htmlEntries.length} presentaciones — elige cuál convertir arriba.`);
    }

    if (names.some((n) => /(^|\/)fonts?\//.test(n) || /\.(woff2?|ttf|otf)$/.test(n))) {
      notes.push("Fuentes incluidas — se esperará a que carguen.");
    }

    const imageCount = names.filter((n) => /\.(png|jpe?g|webp|avif)$/.test(n)).length;
    if (imageCount >= 8) {
      notes.push(`${imageCount} imágenes en el paquete — densidad 2× suele bastar.`);
      rec.scale = 2;
    }

    if (totalUncompressed > 40 * 1024 * 1024) {
      notes.push(`Contenido ~${(totalUncompressed / 1048576).toFixed(0)} MB descomprimido — cerca del límite de 50 MB.`);
    }

    return { rec, notes };
  }

  async function pixeldeckInspect(file) {
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith(".zip")) {
        const { entries, totalUncompressed } = await window.zipPeek(file);
        const { rec, notes } = sniffZip(entries, totalUncompressed);
        return { recommendation: rec, notes: notes.length ? notes : ["ZIP leído — sin señales fuertes; usa Auto."] };
      }
      const html = await readHtmlHead(file);
      const { rec, notes } = sniffHtml(html);
      return { recommendation: rec, notes: notes.length ? notes : ["HTML leído — sin señales fuertes; usa Auto."] };
    } catch (err) {
      return { recommendation: {}, notes: [`No se pudo inspeccionar el archivo (${err && err.message ? err.message : "error"}). Usa Auto.`] };
    }
  }

  window.pixeldeckInspect = pixeldeckInspect;
})();
