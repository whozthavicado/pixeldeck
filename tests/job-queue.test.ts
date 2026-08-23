import { describe, it, expect } from "vitest";
import { ConcurrencyLimiter } from "../server/job-queue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("ConcurrencyLimiter", () => {
  it("ejecuta hasta maxConcurrent tareas en paralelo sin encolar", async () => {
    const limiter = new ConcurrencyLimiter(2);
    const d1 = deferred<void>();
    const d2 = deferred<void>();

    const p1 = limiter.run(() => d1.promise);
    const p2 = limiter.run(() => d2.promise);

    expect(limiter.activeCount).toBe(2);
    expect(limiter.queuedCount).toBe(0);

    d1.resolve();
    d2.resolve();
    await Promise.all([p1, p2]);
    expect(limiter.activeCount).toBe(0);
  });

  it("encola tareas que exceden maxConcurrent y las corre en orden al liberarse un slot", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order: number[] = [];
    const d1 = deferred<void>();

    const p1 = limiter.run(async () => {
      await d1.promise;
      order.push(1);
    });
    const p2 = limiter.run(async () => {
      order.push(2);
    });

    expect(limiter.activeCount).toBe(1);
    expect(limiter.queuedCount).toBe(1);

    d1.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("rechaza con QueueFullError cuando la cola alcanza maxQueueLength, sin encolar indefinidamente", async () => {
    const limiter = new ConcurrencyLimiter(1, 2); // 1 activo, máximo 2 en cola
    const blockers = [deferred<void>(), deferred<void>(), deferred<void>()];

    const running = limiter.run(() => blockers[0].promise); // ocupa el único slot activo
    const queued1 = limiter.run(() => blockers[1].promise); // entra a la cola (1/2)
    const queued2 = limiter.run(() => blockers[2].promise); // entra a la cola (2/2)

    await expect(limiter.run(() => Promise.resolve())).rejects.toThrow(/saturado/i);

    blockers.forEach((d) => d.resolve());
    await Promise.all([running, queued1, queued2]);
  });

  it("libera correctamente el slot para el siguiente en cola aunque la tarea activa falle", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const failing = limiter.run(() => Promise.reject(new Error("boom")));
    const next = limiter.run(() => Promise.resolve("ok"));

    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});
