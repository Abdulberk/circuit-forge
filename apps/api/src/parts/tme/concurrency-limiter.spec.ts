import { createLimiter } from './concurrency-limiter';

describe('createLimiter', () => {
    it('never runs more than `max` tasks concurrently', async () => {
        const max = 3;
        const limiter = createLimiter(max);
        let active = 0;
        let peak = 0;
        const task = () =>
            new Promise<void>((resolve) => {
                active++;
                peak = Math.max(peak, active);
                setTimeout(() => {
                    active--;
                    resolve();
                }, 5);
            });
        await Promise.all(Array.from({ length: 20 }, () => limiter.run(task)));
        expect(peak).toBeLessThanOrEqual(max);
        expect(peak).toBeGreaterThan(1);
    });

    it('propagates results and errors', async () => {
        const limiter = createLimiter(2);
        await expect(limiter.run(() => Promise.resolve(42))).resolves.toBe(42);
        await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    });
});
