/**
 * A counting semaphore with FIFO fairness — the primitive that bounds how many ngspice processes (and, later,
 * in-flight LLM requests) run at once across the WHOLE worker. Pure (no config/IO) so it is trivially testable
 * and reusable. `run(fn)` is the safe wrapper: it always releases, even if `fn` throws.
 */
export class Semaphore {
    private permits: number;
    private readonly waiters: Array<() => void> = [];

    constructor(permits: number) {
        // Defensive: a misconfigured/NaN permit count must never deadlock — floor to ≥1.
        this.permits = Number.isFinite(permits) ? Math.max(1, Math.floor(permits)) : 1;
    }

    /** Acquire one permit, waiting (FIFO) if none are free. */
    async acquire(): Promise<void> {
        if (this.permits > 0) {
            this.permits--;
            return;
        }
        await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    /** Release one permit — hands it directly to the next waiter (FIFO) if any, else returns it to the pool. */
    release(): void {
        const next = this.waiters.shift();
        if (next) {
            next(); // permit transferred to the waiter; count stays "held"
        } else {
            this.permits++;
        }
    }

    /** Run `fn` while holding a permit; always releases (even on throw). */
    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    /** Free permits right now (diagnostics/metrics). */
    get available(): number {
        return this.permits;
    }

    /** Callers currently blocked waiting for a permit (diagnostics/metrics). */
    get waiting(): number {
        return this.waiters.length;
    }
}
