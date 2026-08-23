import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Los tests e2e levantan navegadores Playwright reales (lentos) y viven
    // en su propia config (vitest.e2e.config.ts / `npm run test:e2e`), para
    // que `npm test` siga siendo rápido en el ciclo normal de desarrollo.
    exclude: ["node_modules/**", "tests/e2e/**"],
    testTimeout: 15000,
  },
});
