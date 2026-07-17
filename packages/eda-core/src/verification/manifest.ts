/**
 * Scope manifest — the disclosure primitive behind an honest "verified" badge.
 *
 * WHY (17 Tem 2026): a verdict is only as honest as its scope. The moment we surface a positive claim
 * ("robust", "manufacturable"), a reviewer asks "…and what did you NOT check?" — decoupling? polarity?
 * thermal? If the answer lives only in the team's head, the badge over-claims by omission. The manifest
 * makes the ABSENCE of a check truthful and MACHINE-READABLE: every nameable check is enumerated with a
 * status, so "not checked" is stated out loud instead of silently implied.
 *
 * INVARIANT: a producer lists the checks IT owns; `buildManifest` fills any it did not determine with
 * status:'not-run'. So within a fragment a check can never be silently absent — it is 'run', 'not-run',
 * or 'excluded', never missing. (There are two producers today — the electrical verify and the layout job
 * — each emitting the fragment for its own endpoint; a single unified badge that merges both is a
 * deferred follow-up, since the two verdicts are returned by two different endpoints.)
 *
 * `gradation` records that a 'run' check is deliberately SHALLOWER than its name might suggest — today only
 * decoupling, which proves a bypass cap is PRESENT, not that it is ADEQUATE (value/count/proximity — a
 * layout-time concern). Every other scope nuance rides in the free-text `detail`.
 */
import type { SpecDimension } from '../analysis/assertions';

/** The single frozen registry of nameable checks. A CheckId typo cannot compile (it is a closed union),
 *  so a producer can never invent a check that isn't disclosed elsewhere. */
