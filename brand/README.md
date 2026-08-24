# Marca PixelDeck

## Concepto

Tres láminas de un deck escalonado donde la **resolución crece hacia el
frente**: la trasera está construida con una retícula gruesa de píxeles, la
media con una intermedia, la frontal es sólida y nítida. Cuenta en una sola
forma lo que hace la herramienta — recuperar el píxel exacto de una
presentación en vez de degradarla al convertirla.

## Archivos

| Archivo | Uso |
|---|---|
| `mark.svg` | Marca completa. A partir de ~48 px, donde la retícula de píxeles se distingue. |
| `mark-favicon.svg` | Variante compacta. Favicon y cualquier uso por debajo de ~40 px: a esa escala la retícula se vuelve ruido, así que la progresión se cuenta solo con el tono. |

Ambas funcionan sobre fondo claro y oscuro: la separación entre láminas es
tonal, sin contornos del color de fondo.

## Color

| Rol | Hex |
|---|---|
| Lámina frontal (resolución completa) | `#ff9d2e` |
| Lámina media | `#bf6a15` |
| Lámina trasera (más degradada) | `#6b3a0d` |
| Fondo de marca | `#0b0a09` |

El ámbar es luz de seguridad de cuarto oscuro, no un naranja de marca
genérico — sostiene el territorio de instrumento óptico del resto de la
interfaz.

## Lockup

Marca + `PixelDeck` en Bricolage Grotesque 800, tracking `-0.03em`, con
`Pixel` en papel (`#f2ede6`) y `Deck` en ámbar. Separación entre marca y
texto: 12 px a 30 px de marca. Implementado en `client/index.html`.

## Evitar

- Degradados en el wordmark o en las láminas.
- Contornos del color de fondo (rompen el uso sobre fondo claro).
- Esquinas redondeadas: el píxel es cuadrado, es el punto.
- Reordenar las láminas: la más brillante y nítida va siempre al frente.
