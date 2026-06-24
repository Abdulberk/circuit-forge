/**
 * Tiny deterministic PRNG (mulberry32) — a seeded uniform [0,1) generator. Used by Monte-Carlo so a yield
 * run is REPRODUCIBLE given a seed (Math.random would make every run different and tests non-deterministic).
 */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function next(): number {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