export const CHECK_IDS = [
    // electrical (POST /verify-design)
    'sim',
    'erc',
    'assertion.voltage',
    'assertion.current',
    'assertion.frequency',
    'assertion.thd',
    'derating',
    'robustness',
    'decoupling',
    'polarity',
    // layout / manufacturability (GET /layouts/:id)
    'connectivity-parity',
    'drc',
    'manufacturability',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export type CheckStatus = 'run' | 'not-run' | 'excluded';
/** Depth qualifier for a 'run' check that is intentionally shallower than its name — see file header. */
export type CheckGradation = 'presence' | 'adequacy';

export interface CheckEntry {
    id: CheckId;
    status: CheckStatus;
    gradation?: CheckGradation;
    /** One-line human note on exactly what this check did or did not cover. */
    detail?: string;
}
/** A determined entry minus its id (the id is supplied by the owned-list in buildManifest). */
export type DeterminedEntry = Omit<CheckEntry, 'id'>;

export interface ScopeManifest {
    checks: CheckEntry[];
}

/** Human labels for the badge/manifest UI (kept beside the registry so a new CheckId is a compile error
 *  here too — Record over the union). */
export const CHECK_LABELS: Record<CheckId, string> = {
    sim: 'Simulation ran',
    erc: 'Electrical rule check',
    'assertion.voltage': 'Voltage spec asserted',
    'assertion.current': 'Current spec asserted',
    'assertion.frequency': 'Frequency spec asserted',
    'assertion.thd': 'Distortion (THD) spec asserted',
    derating: 'Component derating / stress',
    robustness: 'Tolerance robustness (Monte-Carlo / corners)',
    decoupling: 'Decoupling present',
    polarity: 'Polarity orientation-consistency',
    'connectivity-parity': 'Netlist ↔ layout connectivity',
    drc: 'Design-rule check (fab tier)',
    manufacturability: 'Manufacturable (DRC-clean gate)',
};

/**
 * Build a manifest fragment: the producer names the checks it OWNS and supplies whatever it determined;
 * every owned check it did not set is emitted as status:'not-run' (the disclosure invariant — an owned
 * check is never silently absent).
 */
export function buildManifest(owned: readonly CheckId[], determined: Partial<Record<CheckId, DeterminedEntry>>): ScopeManifest {
    const notRun: DeterminedEntry = { status: 'not-run' };
    return { checks: owned.map((id) => ({ id, ...notRun, ...determined[id] })) };
}

/** The electrical verify (POST /verify-design) fragment. Reports assertion COVERAGE — which quantities the
 *  supplied assertions actually check — NOT requirement satisfaction (no prompt is threaded here). decoupling
 *  / polarity accept a determined entry once their detectors land; until then they disclose as not-run. */
export function buildElectricalScope(input: {
    /** true ONLY when ngspice actually ran AND produced usable data (simStatus 'ok'). A skipped run OR a
     *  failure (invalid circuit / netlist-gen throw / non-convergence) is disclosed as not-run — never
     *  "Simulation ran" for a run that produced no usable result. */
    simRan: boolean;
    /** dimensions the SUPPLIED assertions cover (via criterionDimension). */
    coveredDimensions: readonly SpecDimension[];
    /** the resistor-power/derating review — 'run' when it produced a report (informational), else not-run. */
    derating?: DeterminedEntry;
    /** worst-case corner / Monte-Carlo robustness — 'run' only when the caller requested and it executed. */
    robustness?: DeterminedEntry;
    decoupling?: DeterminedEntry;
    polarity?: DeterminedEntry;
}): ScopeManifest {
    const covered = new Set(input.coveredDimensions);
    const dim = (d: SpecDimension): DeterminedEntry =>
        covered.has(d) ? { status: 'run', detail: 'an assertion checks this quantity' } : { status: 'not-run' };
    return buildManifest(
        ['sim', 'erc', 'assertion.voltage', 'assertion.current', 'assertion.frequency', 'assertion.thd', 'derating', 'robustness', 'decoupling', 'polarity'],
        {
            sim: { status: input.simRan ? 'run' : 'not-run' },
            erc: { status: 'run' }, // ERC is a hard gate that always executes on this path
            'assertion.voltage': dim('voltage'),
            'assertion.current': dim('current'),
            'assertion.frequency': dim('frequency'),
            'assertion.thd': dim('thd'),
            derating: input.derating ?? { status: 'not-run', detail: 'no resistor-power data (sim not ok / no resistors)' },
            robustness: input.robustness ?? { status: 'not-run', detail: 'tolerance robustness not requested' },
            // Decoupling presence is DEFERRED, not merely unimplemented: the circuit model has no power-rail
            // marking, so a "rail" could only be guessed (a DC source may drive a signal/reference net), and
            // `generic` conflates ICs with connectors — either guess produces false findings. Disclosed
            // not-run until the schema carries an isPower net field / typed power-pin roles.
            decoupling: input.decoupling ?? { status: 'not-run', detail: 'deferred — no power-rail marking in the model to identify a rail reliably (needs an isPower net field / power-pin roles)' },
            polarity: input.polarity ?? { status: 'not-run', detail: 'no polarized diode/zener/LED to evaluate' },
        },
    );
}

/** The layout / manufacturability (GET /layouts/:id) fragment, from the job's existing verdict signals. */
export function buildLayoutScope(input: {
    parityPins?: { checked: number; expected: number };
    drcClean: boolean;
    drcViolations: number;
    manufacturable: boolean;
}): ScopeManifest {
    return buildManifest(
        ['connectivity-parity', 'drc', 'manufacturability'],
        {
            'connectivity-parity': {
                status: 'run',
                detail: input.parityPins ? `${input.parityPins.checked}/${input.parityPins.expected} pins isomorphic` : undefined,
            },
            drc: {
                status: 'run',
                detail: input.drcClean ? 'DRC-clean against the ordered fab rules' : `${input.drcViolations} rule violation(s)`,
            },
            manufacturability: {
                status: 'run',
                detail: input.manufacturable ? 'delivered (DRC-clean)' : 'fab bundle withheld (not DRC-clean)',
            },
        },
    );
}
