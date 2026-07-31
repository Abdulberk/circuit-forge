/**
 * Tiny in-memory TTL cache with per-key single-flight. Used for reference data (manufacturers,
 * categories) and short-lived search caching. Swappable for Redis later behind the same shape.
 *
 * Reference/parametric data is safe to cache; live pricing/stock is fetched per request in detail.
 * `getOrLoadWith` lets the TTL depend on what was actually loaded — see its own note.
 */
import { Injectable } from '@nestjs/common';

interface Entry<T> {
    value: T;
    expiresAt: number;
}

@Injectable()
export class TtlCache {
    private readonly store = new Map<string, Entry<unknown>>();
    private readonly inflight = new Map<string, Promise<unknown>>();
    private readonly maxEntries = 1000;

    /** Fixed-TTL form: the lifetime is known before the value is. */
    async getOrLoad<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
        return this.getOrLoadWith(key, () => ttlMs, loader);
    }

    /**
     * Variable-TTL form: the lifetime is decided FROM the loaded value.
     *
     * Not every result deserves the same shelf life. A part detail whose enrichment lookups all answered
     * is a fact and can be held for minutes; the same shape with a lookup missing is a gap, and holding a
     * gap for minutes turns one transient upstream failure into minutes of confident wrong answers. The
     * caller knows which it got; the cache should not have to guess.
     */
    async getOrLoadWith<T>(key: string, ttlFor: (value: T) => number, loader: () => Promise<T>): Promise<T> {
        const hit = this.store.get(key);
        if (hit && hit.expiresAt > Date.now()) {
            return hit.value as T;
        }
        const existing = this.inflight.get(key);
        if (existing) return existing as Promise<T>;

        const promise = loader()
            .then((value) => {
                this.store.set(key, { value, expiresAt: Date.now() + ttlFor(value) });
                // Bound memory: evict the oldest entry once over the cap (Map preserves insertion order).
                if (this.store.size > this.maxEntries) {
                    const oldest = this.store.keys().next().value;
                    if (oldest !== undefined) this.store.delete(oldest);
                }
                return value;
            })
            .finally(() => {
                this.inflight.delete(key);
            });

        this.inflight.set(key, promise);
        return promise;
    }

    clear(): void {
        this.store.clear();
        this.inflight.clear();
    }
}
