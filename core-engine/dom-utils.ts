/**
 * Utilidades DOM compartidas por las estrategias de detección.
 * Sin dependencias de Node ni de un navegador específico — DOM estándar únicamente.
 */

/**
 * Construye un selector CSS único y estable para `el`, subiendo por sus
 * ancestros hasta encontrar un `id` o llegar a la raíz. Se usa para poder
 * re-ubicar el mismo elemento más adelante en el pipeline de Playwright
 * (capture-engine, fase 3), donde no tenemos la referencia directa al nodo.
 */
export function getUniqueSelector(el: Element): string {
  if (el.id) {
    return `#${cssEscape(el.id)}`;
  }

  const path: string[] = [];
  let current: Element | null = el;

  while (current && current.nodeType === 1 && current.tagName.toLowerCase() !== "html") {
    let segment = current.tagName.toLowerCase();

    if (current.id) {
      path.unshift(`#${cssEscape(current.id)}`);
      break;
    }

    const parent = current.parentElement;
    if (parent) {
      const siblingsOfSameTag = Array.from(parent.children).filter(
        (sibling) => sibling.tagName === current!.tagName
      );
      if (siblingsOfSameTag.length > 1) {
        const position = siblingsOfSameTag.indexOf(current) + 1;
        segment += `:nth-of-type(${position})`;
      }
    }

    path.unshift(segment);
    current = current.parentElement;
  }

  return path.join(" > ");
}

function cssEscape(value: string): string {
  // Escape mínimo suficiente para ids típicos (evita romper el selector con
  // caracteres especiales de CSS como ':' o '.').
  return value.replace(/([:.#[\]()])/g, "\\$1");
}

/**
 * Extrae el texto de todos los bloques `<style>` del documento, más el de
 * hojas `<link>` que ya hayan sido inlineadas por el fetcher (fase de
 * server-side no debe depender de red externa en esta capa). Se usa para
 * heurísticas de altura de pantalla completa cuando no hay `getComputedStyle`
 * fiable disponible (p. ej. en jsdom durante los tests).
 */
export function collectInlineStylesheetText(document: Document): string {
  const styleTags = Array.from(document.querySelectorAll("style"));
  return styleTags.map((tag) => tag.textContent ?? "").join("\n");
}

const FULLSCREEN_HEIGHT_TOKENS = new Set(["100vh", "100dvh", "100svh", "100lvh"]);

/**
 * Detecta si un valor de altura declarado corresponde a pantalla completa.
 * Nota: "100%" se excluye a propósito por ser demasiado ambiguo por sí solo
 * (aplica a cualquier contenedor con altura relativa, no solo a slides).
 */
export function isFullscreenHeightValue(value: string | null | undefined): boolean {
  if (!value) return false;
  return FULLSCREEN_HEIGHT_TOKENS.has(value.trim().toLowerCase());
}
