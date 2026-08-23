/**
 * Auto-detección del tamaño NATIVO de un deck.
 *
 * Muchos decks declaran un "artboard" de tamaño fijo (1920x1080 es lo más
 * común) y luego lo escalan con CSS/JS para que quepa en el viewport real.
 * Si capturamos con un viewport arbitrario, la slide se renderiza escalada
 * hacia abajo y la captura pierde resolución de forma irrecuperable — el
 * texto queda re-fluido/reescalado, no simplemente más pequeño.
 *
 * Detectar el tamaño nativo y ajustar el viewport a ese tamaño ANTES de
 * capturar hace que el deck se renderice a escala 1:1, que es tanto más
 * fiel como más rápido (no hay transform de escalado en cada repaint).
 *
 * Este módulo se ejecuta DENTRO de la página (vía page.evaluate), así que
 * solo puede usar APIs DOM estándar.
 */

export interface DetectedDimensions {
  width: number;
  height: number;
  /** De dónde salió la medida — para logging y para poder auditar decisiones. */
  source: string;
  confidence: number;
}

/**
 * Mide la escala EFECTIVA de renderizado de una slide: cuánto encoge el
 * visor el artboard respecto a su tamaño de layout.
 *
 * Se calcula comparando el rect renderizado contra el tamaño de layout
 * computado. Es deliberadamente una medición del resultado y no una
 * inspección de los `transform` de los ancestros: los visores que escalan
 * el artboard (Claude Design deck-stage, Gamma, Tome, exports de Canva…)
 * suelen aplicar ese transform dentro de su propio shadow DOM, donde un
 * recorrido por `parentElement` no lo ve. Comparar rect vs layout funciona
 * sin importar dónde viva el transform.
 *
 * Devuelve 1 cuando no hay escalado (o no se puede medir con confianza).
 */
export function measureEffectiveScale(selector: string): number {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return 1;

  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  const layoutWidth = Number.parseFloat(style.width);
  const layoutHeight = Number.parseFloat(style.height);

  if (!Number.isFinite(layoutWidth) || !Number.isFinite(layoutHeight) || layoutWidth <= 0 || layoutHeight <= 0) return 1;
  if (rect.width <= 0 || rect.height <= 0) return 1;

  const scaleX = rect.width / layoutWidth;
  const scaleY = rect.height / layoutHeight;

  // Exigimos que ambos ejes coincidan (escalado uniforme). Si difieren, no
  // es un artboard escalado sino un layout responsive real, y compensar
  // sería incorrecto.
  if (Math.abs(scaleX - scaleY) > 0.02) return 1;
  if (!Number.isFinite(scaleX) || scaleX <= 0.05 || scaleX > 1.5) return 1;

  return scaleX;
}

/** Rango sano para un artboard de presentación; fuera de esto asumimos que la señal es basura. */
const MIN_DIMENSION = 320;
const MAX_DIMENSION = 8192;

function isSane(width: number, height: number): boolean {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= MIN_DIMENSION &&
    height >= MIN_DIMENSION &&
    width <= MAX_DIMENSION &&
    height <= MAX_DIMENSION
  );
}

/**
 * Devuelve el tamaño nativo declarado por el deck, o null si no hay ninguna
 * señal confiable (en cuyo caso el caller debe quedarse con su viewport).
 *
 * Se define como función serializable-a-string porque se inyecta en la
 * página; no puede cerrar sobre nada del scope de Node.
 */
export function detectDeckDimensions(): DetectedDimensions | null {
  const candidates: DetectedDimensions[] = [];

  const push = (width: number, height: number, source: string, confidence: number) => {
    const w = Math.round(width);
    const h = Math.round(height);
    if (isSane(w, h)) candidates.push({ width: w, height: h, source, confidence });
  };

  // 1. Atributos width/height explícitos en el contenedor del deck.
  //    Claude Design: <x-import component-from-global-scope="deck-stage" width="1920" height="1080">
  //    Es una declaración literal del autor del formato — la señal más fuerte posible.
  const declaredHosts = document.querySelectorAll("x-import[width][height], deck-stage[width][height], [data-deck-width][data-deck-height]");
  for (const host of Array.from(declaredHosts)) {
    const w = Number(host.getAttribute("width") ?? host.getAttribute("data-deck-width"));
    const h = Number(host.getAttribute("height") ?? host.getAttribute("data-deck-height"));
    push(w, h, `atributos width/height en <${host.tagName.toLowerCase()}>`, 0.97);
  }

  // 2. Configuración de Reveal.js expuesta en el global.
  const revealGlobal = (window as unknown as { Reveal?: { getConfig?: () => { width?: number; height?: number } } }).Reveal;
  if (revealGlobal?.getConfig) {
    try {
      const config = revealGlobal.getConfig();
      if (config?.width && config?.height) {
        push(config.width, config.height, "Reveal.getConfig()", 0.95);
      }
    } catch {
      // Reveal puede lanzar si aún no se inicializó — no es una señal utilizable.
    }
  }

  // 3. Contenido que desborda su caja renderizada: si un contenedor de slide
  //    tiene scrollWidth/scrollHeight mayores que su rect visible, el deck
  //    está siendo comprimido y el scroll size es el tamaño real pretendido.
  const slideish = document.querySelectorAll(
    "section[data-label], section[data-screen-label], .reveal .slides > section, .dc-artboard, [data-slide]"
  );
  for (const el of Array.from(slideish).slice(0, 5)) {
    const rect = el.getBoundingClientRect();
    const sw = (el as HTMLElement).scrollWidth;
    const sh = (el as HTMLElement).scrollHeight;
    // Solo cuenta como señal si el desbordamiento es significativo (>2%),
    // para no confundir 1px de redondeo con un artboard comprimido.
    if (sw > rect.width * 1.02 || sh > rect.height * 1.02) {
      push(sw, sh, "scrollWidth/scrollHeight desbordando el rect renderizado", 0.8);
      break;
    }
  }

  // 4. Un transform: scale() en la cadena de ancestros del deck implica que
  //    el tamaño sin escalar es el nativo.
  const firstSlide = slideish[0] as HTMLElement | undefined;
  if (firstSlide) {
    let node: HTMLElement | null = firstSlide;
    let accumulatedScale = 1;
    let depth = 0;
    while (node && depth < 8) {
      const transform = window.getComputedStyle(node).transform;
      if (transform && transform !== "none") {
        const match = /matrix\(([^,]+),/.exec(transform);
        if (match) {
          const scaleX = Number(match[1]);
          if (Number.isFinite(scaleX) && scaleX > 0 && scaleX < 1) accumulatedScale *= scaleX;
        }
      }
      node = node.parentElement;
      depth++;
    }
    if (accumulatedScale < 0.98) {
      const rect = firstSlide.getBoundingClientRect();
      push(rect.width / accumulatedScale, rect.height / accumulatedScale, `transform scale(${accumulatedScale.toFixed(3)}) en ancestros`, 0.85);
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates[0];
}
