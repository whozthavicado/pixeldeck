# Lanzamiento — notas y copy

## Posicionamiento en una línea

> Exporta decks de Claude Design / ChatGPT Canvas / v0 / Reveal.js a PDF sin que se rompan los gradientes, las sombras ni las tipografías — y con texto seleccionable.

## Por qué existe (el gap)

Las herramientas de IA generan presentaciones como HTML/CSS. "Imprimir → Guardar como PDF" cambia el navegador a `@media print` y destroza el diseño: `background-clip: text`, `box-shadow`, `backdrop-filter`, `@font-face`, `100vh`, navegación por JS. Los conversores genéricos (wkhtmltopdf, screenshot→PDF) o entregan lo mismo roto, o entregan una imagen sin texto.

PixelDeck rasteriza cada slide en un navegador real en modo `screen`, espera estabilidad visual real (diff de píxeles, no `sleep`), y ensambla el PDF al tamaño exacto de cada slide.

## Qué lo diferencia hoy

- **Detección de slides por scoring** (extensible, auditable) + hints declarativos que la saltan.
- **Verificación pixel-diff**: cada slide se re-captura y se compara; te dice `Verificadas: N/M`.
- **Multi-motor** (Chromium/Firefox/WebKit) vía Playwright.
- **Multi-deck en un .zip**: elige cuál convertir.
- **PDF 2-up** para imprimir, imágenes por slide, imagen única.
- **Local y privado**: nada sale de tu máquina. CLI, Docker, Action, librería.

## Show HN / Reddit — borrador

**Título:** Show HN: PixelDeck – export AI-generated HTML decks to pixel-perfect PDF

**Cuerpo:**

I kept exporting slide decks from Claude Design / ChatGPT Canvas / v0 and watching "Save as PDF" destroy them — gradient text goes solid black, shadows vanish, custom fonts fall back, 100vh slides get cut in half, JS-navigated decks only print slide 1. Every generic HTML-to-PDF tool has the same problem because they all go through the browser's `print` pipeline.

PixelDeck renders each slide in a real headless browser in `screen` mode, waits for visual stability (successive screenshots compared with pixelmatch, not a fixed sleep), and assembles a PDF at each slide's exact size. It figures out the slide structure with a scoring system (each detection strategy returns a 0–1 confidence; agreement between strategies raises it) and you can override it with a hint (`--source-kind claude-design`) to skip detection entirely.

It also re-captures every slide and diffs it against what it delivered, so it can tell you `Verified: 20/20`.

MIT. Runs as a CLI (`npx pixeldeck deck.zip`), a Docker container with a UI, a GitHub Action, or a library. Everything local — nothing leaves your machine.

Repo: https://github.com/whozthavicado/pixeldeck

**Dónde postear:** Hacker News (Show HN), r/webdev, r/SideProject, r/LocalLLaMA (ángulo "local"), lobste.rs, y responder en hilos de "cómo exporto mi Claude/GPT deck".

## Checklist previo a publicar

- [ ] Registrar dominio (pixeldeck.app / .io) y apuntarlo a los docs
- [ ] Crear el repo público `whozthavicado/pixeldeck`, push de `main`
- [ ] Tag `v0.2.0` → dispara `release.yml` (imagen GHCR; npm si hay `NPM_TOKEN`)
- [ ] `npm publish` (o vía el workflow) para que `npx pixeldeck` y la Action funcionen
- [ ] Screenshot / GIF de un deck roto vs. PixelDeck para el post
- [ ] Botón Sponsor activo (GitHub Sponsors / Polar)
- [ ] Instancia hosted mínima en el dominio con free tier

## Siguientes features (post-lanzamiento, ver estrategia)

1. Capa de texto real seleccionable/buscable detrás de la imagen (flagship).
2. Extracción de `data-speaker-notes` → PDF presentador / .md / notas en .pptx.
3. Export a .pptx, MP4/GIF walkthrough, crops sociales (carrusel LinkedIn/IG).
4. Bookmarks/outline del PDF desde los `data-label`.
5. Modo diff entre dos versiones de un deck.
