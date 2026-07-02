/**
 * freerouting bridge seam (quality tier, consumed by the Faz-2 worker + the layout harness).
 * Pure conversions only — the actual freerouting EXECUTION (Docker: ghcr.io/freerouting/freerouting
 * pinned 2.2.4, `--entrypoint java -jar /app/freerouting-executable.jar --gui.enabled=false -de/-do`)
 * lives with the process runner, never in this library. Golden-fixture coverage runs in the
 * `pnpm test:layout` harness (the ESM deps keep these out of jest).
 */
import type { TscElement } from './parity';

/** tscircuit circuit-json (traces stripped by the caller for a fresh route) -> Specctra DSN. */
export async function exportDsn(circuitJson: TscElement[]): Promise<string> {
    const { convertCircuitJsonToDsnString } = await import('dsn-converter');
    return convertCircuitJsonToDsnString(circuitJson as never);
}

/** Merge a freerouting SES session back onto the DSN's circuit-json (routed traces + vias). */
export async function mergeSes(dsn: string, ses: string): Promise<TscElement[]> {
    const mod = await import('dsn-converter');
    const dsnJson = mod.parseDsnToDsnJson(dsn);
    return mod.convertDsnSessionToCircuitJson(dsnJson as never, mod.parseDsnToDsnJson(ses) as never) as TscElement[];
}

/** Drop routed geometry so an external router starts from placement only. */
export function stripRouting(circuitJson: TscElement[]): TscElement[] {
    return circuitJson.filter((e) => e.type !== 'pcb_trace' && e.type !== 'pcb_via');
}
