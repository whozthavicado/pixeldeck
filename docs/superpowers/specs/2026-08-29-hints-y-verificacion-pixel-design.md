# PixelDeck v0.2 — Hints declarativos, navegador persistente/observable y verificación pixel-diff

Fecha: 2026-08-29
Estado: aprobado (brainstorming)
Base: commit `4473c5e`

## Motivación

Hoy toda conversión hace: lanzar un Chromium nuevo → auto-detectar dimensiones →
correr 4 estrategias de detección de slides con scoring → compensar escala →
capturar. Es robusto pero:

1. **Lento por conversión** — se paga el arranque completo de un navegador cada vez.
2. **Adivina** lo que el usuario ya sabe: qué herramienta generó el deck, qué forma
   tiene (deck vs. página única vs. scroll largo), su tamaño nativo y qué salida
   quiere. Esa adivinación puede fallar y no hay forma de que el usuario la dirija.
3. **No verifica** que la captura final sea fiel: `stability-watcher` espera a que
   dos capturas *de sondeo* (a `scale: "css"`, recortadas) coincidan, pero la
   captura final a resolución completa nunca se contrasta contra nada.

Esta revisión añade una vía declarativa (el usuario declara; el motor obedece y
solo cae a la detección automática si el hint no aplica), reutiliza el navegador
entre conversiones, permite observarlo, y agrega un paso de verificación
pixel-a-pixel de cada slide.

## Alcance

Cuatro piezas independientes. Ninguna cambia el comportamiento por defecto salvo
la #4 (verificación), que es opt-out.

### 1. Hints declarativos en `POST /convert`

Cuatro campos de formulario nuevos, todos opcionales. Ausente o `auto` = exactamente
el comportamiento actual.

| Campo | Valores | Efecto en el motor |
|---|---|---|
| `sourceKind` | `claude-design`, `reveal`, `impress`, `google-slides`, `generic-slide-class`, `auto` | Si ≠ `auto`: se construye **una única estrategia forzada** a partir de la fila correspondiente de `KNOWN_SIGNATURES` (que se exporta desde `known-framework-signature.ts`), con `confidence` 1.0, y se **omiten** las demás estrategias. Si su selector matchea 0 elementos en la página real → se cae a la detección completa (con un warning en el log), nunca se falla en duro. |
| `contentShape` | `deck`, `single-page`, `long-scroll`, `auto` | `deck` = comportamiento normal. `single-page` = se omite la detección: la raíz del deck (o `<body>`) es la única "slide". `long-scroll` = una sola slide de altura completa; captura `fullPage`. |
| `nativeSize` | `1920x1080`, `1280x720`, `1024x768`, `a4-portrait` (794×1123), `auto` | Si ≠ `auto`: se fija el viewport directamente y se **omite** `detectDeckDimensions()`. La compensación de escala efectiva (`measureEffectiveScale`) se mantiene: sigue siendo válida aunque el tamaño sea conocido. |
| `expectedResult` | `pdf-multipage`, `image-per-slide`, `single-image`, `handout-2up`, (vacío) | Dirige el ensamblaje. Vacío = derivado de `format` como hoy (`pdf`→`pdf-multipage`, `png`/`jpg`→`image-per-slide` o `single-image` si hay 1 slide). `single-image` fuerza tratar el resultado como una sola slide. `handout-2up` = PDF con 2 slides por página A4 apaisada (modo nuevo del ensamblador). |

Compatibilidad: `format` y `scale` siguen igual. `expectedResult` y `format` coexisten
— `format` decide PNG vs JPG vs PDF de las imágenes; `expectedResult` decide la
disposición.

Validación: cada campo se valida contra su lista; un valor desconocido → 400 con
mensaje claro (igual estilo que `parseFormat`).

### 2. Inspección en el cliente y recomendación (sin dependencias, sin request extra)

Al soltar/elegir el archivo, **antes** de convertir, el cliente lo inspecciona
localmente y (a) muestra un panel "Detecté: …" y (b) preselecciona los controles.
El usuario puede sobrescribir cualquiera.

- **`.html`**: `FileReader.readAsText`. Búsquedas de texto/regex:
  - Framework: `class="reveal"` / `reveal.js`; `impress(`; `data-screen-label` o
    `component-from-global-scope="deck-stage"` (Claude Design); `punch-viewer`
    (Google Slides); `class="slide"` repetido.
  - Riesgos del pipeline de impresión (solo informativo, para el panel):
    `@media print`, `background-clip`, `-webkit-background-clip`, `backdrop-filter`,
    `@font-face`.
  - Conteo aproximado de slides: nº de `<section`, de `class="slide`, de
    `data-screen-label`.
  - Tamaño nativo: atributos `width="1920" height="1080"` en `x-import`/`deck-stage`;
    `Reveal.initialize({ width:, height: })` por regex.
