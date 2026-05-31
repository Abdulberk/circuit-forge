/**
 * Dependency-free promise pool. Caps the number of concurrently running tasks so we stay
 * under the TME API's ~5 req/s ceiling (and never stampede it on detail fan-out).
 */
export interface Limiter {
    run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createLimiter(max: number): Limiter {
    const cap = Math.max(1, Math.floor(max));
    let active = 0;
    const queue: Array<() => void> = [];

    const schedule = (): void => {
        while (active < cap && queue.length > 0) {
            active++;
            const start = queue.shift()!;
            start();
        }
    };

    const release = (): void => {
        active--;
        schedule();
    };

    return {
        run<T>(fn: () => Promise<T>): Promise<T> {
            return new Promise<T>((resolve, reject) => {
                queue.push(() => {
                    fn().then(resolve, reject).finally(release);
                });
                schedule();
            });
        },
    };
}
