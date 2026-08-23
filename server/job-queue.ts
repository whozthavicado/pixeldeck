/** Se lanza cuando la cola ya está al máximo y no admite un trabajo más. */
export class QueueFullError extends Error {
  constructor(maxQueueLength: number) {
    super(`El servidor está saturado (cola llena, máximo ${maxQueueLength} en espera). Intenta de nuevo en unos segundos.`);
    this.name = "QueueFullError";
  }
}

/**
 * Limitador de concurrencia simple en memoria. Necesario porque cada
 * conversión lanza un navegador Playwright completo (Chromium/Firefox/
 * WebKit) — pesado en CPU/RAM — así que no queremos que N requests
 * concurrentes disparen N navegadores sin control. Las conversiones que
 * exceden `maxConcurrent` esperan en una cola FIFO en memoria — pero esa
 * cola tiene un tope (`maxQueueLength`): superado, se rechaza de inmediato
 * en vez de encolar indefinidamente y arriesgar que el cliente HTTP haga
 * timeout sin ninguna respuesta clara.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueueLength: number = maxConcurrent * 5
  ) {
    if (maxConcurrent < 1) {
      throw new Error("ConcurrencyLimiter: maxConcurrent debe ser >= 1.");
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueueLength) {
      throw new QueueFullError(this.maxQueueLength);
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