- **`.zip`**: parseo del *central directory* en JS vanilla (nuevo
  `client/zip-peek.js`). El central directory está al final del archivo, con
  nombres y tamaños **sin comprimir** — no hace falta inflar nada. Se leen los
  últimos ~64 KB del `File` vía `.slice()`, se localiza la firma EOCD
  (`0x06054b50`), se recorre la lista de headers `0x02014b50`. De ahí:
  - Ubicación del `index.html` / primer `.html`.
  - Presencia de `reveal.js` / `reveal.min.js`, carpeta `fonts/`, muchos
    `slide-*.png` / `*.jpg` (assets pesados → sugerir densidad menor).
  - Tamaño total descomprimido (de los headers) → aviso si se acerca al límite.
  - **No** se lee el contenido del HTML dentro del zip (requeriría inflate); la
    recomendación de framework para zips se basa en nombres de archivo. Si no hay
    señal, `sourceKind` queda en `auto`.
- **Recomendación** → objeto `{ sourceKind, contentShape, nativeSize, format, scale,
  notes: string[] }`. `notes` alimenta el panel ("Fuentes personalizadas
  detectadas — se esperará a `fonts.ready`", "7 secciones → deck", etc.).

UI (`client/index.html`): tras `.loaded`, un panel `.recon` (lista de `notes`) y
tres `<fieldset>` nuevos con controles segmentados del mismo estilo existente:
**Origen** (`sourceKind`), **Forma** (`contentShape`), **Tamaño** (`nativeSize`).
El fieldset "Salida" pasa a representar `expectedResult` (PDF · PDF 2-up · 1 imagen
por slide · Imagen única); `format` (PNG/JPG cuando aplica) se muestra como
sub-control. Todos los fieldsets nuevos incluyen la opción `Auto` y arrancan en
ella salvo que la inspección diga otra cosa.

### 3. Navegador persistente + observable

- **`core-engine/browser-pool.ts`** (nuevo). Singleton a nivel de módulo:
  `getBrowser(engine): Promise<Browser>` mantiene un `Browser` lanzado por engine y
  lo reutiliza. `newContext`/`newPage` siguen creándose y cerrándose por
  conversión — el aislamiento entre requests no cambia. Un temporizador de
  inactividad (`PIXELDECK_BROWSER_IDLE_MS`, default 120 000) cierra el navegador
  cuando no hay conversiones en vuelo; la siguiente lo relanza. `closeAll()` para
  el apagado del proceso (hook `SIGTERM`/`SIGINT` en `server/index.ts`) y para los
  tests.
- `captureDeck` gana `reuseBrowser?: boolean`. Default **true** desde
  `conversion-pipeline.ts`; los tests unit/e2e pasan `false` (o llaman `closeAll()`
  en `afterAll`) para no filtrar procesos entre archivos de test.
- El timeout que hoy hace `browser.close()` para abortar pasa a cerrar solo el
  **context** en curso (que también rechaza las llamadas de Playwright pendientes)
  cuando `reuseBrowser` está activo — no se mata el navegador compartido.
- **Observable**: env `PIXELDECK_HEADED=1` → el pool lanza con
  `{ headless: false, slowMo: Number(PIXELDECK_SLOWMO ?? 250) }`. Solo para
  desarrollo/depuración; sin efecto en el default. Documentado en README.

### 4. Verificación pixel-diff de la captura final

En `captureSingleSlide`, tras el `page.screenshot` final:

1. Tomar **una segunda** captura idéntica (mismo `clip`, mismo `type`).
2. Comparar ambas con `pixelmatch` (misma utilidad que `stability-watcher`;
   factorizar `diffRatioBetween` a `core-engine/image-diff.ts` y reutilizar).
3. Si `diffRatio > verifyThreshold` (default `0.001`, = el `stablePixelRatio`):
   la slide **no** estaba realmente asentada. Reintentar una vez: esperar
   `verifyResettleMs` (default 400) y repetir desde el paso 1, hasta
   `verifyMaxRetries` (default 1).
4. Tras agotar reintentos, quedarse con la última captura y marcar
   `verified: false` en el `CapturedSlide`. No es un error — es información.

`CaptureResult` expone `verifiedCount` / `slideCount`. `conversion-pipeline`
lo propaga; `convert.ts` añade header `X-PixelDeck-Verified: N/M`. El cliente lo
muestra en la tabla de resultado ("Verificadas: 8/8"). Si `N < M`, la fila se
pinta en color de advertencia.

Opt-out: `stability`/nuevo `verify` en `CaptureOptions` con `{ enabled: false }`.
Config expuesta por env: `PIXELDECK_VERIFY=0` la desactiva a nivel servidor.

## Cambios por archivo

| Archivo | Cambio |
|---|---|
| `server/routes/convert.ts` | Parsear y validar `sourceKind`, `contentShape`, `nativeSize`, `expectedResult`. Header `X-PixelDeck-Verified`. |
| `server/conversion-pipeline.ts` | Pasar hints a `captureDeck`; elegir modo de ensamblado según `expectedResult`; propagar `verifiedCount`. |
| `server/index.ts` | Hook `SIGTERM`/`SIGINT` → `browserPool.closeAll()`. Log de las env vars nuevas al arrancar. |
| `core-engine/capture-engine.ts` | `reuseBrowser`; `forcedSourceKind`; `forcedViewport`/`skipDimensionDetection`; `contentShape`; paso de verificación; timeout que cierra context (no browser) en modo pool. |
| `core-engine/browser-pool.ts` | **Nuevo.** Pool singleton por engine + idle-close + `closeAll` + modo headed. |
| `core-engine/image-diff.ts` | **Nuevo.** `diffRatio(bufferA, bufferB, threshold)` extraído de `stability-watcher.ts` (que pasa a importarlo). |
| `core-engine/strategies/known-framework-signature.ts` | `export const KNOWN_SIGNATURES`. Helper `signatureFor(name)`. |
| `core-engine/strategies/index.ts` | Re-exportar `KNOWN_SIGNATURES`. |
| `core-engine/forced-strategy.ts` | **Nuevo.** `buildForcedStrategy(sourceKind): DetectionStrategy` que envuelve un selector conocido con confidence 1.0 y `slides` = `querySelectorAll` de ese selector. |
| `core-engine/browser-entry.ts` | Exponer `window.__pixeldeck.detectSlidesForced(selector)` y `detectSingle(rootSelector)` para `single-page`/`long-scroll`. |
| `core-engine/pdf-assembler.ts` | Modo `handout-2up`: página A4 apaisada (842×595 pt), 2 slides escaladas a la mitad con margen; sin anotaciones de link en este modo (v0.2). |
| `client/zip-peek.js` | **Nuevo.** Lector de central-directory de ZIP en vanilla JS. |
| `client/index.html` | Panel `.recon`; fieldsets Origen/Forma/Tamaño; "Salida" = `expectedResult`; lógica de inspección + preselección; envío de los campos nuevos; fila "Verificadas" en el resultado. |
| `README.md` | Documentar los 4 params, las env vars (`PIXELDECK_HEADED`, `PIXELDECK_SLOWMO`, `PIXELDECK_BROWSER_IDLE_MS`, `PIXELDECK_VERIFY`) y el flujo declarativo. |

## Tests

Unit (`npm test`, jsdom, sin navegador):
- `forced-strategy.test.ts`: `buildForcedStrategy("claude-design")` sobre el fixture
  de deck-stage devuelve las N slides con confidence 1; sobre un fixture que no
  matchea devuelve `slides: []` (→ el motor cae a detección completa).
- `zip-peek.test.ts`: contra un `.zip` fixture nuevo
  (`tests/fixtures/zip/reveal-bundle.zip`) — localiza `index.html`, detecta
  `reveal.min.js`, lista de nombres correcta.
- `pdf-assembler.test.ts`: `handout-2up` con 5 slides → `pageCount` 3; dimensiones
  de página A4 apaisada.
- `image-diff.test.ts`: dos PNG idénticos → ratio 0; con 5% de píxeles cambiados →
  ratio ≈ 0.05.

E2E (`npm run test:e2e`, Playwright real):
- `sourceKind: "claude-design"` sobre un fixture deck-stage → `detection.winningStrategy`
  = `forced:claude-design`, `detectionMs` mucho menor que la corrida `auto`.
- `expectedResult: "handout-2up"` → PDF con `ceil(slides/2)` páginas.
- Verificación: deck estático → `verifiedCount === slideCount`. Deck con animación
  infinita corta (nuevo fixture) → `verifiedCount < slideCount` sin lanzar error.
- `browser-pool`: dos `captureDeck` consecutivos con `reuseBrowser: true` comparten
  el mismo pid de navegador; `closeAll()` lo cierra.

## No incluido (YAGNI)

- Cola/analizador server-side previo (`/inspect`): descartado — la inspección
  cliente cubre la recomendación sin round-trip.
- Anotaciones de link en `handout-2up`: fuera de alcance de v0.2.
- Persistencia del pool entre réplicas: el modelo stateless-por-request del README
  no cambia; el pool es por proceso.
- Selección de engine (firefox/webkit) desde la UI: sigue siendo solo por API/env.

## Verificación de entrega

`npm run build` sin errores de tsc · `npm test` verde · `npm run test:e2e` verde ·
`npm run lint` limpio · `npm run dev` levanta y `http://localhost:4000` sirve la
página nueva · una conversión real de un deck Claude Design end-to-end con
`sourceKind` explícito produce el PDF y `X-PixelDeck-Verified` = `N/N`.
