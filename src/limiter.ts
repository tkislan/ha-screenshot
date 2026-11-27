export interface Limiter {
  /**
   * Runs `task` once fewer than `max` tasks are running; waiting tasks start in arrival order.
   * Rejects with `signal.reason` if the signal aborts while the task is still waiting.
   */
  run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T>;
}

export function createLimiter(max: number): Limiter {
  let active = 0;
  const waiting = new Set<() => void>();

  async function acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (active < max) {
      active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        waiting.delete(grant);
        reject(signal.reason);
      };
      waiting.add(grant);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  // Hands the slot straight to the next waiter, so a task arriving in between cannot take it too.
  function release(): void {
    const next = waiting.values().next().value;
    if (next) {
      waiting.delete(next);
      next();
    } else {
      active--;
    }
  }

  return {
    async run(task, signal) {
      await acquire(signal);
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}
