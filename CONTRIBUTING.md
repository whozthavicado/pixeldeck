# Contribuir a PixelDeck

Gracias por el interés. PixelDeck es MIT y vive de aportes de la comunidad.

## Empezar

```bash
git clone https://github.com/whozthavicado/pixeldeck
cd pixeldeck
npm install
npx playwright install --with-deps chromium
npm run dev        # servidor + UI en http://localhost:4000
```

## Antes de abrir un PR

```bash
npm run lint
npm test            # unitarios, rápidos, sin navegador
npm run test:e2e    # end-to-end con Playwright real (lento)
npm run build
```

Los tres tienen que pasar. El CI corre exactamente eso.

## Lo más útil que puedes aportar: un detector de framework nuevo

Si tienes un deck de una herramienta que PixelDeck no reconoce (Gamma, Genially, Marp, Pitch, tu propio generador…):

1. Agrega su firma en `core-engine/strategies/known-framework-signature.ts`
   (una fila `{ name, selector, confidence }` — sin ramas de lógica nuevas).
2. Si quieres que sea seleccionable como hint, añádela también en
   `core-engine/forced-strategy.ts` (`SOURCE_KINDS` + `SELECTORS_BY_KIND`).
3. Agrega un fixture mínimo en `tests/fixtures/` (unit) o `tests/e2e/fixtures/<nombre>/index.html` (e2e)
   y una aserción.

## Estilo

- TypeScript estricto, sin dependencias nuevas salvo que sean imprescindibles.
- Comentarios que expliquen el *porqué*, no el *qué* — como el código existente.
- Un archivo, un propósito.

## Reportar un bug

Incluye el deck (o uno mínimo que lo reproduzca), el comando/flags usados, y qué esperabas vs. qué salió.
