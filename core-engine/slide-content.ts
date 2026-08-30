/**
 * Extracción de contenido de una slide para el PDF: etiqueta (índice),
 * notas del orador y fragmentos de texto posicionados (capa de texto
 * invisible seleccionable/buscable).
 *
 * Toda la lógica corre DENTRO de la página real. Igual que `slide-detector`
 * y `deck-dimensions`, se expone a través del bundle inyectado
 * (`browser-entry.ts` → `window.__pixeldeck`), NO como una función pasada
 * suelta a `page.evaluate`: los transforms de esbuild/tsx pueden instrumentar
 * una función suelta con helpers (`__name`) que no existen en el navegador.
 */

export interface TextRun {
  text: string;
  /** Caja en px CSS relativa al origen de la slide (esquina superior izquierda). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SlideContent {
  label: string | null;
  notes: string | null;
  textRuns: TextRun[];
}

export interface SlideContentOptions {
  textLayer: boolean;
  notes: boolean;
}

interface Origin {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clean(s: string | null | undefined): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

/**
 * Recorre `document` buscando la slide `slideSelector` (ya aislada y estable)
 * y devuelve su contenido. Función pura sobre el DOM estándar — testeable
 * con jsdom y segura de bundlear para el navegador.
 */
export function collectSlideContent(
  document: Document,
  slideSelector: string,
  origin: Origin,
  options: SlideContentOptions
): SlideContent {
  const el = document.querySelector(slideSelector) as HTMLElement | null;
  if (!el) return { label: null, notes: null, textRuns: [] };

  const heading = clean(el.querySelector("h1, h2, h3, [role='heading']")?.textContent);
  const label = clean(el.getAttribute("data-label")) ?? clean(el.getAttribute("aria-label")) ?? (heading ? heading.slice(0, 90) : null);

  let notes: string | null = null;
  if (options.notes) {
    notes =
      clean(el.getAttribute("data-speaker-notes")) ??
      clean(el.getAttribute("data-notes")) ??
      clean(el.querySelector("aside.notes, .speaker-notes, [data-notes], .notes")?.textContent) ??
      null;
  }

  if (!options.textLayer) return { label, notes, textRuns: [] };

  const win = document.defaultView;
  const getStyle = (node: Element): CSSStyleDeclaration | null => (win ? win.getComputedStyle(node) : null);

  const textRuns: TextRun[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);

  let node: Node | null = walker.nextNode();
  while (node) {
    const raw = node.nodeValue ?? "";
    const parent = node.parentElement;
    const parentTag = parent?.tagName;
    const visible =
      parent &&
      parentTag !== "SCRIPT" &&
      parentTag !== "STYLE" &&
      parentTag !== "NOSCRIPT" &&
      /\S/.test(raw) &&
      (() => {
        const style = getStyle(parent);
        return !style || (style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") !== 0);
      })();

    if (visible) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      if (typeof range.detach === "function") range.detach();

      if (rects.length > 0) {
        const totalWidth = rects.reduce((sum, r) => sum + r.width, 0) || 1;
        const trimmed = raw.replace(/\s+/g, " ");
        let consumed = 0;
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          const isLast = i === rects.length - 1;
          const share = isLast ? trimmed.length - consumed : Math.round((r.width / totalWidth) * trimmed.length);
          const piece = trimmed.slice(consumed, consumed + share).trim();
          consumed += share;
          if (!piece) continue;
          const x = r.left - origin.x;
          const y = r.top - origin.y;
          if (x + r.width < 0 || y + r.height < 0 || x > origin.width || y > origin.height) continue;
          textRuns.push({ text: piece, x, y, width: r.width, height: r.height });
        }
      }
    }
    node = walker.nextNode();
  }

  return { label, notes, textRuns };
}
