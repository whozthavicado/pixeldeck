import type { Page } from "playwright";
import type { LinkAnnotation } from "./types.js";

export interface SlideOrigin {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Reconstruye anotaciones de hipervínculo comparando la posición de los
 * elementos `<a href>` visibles dentro de una slide (ya aislada y estable,
 * en el mismo estado que se usó para la captura de imagen) contra el
 * bounding box de la propia slide, para obtener coordenadas relativas al
 * origen de la slide que luego se puedan convertir a coordenadas de PDF.
 *
 * Debe llamarse EN EL MISMO MOMENTO que la captura final de imagen (mismo
 * estado de aislamiento/scroll), o las coordenadas quedarán desalineadas.
 */
export async function extractLinkAnnotations(page: Page, slideSelector: string, slideOrigin: SlideOrigin): Promise<LinkAnnotation[]> {
  const rawLinks = await page.evaluate(
    ({ slideSelector, originX, originY }) => {
      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(`${slideSelector} a[href]`));

      return anchors
        .map((a) => {
          const rect = a.getBoundingClientRect();
          const style = window.getComputedStyle(a);
          const isVisible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            Number.parseFloat(style.opacity || "1") > 0;

          if (!isVisible) return null;

          return {
            href: a.getAttribute("href") ?? "",
            x: rect.x - originX,
            y: rect.y - originY,
            width: rect.width,
            height: rect.height,
          };
        })
        .filter((link): link is NonNullable<typeof link> => link !== null)
        .filter((link) => link.href.length > 0 && !link.href.startsWith("#"));
    },
    { slideSelector, originX: slideOrigin.x, originY: slideOrigin.y }
  );

  // Recortamos cualquier link cuyo rect quede parcial o totalmente fuera de
  // los límites de la slide (puede pasar si el aislamiento por !important
  // deja algo desbordando) para no generar anotaciones con Rect inválido.
  return rawLinks
    .map((link) => clampToSlideBounds(link, slideOrigin))
    .filter((link) => link.width > 0 && link.height > 0);
}

function clampToSlideBounds(link: LinkAnnotation, origin: SlideOrigin): LinkAnnotation {
  const x0 = Math.max(0, link.x);
  const y0 = Math.max(0, link.y);
  const x1 = Math.min(origin.width, link.x + link.width);
  const y1 = Math.min(origin.height, link.y + link.height);

  return { href: link.href, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
