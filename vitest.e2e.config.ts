import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    // Los navegadores Playwright son pesados en CPU/RAM — no correr los
    // archivos de test en paralelo evita competir por recursos y timeouts
    // espurios en máquinas modestas.
    fileParallelism: false,
  },
});
