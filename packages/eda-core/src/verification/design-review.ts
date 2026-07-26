/**
 * Pre-layout DESIGN-REVIEW graph checks — the board-review basics that are answerable from OUR CircuitJson
 * (the source of design INTENT) with NO simulation, NO geometry, and NO datasheet. Read strictly from the
 * caller's CircuitJson, never a downstream tscircuit eval, so an adapter bug can never fool the check (the
 * connectivity-parity lesson). Informational (warn-first) — never gates the verdict, since a false downgrade
 * must never sink a sound design.
 *
 * WHY DECOUPLING IS NOT HERE (deferred, 17 Tem 2026): a bypass-cap PRESENCE check needs to know which nets
 * are power RAILS and which components are ICs. Our model gives neither reliably — a Net carries only
 * `isGround` (no power/rail marking), so a "rail" could only be guessed as a DC-source-driven net, which
 * also sweeps in DC bias/reference/input nets (a false rail); and `generic` is a catalog catch-all covering
 * ICs AND connectors/headers/sensors with pad-number pins, so an IC cannot be told from a connector nor its
 * power pin identified. Any such check produces false "undecoupled" findings — noise in a "verified" pack,
 * which erodes trust in the real findings beside it. Honest move: DISCLOSE decoupling as not-run (see the
 * manifest) until the schema carries an `isPower` net field and/or typed power-pin roles. Then it can be a
 * real, reliable check rather than a guess.
 */
import type { CircuitJson, Component } from '../types/circuit';

import type { DeterminedEntry } from './manifest';

// ---------------------------------------------------------------- orientation role-consistency

export interface OrientationFinding {
    designator: string;
    issue: string;
}
export interface OrientationReport {
    checked: boolean;
    /** polarized parts (diode/zener/LED) that do not cleanly declare both anode + cathode roles. */
    issues: OrientationFinding[];
    /** how many polarized parts were evaluated. */
    evaluated: number;
    manifestEntry: DeterminedEntry;
}

/** Types that carry a typed polarity role in OUR schema (diode/zener pins are ['anode','cathode']; an LED is
 *  a diode). A polarized CAPACITOR is just `capacitor` (['1','2']) — no role exists, so it is out of scope. */
const isPolarizedWithRole = (t: Component['type']): boolean => t === 'diode' || t === 'zener';

/**
 * ROLE-consistency: every diode/zener/LED must declare BOTH an `anode` and a `cathode` pin — the EXACT,
 * case-sensitive roles the netlist generator binds by (`pins.find(p => p.pinId === 'anode')`, throwing when
 * absent). A polarized part authored with bare `1`/`2` pins — or a mis-cased `Anode` the generator would
 * reject — has an UNSPECIFIED orientation, flagged here (pre-layout) rather than surfacing later as a
 * generation throw / unroutable pad. This is NOT geometric polarity verification, and it cannot cover
 * polarized caps/connectors (the schema carries no polarity role for those).
 */
export function checkOrientationConsistency(circuit: CircuitJson): OrientationReport {
    const issues: OrientationFinding[] = [];
    let evaluated = 0;
    for (const c of circuit.components) {
        if (!isPolarizedWithRole(c.type)) continue;
        evaluated++;
        // Case-SENSITIVE, matching the generator's exact contract (COMPONENT_PINS diode/zener = anode/cathode);
        // a lowercase-normalized check would pass a `Anode` the generator then rejects — a false clean.
        const roles = new Set(c.pins.map((p) => p.pinId));
        if (!roles.has('anode') || !roles.has('cathode')) {
            issues.push({
                designator: c.designator,
                issue: `polarized ${c.type} does not declare both anode and cathode roles (pins: ${c.pins.map((p) => p.pinId).join('/') || 'none'}) — orientation is unspecified`,
            });
        }
    }
    const checked = evaluated > 0;
    const note =
        'anode/cathode role-consistency for diode/zener/LED only — NOT geometric polarity, and NOT polarized ' +
        'capacitors/connectors (the schema carries no polarity role for those).';
    const manifestEntry: DeterminedEntry = checked
        ? { status: 'run', detail: note }
        : { status: 'not-run', detail: 'no polarized diode/zener/LED to evaluate' };
    return { checked, issues, evaluated, manifestEntry };
}
