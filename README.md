# PixelDeck

Convierte presentaciones HTML/CSS (generadas por IA — Claude Design, ChatGPT Canvas, Gemini, v0, Reveal.js, etc.) en PDF, JPG o PNG **pixel-perfect**, sin pasar por el pipeline de impresión del navegador (`@media print`).

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
│   ├── stability-watcher.ts  # Espera por diff de screenshots consecutivos
│   ├── capture-engine.ts     # Orquesta Playwright: navega, espera, captura
│   ├── pdf-assembler.ts      # Ensambla imágenes → PDF con pdf-lib
│   ├── image-converter.ts    # PNG → JPEG (sharp)
│   ├── link-mapper.ts        # Reconstruye anotaciones de hipervínculo
│   └── bundle-detector.ts    # Empaqueta el detector para inyectarlo en la página (esbuild)
├── server/               # Express + TypeScript — API HTTP
│   ├── routes/convert.ts     # POST /convert
│   ├── conversion-pipeline.ts
│   ├── zip-extractor.ts      # Extracción segura (zip-slip, zip-bomb)
│   ├── job-queue.ts          # Limitador de concurrencia
│   ├── cleanup.ts            # Workspaces temporales + red de seguridad al salir
│   └── logger.ts
├── client/               # Frontend mínimo (HTML/CSS/JS vanilla, sin build step)
├── tests/
│   ├── fixtures/           # HTML de ejemplo con estructuras distintas (unit tests)
│   └── e2e/                # Decks reales que estresan cada falla del pipeline de impresión,
│                            # con aserciones por píxel (gradientes, box-shadow, backdrop-filter...)
└── docker/                # Imagen basada en mcr.microsoft.com/playwright
```

## Cómo correrlo en desarrollo

```bash
npm install
npx playwright install --with-deps chromium
npm run dev        # levanta el servidor en modo desarrollo (tsx, recarga en caliente)
```

Abre `http://localhost:4000`, sube un `.html` o un `.zip` (HTML + CSS/JS/imágenes/fuentes relativas) — por ejemplo exportado desde Claude Design (Share → More formats and apps → HTML) — elige formato y resolución, y convierte.

### Tests

```bash
npm test              # unitarios (rápidos, sin navegador real) — slide-detector, etc.
npm run test:e2e      # end-to-end con Playwright real: 6 decks que reproducen cada
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

## Despliegue con Docker

Playwright necesita dependencias de sistema pesadas (librerías nativas para Chromium/Firefox/WebKit) que no vienen en una imagen `node:*` estándar — el `Dockerfile` parte de la imagen oficial `mcr.microsoft.com/playwright`, que ya las trae.

```bash
docker build -f docker/Dockerfile -t pixeldeck .
docker run -d -p 4000:4000 \
  -e PIXELDECK_MAX_CONCURRENCY=2 \
  --name pixeldeck pixeldeck
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
