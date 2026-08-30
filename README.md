# PixelDeck

[![CI](https://github.com/whozthavicado/pixeldeck/actions/workflows/ci.yml/badge.svg)](https://github.com/whozthavicado/pixeldeck/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pixeldeck)](https://www.npmjs.com/package/pixeldeck)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Docker](https://img.shields.io/badge/ghcr.io-pixeldeck-2496ED?logo=docker&logoColor=white)](https://github.com/whozthavicado/pixeldeck/pkgs/container/pixeldeck)

Convierte presentaciones HTML/CSS (generadas por IA — **Claude Design, ChatGPT Canvas, Gemini, v0, Reveal.js**, etc.) en PDF, JPG o PNG **pixel-perfect**, rasterizando cada slide en un navegador real en modo `screen` — sin pasar por el pipeline de impresión del navegador (`@media print`) que rompe gradientes, sombras y tipografías.

Gratis y de código abierto (MIT). Úsalo como **CLI**, **librería**, **contenedor Docker**, **GitHub Action** o **servidor con UI**.

```bash
npx pixeldeck deck.zip --source-kind claude-design -o deck.pdf
```

## Instalar / usar

| Vía | Comando |
|---|---|
| **npx** (sin instalar) | `npx pixeldeck deck.html` |
| **Global** | `npm i -g pixeldeck` · luego `pixeldeck deck.zip` |
| **Docker (servidor + UI)** | `docker run --rm -p 4000:4000 ghcr.io/whozthavicado/pixeldeck` → abre `http://localhost:4000` |
| **GitHub Action** | ver [abajo](#github-action) |
| **Desde el código** | `git clone` · `npm install` · `npm run dev` |

### CLI

```bash
pixeldeck <entrada.html|entrada.zip> [opciones]

  -o, --out <ruta>         archivo de salida (default: ./<nombre>.<pdf|zip|png>)
  -f, --format <fmt>       pdf | png | jpg                         (default: pdf)
  -s, --scale <1-4>        densidad / DPR                          (default: 2)
  -r, --result <modo>      pdf-multipage | handout-2up |
                           image-per-slide | single-image
  -e, --entry <archivo>    qué HTML del .zip convertir
      --source-kind <k>    claude-design | reveal | impress | google-slides | generic-slide-class
      --content-shape <s>  deck | single-page | long-scroll
      --native-size <t>    1920x1080 | 1280x720 | 1024x768 | a4-portrait
      --engine <e>         chromium | firefox | webkit
      --no-verify          desactiva la verificación pixel-diff
      --json               resultado como JSON en stdout
```

```bash
pixeldeck deck.zip --entry "Suiza - Avance.dc.html" -r handout-2up
pixeldeck poster.html --content-shape single-page -f png
pixeldeck deck.zip --json > result.json
```

### GitHub Action

```yaml
- uses: whozthavicado/pixeldeck@v1
  with:
    input: slides/deck.zip
    output: dist/deck.pdf
    source-kind: claude-design
- uses: actions/upload-artifact@v4
  with:
    name: deck-pdf
    path: dist/deck.pdf
```

Salidas: `output`, `slides`, `verified` (`"N/M"`).

## El problema

Cuando exportas un deck HTML con "Imprimir → Guardar como PDF", el navegador cambia a media type `print` y rompe:

- `background-clip: text` (títulos con gradiente) → texto sólido o invisible.
- `box-shadow` → mancha negra o desaparece.
- `backdrop-filter` (glassmorphism) → desaparece.
- `linear-gradient()` en fondos → se elimina para "ahorrar tinta".
- `@font-face` personalizadas → caen a fuentes del sistema.
- `height: 100vh` → se corta a la mitad entre páginas.
- Navegación por JS (Reveal.js, toggles, `keydown`) → solo imprime la primera slide visible.

## El enfoque de PixelDeck

En vez de usar el pipeline de impresión, PixelDeck renderiza cada slide en modo `screen` dentro de un navegador real headless, espera a que el layout se estabilice visualmente, captura cada slide como imagen de alta resolución, y ensambla esas imágenes en un PDF con el tamaño exacto de cada slide (o las entrega como JPG/PNG).

## Decisiones técnicas y por qué difieren de herramientas similares

PixelDeck no es un clon de ninguna herramienta existente que resuelva este mismo problema (p. ej. "Renditions"). Se diseñó desde cero con una metodología propia:

1. **Playwright en vez de Puppeteer** — soporta Chromium, Firefox y WebKit con la misma API. Esto es una diferencia arquitectónica real: permite renderizar el mismo deck en varios motores y comparar (útil quirks de fuentes/gradientes entre motores), algo que un pipeline atado solo a Chromium/Puppeteer no ofrece de forma nativa.

2. **Detección de slides basada en scoring, no en heurísticas fijas** — en vez de una cadena de `if/else` tipo "si es Reveal.js hazlo así, si tiene `100vh` hazlo asá", cada estrategia de detección es un módulo independiente que devuelve una **confianza (0–1)** sobre si sus candidatos son "la" lista de slides. El orquestador combina resultados: si dos estrategias coinciden en el mismo set de elementos, la confianza compuesta sube. Esto hace el sistema extensible (agregar una estrategia nueva no toca las demás) y auditable (se puede loguear por qué se eligió tal estrategia).

3. **Espera de estabilidad visual por diff de screenshots, no por temporizadores fijos** — en vez de `sleep(2000)` o esperar solo `fonts.ready` + fin de animaciones CSS declaradas, PixelDeck toma capturas sucesivas de la slide y las compara (diff de píxeles / hash perceptual) hasta que dos capturas consecutivas sean prácticamente idénticas. Esto cubre animaciones JS no declarativas, fuentes que tardan en aplicar, e imágenes remotas con carga lenta — sin arriesgar timeouts arbitrarios.

4. **Ensamblaje propio con `pdf-lib`** — control total del tamaño de página (igual al bounding box real de la slide, no a un tamaño de papel estándar), inserción de anotaciones de link reconstruidas comparando la posición de los `<a>` visibles contra la captura.

5. **Servidor estático temporal en vez de `file://`** — necesario para que rutas relativas, fuentes con CORS y assets funcionen igual que en un navegador real apuntando a una URL.

## Estructura

```
pixeldeck/
├── core-engine/         # Lógica pura, testeable sin servidor
│   ├── slide-detector.ts     # Sistema de scoring de detección de slides
│   ├── forced-strategy.ts    # Detección declarativa por hint del usuario (sourceKind / contentShape)
│   ├── browser-pool.ts       # Navegadores Playwright reutilizables por proceso (+ modo headed)
│   ├── stability-watcher.ts  # Espera por diff de screenshots consecutivos
│   ├── image-diff.ts         # Fracción de píxeles distintos entre dos PNG (pixelmatch)
│   ├── capture-engine.ts     # Orquesta Playwright: navega, espera, captura, verifica
│   ├── pdf-assembler.ts      # Ensambla imágenes → PDF con pdf-lib (one-per-page / handout-2up)
│   ├── image-converter.ts    # PNG → JPEG (sharp)
│   ├── link-mapper.ts        # Reconstruye anotaciones de hipervínculo
│   └── bundle-detector.ts    # Empaqueta el detector para inyectarlo en la página (esbuild)
├── server/               # Express + TypeScript — API HTTP
│   ├── routes/convert.ts     # POST /convert
│   ├── conversion-pipeline.ts
│   ├── entry-file-resolver.ts # Elige/valida el HTML del .zip (soporta multi-deck)
│   ├── zip-extractor.ts      # Extracción segura (zip-slip, zip-bomb)
│   ├── job-queue.ts          # Limitador de concurrencia
│   ├── cleanup.ts            # Workspaces temporales + red de seguridad al salir
│   └── logger.ts
├── cli/pixeldeck.ts       # CLI (bin) sobre el mismo pipeline, sin servidor
├── client/               # Frontend mínimo (HTML/CSS/JS vanilla, sin build step)
│   ├── inspect.js            # Inspección local del archivo → recomendación de controles
│   └── zip-peek.js           # Lector del central directory de un .zip sin descomprimir
├── tests/
│   ├── fixtures/           # HTML de ejemplo con estructuras distintas (unit tests)
│   └── e2e/                # Decks reales que estresan cada falla del pipeline de impresión
├── Dockerfile            # Imagen basada en mcr.microsoft.com/playwright
└── action.yml            # GitHub Action (composite)
```

## Cómo correrlo en desarrollo

```bash
npm install
npx playwright install --with-deps chromium
npm run dev        # levanta el servidor en modo desarrollo (tsx, recarga en caliente)
```

Abre `http://localhost:4000`, sube un `.html` o un `.zip` (HTML + CSS/JS/imágenes/fuentes relativas) — por ejemplo exportado desde Claude Design (Share → More formats and apps → HTML) — elige formato y resolución, y convierte.

### Flujo declarativo (más rápido y directo)

Al soltar el archivo, PixelDeck lo **inspecciona localmente** (nada se sube en
esa fase): del `.html` lee firmas de framework, tamaño de artboard declarado y
conteo aproximado de slides; del `.zip` lee el inventario de archivos (sin
descomprimir). Con eso muestra un panel de reconocimiento y **preselecciona** los
controles. Puedes sobrescribir cualquiera:

| Control | Para qué |
|---|---|
| **Presentación** (`entryFile`) | Cuál HTML del `.zip` convertir. Aparece solo cuando el paquete trae **varias** presentaciones (p. ej. un export con dos decks). Si no se indica y hay ambigüedad, `/convert` responde 422 con la lista de candidatos. |
| **Origen** (`sourceKind`) | Declara la herramienta que generó el deck (Claude Design, Reveal.js, impress.js, Google Slides, genérico). Si se declara, el motor **omite el scoring de estrategias** y usa directamente los selectores de esa herramienta; si no matchean, cae a la detección automática. |
| **Tamaño nativo** (`nativeSize`) | Fija el viewport (1920×1080, 1280×720, 1024×768, A4 vertical) y salta la auto-detección de dimensiones. |
| **Forma** (`contentShape`) | `deck` (varias slides), `single-page` (poster/portada = 1 imagen), `long-scroll` (página larga, captura completa). |
| **Resultado esperado** (`expectedResult`) | `pdf-multipage`, `handout-2up` (2 slides por página A4 apaisada), `image-per-slide`, `single-image`. |

Todos son campos de formulario opcionales de `POST /convert`; ausentes o `auto` =
comportamiento automático de siempre.

### Verificación pixel a pixel

Tras capturar cada slide, PixelDeck toma una **segunda captura idéntica** y la
compara píxel a píxel con la entregada (`pixelmatch`). Si no coinciden, la slide
no estaba realmente asentada: reintenta una vez tras un respiro y, si sigue sin
cuadrar, entrega la mejor captura marcándola como *no verificada*. El resultado
reporta `Verificadas: N/M` (header `X-PixelDeck-Verified`). Se desactiva con
`PIXELDECK_VERIFY=0`.

### Observar el navegador

`PIXELDECK_HEADED=1 npm run dev` lanza Chromium con **ventana visible** y
`slowMo` (`PIXELDECK_SLOWMO`, default 250 ms) para ver la detección y captura
paso a paso. Solo para desarrollo.

### Tests

```bash
npm test              # unitarios (rápidos, sin navegador real) — slide-detector, etc.
npm run test:e2e      # end-to-end con Playwright real: decks que reproducen cada
                       # falla documentada del pipeline de impresión, con aserciones
                       # por píxel (no solo "no truena")
```

### Build de producción

```bash
npm run build          # tsc + copia client/ a dist/client/
node dist/server/index.js
```

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `4000` | Puerto HTTP del servidor. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `PIXELDECK_MAX_CONCURRENCY` | `2` | Conversiones simultáneas por proceso/réplica (cada una lanza un navegador Playwright completo). |
| `PIXELDECK_MAX_UPLOAD_BYTES` | `52428800` (50MB) | Tamaño máximo de archivo aceptado en `/convert`. |
| `PIXELDECK_TIMEOUT_MS` | `90000` | Presupuesto máximo por conversión antes de cancelarla. Ver nota de rendimiento en Docker abajo. |
| `PIXELDECK_VERIFY` | `1` | `0` desactiva la verificación pixel-diff de la captura final. |
| `PIXELDECK_BROWSER_IDLE_MS` | `120000` | El pool mantiene vivo un navegador ocioso este tiempo antes de cerrarlo; el siguiente request lo relanza. `0` desactiva el pool (lanza y cierra por conversión). |
| `PIXELDECK_HEADED` | — | `1` lanza el navegador con ventana visible (depuración). |
| `PIXELDECK_SLOWMO` | `250` | Con `PIXELDECK_HEADED=1`, ms de pausa entre acciones de Playwright. |

## Despliegue con Docker

Playwright necesita dependencias de sistema pesadas (librerías nativas para Chromium/Firefox/WebKit) que no vienen en una imagen `node:*` estándar — el `Dockerfile` (en la raíz) parte de la imagen oficial `mcr.microsoft.com/playwright`, que ya las trae.

```bash
# Imagen publicada (cada release):
docker run --rm -p 4000:4000 ghcr.io/whozthavicado/pixeldeck

# O construir localmente:
docker build -t pixeldeck .
docker run -d -p 4000:4000 -e PIXELDECK_MAX_CONCURRENCY=2 --name pixeldeck pixeldeck
```

El contenedor corre como el usuario sin privilegios `pwuser` que ya provee la imagen base (un navegador headless renderizando HTML no confiable no necesita root).

**Importante:** el `ARG PLAYWRIGHT_VERSION` del Dockerfile debe coincidir exactamente con la versión de `playwright` instalada en `package.json` (verificar con `node -e "console.log(require('playwright/package.json').version)"`) — Playwright no garantiza compatibilidad entre una versión de librería y binarios de navegador de otra versión.

**Nota de rendimiento:** verificado en la práctica (build + run real), un deck simple de 3 slides que corre en ~20s de forma nativa tardó ~70s dentro de un contenedor en Docker Desktop para macOS (la virtualización de su VM Linux añade overhead notable para trabajo intensivo en renderizado). Si vas a desplegar en Docker, considera decks reales al calibrar `PIXELDECK_TIMEOUT_MS` — el default de 90s puede quedarse corto para decks más grandes en un host con recursos limitados. Un host Linux nativo (la mayoría de los proveedores cloud) no debería sufrir este overhead de virtualización.

## Escalado de uso concurrente

Cada conversión lanza un navegador Playwright completo — es la operación más cara del sistema en CPU/RAM, no la E/S. El diseño de PixelDeck es **deliberadamente stateless por request**:

- Cada conversión usa su propio workspace temporal aislado (`server/cleanup.ts`) — nada se comparte entre requests.
- `server/job-queue.ts` limita cuántas conversiones corren a la vez **dentro de un mismo proceso** (`PIXELDECK_MAX_CONCURRENCY`), encolando el resto en FIFO en memoria.

Como no hay estado compartido entre requests, **escalar horizontalmente es simplemente correr más réplicas del contenedor** detrás de un load balancer (Docker Swarm, Kubernetes, ECS, etc.) — la capacidad total crece linealmente: `réplicas × PIXELDECK_MAX_CONCURRENCY`. No hace falta una cola centralizada (Redis/BullMQ) para este modelo, precisamente porque cada réplica es independiente y no necesita coordinarse con las demás.

Si en el futuro se necesitara *ordenamiento justo global* entre TODAS las réplicas (por ejemplo, garantizar FIFO estricto entre usuarios distintos golpeando distintas réplicas, o pausar el ingreso de trabajo nuevo cuando el clúster entero está saturado), ahí sí valdría la pena introducir una cola externa compartida — pero el límite en memoria por proceso es suficiente y más simple mientras cada réplica pueda rechazar con un 429/503 cuando está llena en vez de degradar silenciosamente.

## Contribuir

Los PRs son bienvenidos — sobre todo **nuevos detectores de framework** (una fila en `core-engine/strategies/known-framework-signature.ts` + `core-engine/forced-strategy.ts`, y un fixture). Corre `npm run lint && npm test && npm run test:e2e` antes de abrir el PR. Ver [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Licencia

MIT — ver [`LICENSE`](./LICENSE). El motor, la CLI, la librería, la imagen Docker y la GitHub Action son gratis para siempre, para cualquier uso. Si te ahorra tiempo, considera [apoyar el proyecto](https://github.com/sponsors/whozthavicado).
