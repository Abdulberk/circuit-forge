/**
 * Tiny in-memory TTL cache with per-key single-flight. Used for reference data (manufacturers,
 * categories) and short-lived search caching. Swappable for Redis later behind the same shape.
 *
 * Reference/parametric data is safe to cache; live pricing/stock is fetched per request in detail.
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

    async getOrLoad<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
        const hit = this.store.get(key);
        if (hit && hit.expiresAt > Date.now()) {
            return hit.value as T;
        }
        const existing = this.inflight.get(key);
        if (existing) return existing as Promise<T>;

        const promise = loader()
            .then((value) => {
                this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
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
        return promise as Promise<T>;
    }

    clear(): void {
        this.store.clear();
        this.inflight.clear();
    }
}
