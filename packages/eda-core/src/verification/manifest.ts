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
    'stress.resistor-power',
    'stress.voltage',
    'stress.current',
    'robustness',
    'decoupling',
    'polarity',
    // Domains we do not analyse. They are listed EXACTLY so their absence stops being invisible: a reader
    // of the manifest can tell "we looked and it passed" from "nobody looked", which is the whole point of
    // the primitive. Silence is the one thing a scope manifest must never do.
    'thermal',
    'emi',
    'compliance',
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
    // Named for what it MEASURES, not for the family it belongs to. It was called "Component derating /
    // stress", which promises capacitor voltage margin, diode reverse voltage, transistor Vds and current
    // through anything — none of which run. A reader who saw "stress: checked" stopped looking, which is
    // exactly the false confidence the manifest exists to prevent.
    'stress.resistor-power': 'Resistor power vs rating',
    'stress.voltage': 'Voltage stress vs absolute maximum',
    'stress.current': 'Current stress vs rating',
    robustness: 'Tolerance robustness (Monte-Carlo / corners)',
    decoupling: 'Decoupling present',
    polarity: 'Polarity orientation-consistency',
    'connectivity-parity': 'Netlist ↔ layout connectivity',
    drc: 'Design-rule check (fab tier)',
    manufacturability: 'Manufacturable (DRC-clean gate)',
    thermal: 'Thermal / junction temperature',
    emi: 'EMI / EMC',
    compliance: 'Regulatory compliance',
};

/**
 * Checks that are out of scope by DECISION, with the reason. These are not gaps waiting to be filled —
 * each needs an input the design does not carry (a thermal resistance datum), or is a laboratory
 * measurement that no simulation can stand in for (radiated emissions, a certification test). Stating the
 * reason is what separates a considered exclusion from an oversight.
 */
export const EXCLUDED_CHECKS: Partial<Record<CheckId, string>> = {
    thermal:
        'needs a per-part thermal resistance and an ambient/airflow assumption the design does not carry — a junction-temperature number without them would be invented',
    emi: 'radiated and conducted emissions are a laboratory measurement on a physical board, not a property derivable from a netlist',
    compliance:
        'certification (CE, FCC, UL) is granted against a built unit by an accredited body — no analysis here can assert it',
};

/**
 * Build a manifest fragment: the producer names the checks it OWNS and supplies whatever it determined;
 * every owned check it did not set is emitted as status:'not-run' (the disclosure invariant — an owned
 * check is never silently absent).
 */
export function buildManifest(
    owned: readonly CheckId[],
    determined: Partial<Record<CheckId, DeterminedEntry>>,
): ScopeManifest {
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
    /** Resistor dissipation vs rating — 'run' when it produced a report (informational), else not-run. Named
     *  for what it measures: it does NOT cover capacitors, semiconductors or current. */
    resistorPower?: DeterminedEntry;
    /** worst-case corner / Monte-Carlo robustness — 'run' only when the caller requested and it executed. */
    robustness?: DeterminedEntry;
    decoupling?: DeterminedEntry;
    polarity?: DeterminedEntry;
}): ScopeManifest {
    const covered = new Set(input.coveredDimensions);
    const dim = (d: SpecDimension): DeterminedEntry =>
        covered.has(d) ? { status: 'run', detail: 'an assertion checks this quantity' } : { status: 'not-run' };
    return buildManifest(
        [
            'sim',
            'erc',
            'assertion.voltage',
            'assertion.current',
            'assertion.frequency',
            'assertion.thd',
            'stress.resistor-power',
            'stress.voltage',
            'stress.current',
            'robustness',
            'decoupling',
            'polarity',
            'thermal',
            'emi',
            'compliance',
        ],
        {
            sim: { status: input.simRan ? 'run' : 'not-run' },
            erc: { status: 'run' }, // ERC is a hard gate that always executes on this path
            'assertion.voltage': dim('voltage'),
            'assertion.current': dim('current'),
            'assertion.frequency': dim('frequency'),
            'assertion.thd': dim('thd'),
            'stress.resistor-power': input.resistorPower ?? {
                status: 'not-run',
                detail: 'no resistor-power data (sim not ok / no resistors)',
            },
            // The other two stress axes have no detector. They are OWNED and disclosed not-run rather than
            // left out, because the reader has to be able to see that nobody checked the capacitor on the
            // 12V rail. An unlisted check is indistinguishable from a passed one.
            'stress.voltage': { status: 'not-run', detail: 'no absolute-maximum voltage check is implemented' },
            'stress.current': { status: 'not-run', detail: 'no per-part current-rating check is implemented' },
            robustness: input.robustness ?? { status: 'not-run', detail: 'tolerance robustness not requested' },
            // Decoupling presence is DEFERRED, not merely unimplemented: the circuit model has no power-rail
            // marking, so a "rail" could only be guessed (a DC source may drive a signal/reference net), and
            // `generic` conflates ICs with connectors — either guess produces false findings. Disclosed
            // not-run until the schema carries an isPower net field / typed power-pin roles.
            decoupling: input.decoupling ?? {
                status: 'not-run',
                detail: 'deferred — no power-rail marking in the model to identify a rail reliably (needs an isPower net field / power-pin roles)',
            },
            polarity: input.polarity ?? { status: 'not-run', detail: 'no polarized diode/zener/LED to evaluate' },
            ...excludedEntries('thermal', 'emi', 'compliance'),
        },
    );
}

