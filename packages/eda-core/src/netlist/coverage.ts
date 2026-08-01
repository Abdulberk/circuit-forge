/**
 * What the SPICE deck actually contained — the difference between "the circuit does not do that" and "the
 * part that would have done it was never simulated".
 *
 * WHY THIS EXISTS. A `generic` component is a catalog-only part: a real op-amp, 555 or shift register with
 * a footprint, an MPN and pins, but no electrical model. The netlist generator skips it, correctly — there
 * is nothing to emit. ERC passes it, correctly — it is a legitimate part. The simulation then runs on
 * what is left and returns waveforms.
 *
 * Those waveforms are real numbers about a circuit that is NOT the one on the schematic, and until this
 * module existed nothing anywhere said so. A 555 blinker whose 555 was omitted simulates to a flat line,
 * and "flat" reads as a verdict about the blinker. It is not; it is a verdict about an RC network. The
 * gap between those two sentences is exactly the kind of silence a verification product cannot afford.
 *
 * WHAT IT DOES NOT DO. It reports; it does not judge. Omitting a mounting hole, a test point or a
 * connector costs nothing and must not raise an alarm — so each omission is classified by whether the
 * deck can actually feel its absence, and the caller decides what that is worth.
 */
import type { CircuitJson, Component, ComponentType } from '../types/circuit';
import { isSimulatable } from '../types/circuit';

export interface OmittedComponent {
    designator: string;
    type: ComponentType;
    /** The net ids it connects, deduplicated — what the deck is missing a device across. */
    netIds: string[];
    /**
     * Whether the deck can observe the absence: the part bridges two or more distinct nets that simulated
     * components also touch, so the simulated topology has an OPEN exactly where this part should be.
     *
     * A part that touches one net, or only nets no simulated device touches, changes nothing that was
     * simulated — its omission is honest bookkeeping rather than a hole in the result.
     */
    loadBearing: boolean;
}

export interface SimulationCoverage {
    /** Components present in the circuit but absent from the deck. Empty is the ordinary case. */
    omitted: OmittedComponent[];
    /** The subset whose absence the simulated result depends on. Empty means the deck is electrically
     *  complete even if `omitted` is not. */
    loadBearing: OmittedComponent[];
    /**
     * True when nothing load-bearing was left out of the deck.
     *
     * PRESENCE, NOT FIDELITY — and the distinction is load-bearing itself. `complete` says every part that
     * the result depends on is IN the deck; it says nothing about how well each is modelled. A generic-tier
     * macromodel standing in for a real IC counts as present, and it can be first-order only: our own
     * op-amp core has no supply current (measured: it sources 4.2e-4 A while drawing 2.0e-11 A from the
     * rail), no input common-mode limit, no slew rate and no offset. So a `complete` deck can still be the
     * wrong answer for a power budget or a common-mode question.
     *
     * Reading this as "the waveforms describe the schematic" over-claims, and this comment used to say
     * exactly that. Model fidelity is a separate axis — `ModelDef.tier` already carries it — and reporting
     * it belongs in a follow-up rather than being smuggled into this boolean.
     */
    complete: boolean;
}

const netIdsOf = (c: Component): string[] => [...new Set(c.pins.map((p) => p.netId))];

/**
 * Compare the schematic against what the generator would emit.
 *
 * Uses the same `isSimulatable` predicate the generator does, so the two cannot drift: a component is
 * reported as omitted precisely when the generator declines to emit it. (`ground` is not an omission —
 * it is node 0, a full representation rather than a missing device.)
 */
export function simulationCoverage(circuit: Pick<CircuitJson, 'components'>): SimulationCoverage {
    const components = circuit.components ?? [];

    // Nets that a simulated device actually attaches to. An omitted part's absence is only observable
    // across these; anywhere else the net does not exist in the deck at all.
    const simulatedNets = new Set<string>();
    for (const c of components) {
        if (c.type === 'ground' || !isSimulatable(c)) continue;
        for (const p of c.pins) simulatedNets.add(p.netId);
    }

    const omitted: OmittedComponent[] = [];
    for (const c of components) {
        if (c.type === 'ground' || isSimulatable(c)) continue;
        const netIds = netIdsOf(c);
        const bridged = netIds.filter((n) => simulatedNets.has(n));
        omitted.push({ designator: c.designator, type: c.type, netIds, loadBearing: bridged.length >= 2 });
    }

    const loadBearing = omitted.filter((o) => o.loadBearing);
    return { omitted, loadBearing, complete: loadBearing.length === 0 };
}

/**
 * One line a person can read, or null when there is nothing to disclose.
 *
 * Deliberately names the designators. "1 component omitted" sends a reader hunting; "U1 (generic) was not
 * simulated" tells them which part of the answer to distrust.
 */
export function describeCoverage(coverage: SimulationCoverage): string | null {
    if (coverage.omitted.length === 0) return null;
    const name = (o: OmittedComponent): string => `${o.designator} (${o.type})`;
    if (coverage.loadBearing.length === 0) {
        return `${coverage.omitted.map(name).join(', ')} ${coverage.omitted.length === 1 ? 'has' : 'have'} no simulatable model and ${coverage.omitted.length === 1 ? 'was' : 'were'} left out of the deck; ${coverage.omitted.length === 1 ? 'it does' : 'they do'} not bridge simulated nets, so the result is unaffected`;
    }
    return (
        `the deck does NOT contain ${coverage.loadBearing.map(name).join(', ')} — ` +
        `${coverage.loadBearing.length === 1 ? 'this part has' : 'these parts have'} no simulatable model, ` +
        `so the simulated circuit has an open where ${coverage.loadBearing.length === 1 ? 'it belongs' : 'they belong'} ` +
        `and the results do not describe the schematic as drawn`
    );
}
