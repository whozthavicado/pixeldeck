import { chromium, firefox, webkit, type Browser, type LaunchOptions } from "playwright";

/**
 * Pool de navegadores Playwright reutilizables, uno por engine y por proceso.
 *
 * Lanzar un navegador completo es la operación más cara del pipeline (cientos
 * de ms + memoria). El diseño stateless-por-request de PixelDeck no exige
 * lanzar uno nuevo cada vez: lo que debe estar aislado entre conversiones es
 * el `BrowserContext` (cookies, storage, service workers), no el proceso del
 * navegador. Este pool mantiene el proceso vivo y deja que `capture-engine`
 * cree y destruya un context por conversión.
 *
 * - `getBrowser(engine)` devuelve el navegador compartido, lanzándolo la
 *   primera vez. Cada llamada cuenta como "en uso" hasta el `release()`
 *   correspondiente — el cierre por inactividad solo ocurre con 0 usos activos.
 * - `PIXELDECK_HEADED=1` lanza con ventana visible y `slowMo`
 *   (`PIXELDECK_SLOWMO`, default 250 ms) para poder observar la detección y
 *   captura paso a paso. Solo para desarrollo.
 * - `PIXELDECK_BROWSER_IDLE_MS` (default 120000) es cuánto se mantiene vivo un
 *   navegador ocioso antes de cerrarlo. `0` desactiva el pool (cierra en cada
 *   `release`), útil en tests.
 * - `closeAll()` cierra todo — llamar en el apagado del proceso y en
 *   `afterAll` de los tests.
 */

export type BrowserEngine = "chromium" | "firefox" | "webkit";

const LAUNCHERS = { chromium, firefox, webkit } as const;

const IDLE_MS = Number(process.env.PIXELDECK_BROWSER_IDLE_MS ?? 120_000);
const HEADED = process.env.PIXELDECK_HEADED === "1" || process.env.PIXELDECK_HEADED === "true";
const SLOW_MO = Number(process.env.PIXELDECK_SLOWMO ?? 250);

interface PoolEntry {
  browser: Browser;
  activeCount: number;
  idleTimer: NodeJS.Timeout | null;
}

const entries = new Map<BrowserEngine, PoolEntry>();
/** Evita lanzar dos navegadores del mismo engine si llegan dos requests a la vez. */
const launching = new Map<BrowserEngine, Promise<Browser>>();

function launchOptions(): LaunchOptions {
  return HEADED ? { headless: false, slowMo: Number.isFinite(SLOW_MO) ? SLOW_MO : 250 } : {};
}

async function launch(engine: BrowserEngine): Promise<Browser> {
  const existing = launching.get(engine);
  if (existing) return existing;

  const promise = LAUNCHERS[engine].launch(launchOptions());
  launching.set(engine, promise);
  try {
    const browser = await promise;
    // Si el navegador muere por su cuenta (crash, cierre manual de la ventana
    // en modo headed), olvidamos la entrada para relanzar en el próximo uso.
    browser.on("disconnected", () => {
      if (entries.get(engine)?.browser === browser) entries.delete(engine);
    });
    entries.set(engine, { browser, activeCount: 0, idleTimer: null });
    return browser;
  } finally {
    launching.delete(engine);
  }
}

export interface BrowserLease {
  browser: Browser;
  /** Devuelve el navegador al pool. Idempotente. */
  release: () => void;
}

/**
 * Adquiere el navegador compartido del engine dado. El caller DEBE llamar a
 * `release()` cuando termine (en un `finally`), tanto en éxito como en error.
 */
export async function acquireBrowser(engine: BrowserEngine = "chromium"): Promise<BrowserLease> {
  let entry = entries.get(engine);
  if (!entry || !entry.browser.isConnected()) {
    await launch(engine);
    entry = entries.get(engine)!;
  }

  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  entry.activeCount++;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const current = entries.get(engine);
    if (!current) return;
    current.activeCount = Math.max(0, current.activeCount - 1);
    if (current.activeCount === 0) scheduleIdleClose(engine);
  };

  return { browser: entry.browser, release };
}

function scheduleIdleClose(engine: BrowserEngine): void {
  const entry = entries.get(engine);
  if (!entry) return;

  if (!Number.isFinite(IDLE_MS) || IDLE_MS <= 0) {
    // Pool desactivado: cerrar en cuanto queda ocioso.
    void closeEngine(engine);
    return;
  }

  entry.idleTimer = setTimeout(() => {
    const still = entries.get(engine);
    if (still && still.activeCount === 0) void closeEngine(engine);
  }, IDLE_MS);
  // No mantener vivo el event loop solo por este timer.
  entry.idleTimer.unref?.();
}

async function closeEngine(engine: BrowserEngine): Promise<void> {
  const entry = entries.get(engine);
  if (!entry) return;
  entries.delete(engine);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  await entry.browser.close().catch(() => undefined);
}

/** Cierra todos los navegadores del pool. Para el apagado del proceso y los tests. */
export async function closeAllBrowsers(): Promise<void> {
  await Promise.all([...entries.keys()].map((engine) => closeEngine(engine)));
}

/** Solo para tests/diagnóstico: nº de navegadores vivos en el pool. */
export function poolSize(): number {
  return entries.size;
}