/**
 * Restate ONE check on an existing manifest, for the case where a later stage actually ran it.
 *
 * The multi-candidate design path is the reason this exists: each finalist runs its fix-loop with
 * Monte-Carlo off, and MC runs once at the end on the winner alone. The winner therefore carries a manifest
 * that says robustness did not run, next to a robustness verdict that did — the manifest contradicting the
 * verdict beside it, which is worse than having no manifest. Rebuilding it in place keeps the two in step.
 *
 * Throws on an id the manifest does not own: a fragment lists the checks belonging to its own endpoint, and
 * quietly appending a foreign one would let a producer claim a check it has no business reporting.
 */
export function withCheck(manifest: ScopeManifest, id: CheckId, entry: DeterminedEntry): ScopeManifest {
    if (!manifest.checks.some((c) => c.id === id)) throw new Error(`withCheck: manifest does not own check "${id}"`);
    return { checks: manifest.checks.map((c) => (c.id === id ? { id, ...entry } : c)) };
}

/**
 * Turn ids from the exclusion registry into determined entries, so a reason is written once and reused.
 *
 * Throws on an id with no registered reason. "Excluded" with a blank reason is the failure mode this whole
 * primitive exists to prevent — it reads as considered while saying nothing, which is a more convincing
 * version of silence than silence itself.
 */
export function excludedEntries(...ids: readonly CheckId[]): Partial<Record<CheckId, DeterminedEntry>> {
    return Object.fromEntries(
        ids.map((id) => {
            const detail = EXCLUDED_CHECKS[id];
            if (!detail) throw new Error(`excludedEntries: no exclusion reason registered for "${id}"`);
            return [id, { status: 'excluded', detail }];
        }),
    );
}

/** The layout / manufacturability (GET /layouts/:id) fragment, from the job's existing verdict signals. */
export function buildLayoutScope(input: {
    parityPins?: { checked: number; expected: number };
    drcClean: boolean;
    drcViolations: number;
    /** Findings KiCad rated below error. They are REPORTED and never gated on — disclosed here so a clean
     *  verdict cannot read as "the board had nothing to say". Omit only when the report could not carry
     *  them (an older report produced at error severity), which is itself disclosed. */
    drcWarnings?: number;
    manufacturable: boolean;
}): ScopeManifest {
    return buildManifest(['connectivity-parity', 'drc', 'manufacturability'], {
        'connectivity-parity': {
            status: 'run',
            detail: input.parityPins
                ? `${input.parityPins.checked}/${input.parityPins.expected} pins isomorphic`
                : undefined,
        },
        drc: {
            status: 'run',
            // The warning count rides on the SAME line as the verdict on purpose. Held separately it reads
            // as a footnote; here a reader cannot take in "DRC-clean" without also taking in what that
            // clean verdict was not deciding on.
            detail:
                (input.drcClean
                    ? 'no blocking violation against the ordered fab rules'
                    : `${input.drcViolations} blocking violation(s)`) +
                (input.drcWarnings === undefined
                    ? ' — warning-severity findings were not collected on this run'
                    : input.drcWarnings === 0
                      ? ' — and no warning-severity findings'
                      : `; ${input.drcWarnings} warning-severity finding(s) reported, none of which gate delivery`),
        },
        manufacturability: {
            status: 'run',
            detail: input.manufacturable ? 'delivered (DRC-clean)' : 'fab bundle withheld (not DRC-clean)',
        },
    });
}
