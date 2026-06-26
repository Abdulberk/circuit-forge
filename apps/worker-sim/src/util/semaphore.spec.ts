import { Semaphore } from './semaphore';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('Semaphore', () => {
    it('caps concurrency at the permit count (the global-ngspice bound)', async () => {
        const sem = new Semaphore(2);
        let active = 0;
        let peak = 0;
        const task = () => sem.run(async () => {
            active++; peak = Math.max(peak, active);
            await tick(); await tick();
            active--;
        });
        await Promise.all(Array.from({ length: 6 }, task));
        expect(peak).toBe(2); // never more than 2 ran at once, though 6 were launched
        expect(sem.available).toBe(2); // all permits returned
        expect(sem.waiting).toBe(0);
    });

    it('treats <1 permits as 1 (never deadlocks on a misconfigured 0)', async () => {
        const sem = new Semaphore(0);
        let ran = false;
        await sem.run(async () => { ran = true; });
        expect(ran).toBe(true);
    });

    it('releases the permit even when the task throws', async () => {
        const sem = new Semaphore(1);
        await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(sem.available).toBe(1); // permit not leaked
        // and the next task can still acquire
        let ran = false;
        await sem.run(async () => { ran = true; });
        expect(ran).toBe(true);
    });

    it('hands a released permit directly to the FIFO-next waiter', async () => {
        const sem = new Semaphore(1);
        const order: number[] = [];
        await sem.acquire(); // hold the only permit
        const w1 = sem.acquire().then(() => order.push(1));
        const w2 = sem.acquire().then(() => order.push(2));
        await tick();
        expect(sem.waiting).toBe(2);
        sem.release(); await tick(); // → waiter 1
        sem.release(); await tick(); // → waiter 2
        await Promise.all([w1, w2]);
        expect(order).toEqual([1, 2]); // FIFO fairness
    });
});
