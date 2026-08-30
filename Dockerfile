# syntax=docker/dockerfile:1

# Playwright necesita dependencias de sistema pesadas (librerías de
# Chromium/Firefox/WebKit) que no vienen en una imagen node: estándar.
# La imagen oficial de Playwright ya las trae preinstaladas — el ARG debe
# coincidir EXACTAMENTE con la versión de "playwright" en package.json
# (verificar con: node -e "console.log(require('playwright/package.json').version)").
ARG PLAYWRIGHT_VERSION=1.62.1

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY core-engine ./core-engine
COPY server ./server
COPY cli ./cli
COPY client ./client
RUN npm run build

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# dist/ ya incluye client/ (el build lo copia ahí — ver "copy-client" en package.json).
COPY --from=build /app/dist ./dist

# La imagen base de Playwright ya trae los navegadores instalados a nivel
# de sistema, pero el runtime de Node los busca en su propia carpeta de
# caché — nos aseguramos de tener al menos Chromium (motor por defecto)
# disponible ahí también.
RUN npx playwright install --with-deps chromium

# La imagen de Playwright corre como root por defecto; un navegador
# headless no necesita privilegios de root para renderizar HTML no
# confiable — usamos el usuario sin privilegios que la imagen ya provee.
USER pwuser

EXPOSE 4000
ENV PORT=4000

CMD ["node", "dist/server/index.js"]
