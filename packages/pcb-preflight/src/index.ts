/**
 * Preflight: can this circuit become a board, and what would each part become?
 *
 * WHY THIS IS ITS OWN PACKAGE. The answer is pure classification — a component type, a pin count and a
 * footprint string — and it is exactly what an editor wants to know the moment a part is added: "U3 has no
 * footprint, it cannot be placed". Before this existed as its own package the only way to ask was to depend
 * on `pcb-core`, which pulls an evaluator, a footprint library and three format converters. The API would
 * have installed the entire board toolchain to answer a question about a pin count.
 *
 * That is the same trap `pcb-contract` was extracted to close, one level up: the answer is cheap, so the
 * thing that provides it must be cheap to depend on.
 *
 * THE FOOTPRINTER IS OPTIONAL, AND ITS ABSENCE IS DECLARED. `loadPadCountOracle()` dynamically imports
 * `@tscircuit/footprinter`, which is why a consumer that never asks for pad accounting never pays for it.
 * A consumer that omits the oracle does NOT get a silent pass: `classifyCircuit` reports PCB006 — the check
 * did not run — rather than declaring a board accounted-for by a check that never happened.
 */
export {
    resolveFootprint,
    normalizeFootprint,
    isLedDiode,
    soicForPinCount,
    loadPadCountOracle,
    type FootprintResolution,
    type PadCountOracle,
} from './footprints';

export {
    classifyCircuit,
    type LayoutabilityResult,
    type LayoutabilityOptions,
    type LayoutDiagnostic,
    type ComponentPlan,
    type LayoutRole,
} from './layoutability';
