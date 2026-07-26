import type { PlacementInput, PlacementOutput } from './placement';

/**
 * Async seam for an out-of-process placement engine.
 *
 * pcb-core deliberately stays free of child_process/runtime concerns. The pcb-worker (or a
 * benchmark harness) injects the executable-backed runner, just like it already injects
 * Freerouting and KiCad. A failed runner can therefore fall back to the proven grid placement
 * without crashing the layout worker.
 */
export type PlacementRunner = (input: PlacementInput) => Promise<PlacementOutput>;
