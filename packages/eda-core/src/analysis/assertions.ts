/**
 * Pure assertion evaluation — the ONE place a measurable spec is checked against a simulation result.
 *
 * Shared by verify-design (user-supplied assertions), the AI design loop (model-emitted acceptance criteria),
 * AND the Monte-Carlo worker batch (per-variant pass/fail). It lives in eda-core — not the API — precisely so
 * the worker, which depends only on eda-core, can reduce each variant to pass/fail locally. No ngspice here:
 * it operates on the already-summarized per-node measurements.
 */
import { sanitizeNodeName } from '../netlist/sanitizer';
import type { SimMeasurement } from './measurements';
import type { FourierResult, TransferFunctionResult } from '../types/simulation';

/**
 * A measurable pass/fail check derived from the user's stated numeric intent (the plain shape; the API's
 * AssertionDto and llm-core's AcceptanceCriterion both match it structurally).
 */
export interface AcceptanceCriterion {
    /** Probe/node to measure, e.g. "out" / "v(out)" / "i(R1)". */
    probe: string;
    /** Which measured quantity. min/max/final/pp/avg/rms are over the time/DC run (avg+rms are TIME-WEIGHTED —
     *  trapezoidal over the adaptive timesteps — so "RMS output" / "average ripple" specs are exact); "cutoff"
     *  is the −3 dB corner (Hz) of the node's AC magnitude response (requires an "ac" analysis); "thd" is the
     *  Total Harmonic Distortion in PERCENT (requires a "tran" analysis with a "fourier" request on the probe);
     *  "gain" is the small-signal DC gain Vout/Vin (requires an "op" analysis with a "tf" request to the probe). */
    metric: 'min' | 'max' | 'final' | 'pp' | 'avg' | 'rms' | 'cutoff' | 'thd' | 'gain';
    op: 'lt' | 'lte' | 'gt' | 'gte' | 'approx';
    /** Target value in SI base units (volts, amps, seconds; Hz for "cutoff"; PERCENT for "thd"). */
    value: number;
    /** Absolute tolerance for op="approx" (default 5% of |value|). */
    tol?: number;
    label?: string;
}

export interface AssertionResult {
    label: string;
    probe: string;
    metric: AcceptanceCriterion['metric'];
    op: AcceptanceCriterion['op'];
    target: number;
    tol?: number;
    /** Measured value, or null when the probe wasn't found / the sim produced no results. */
    actual: number | null;
    pass: boolean;
    /** Signed gap from the target (`actual - target`), or null when unmeasured. Lets a caller tell a
     *  marginal miss (−0.001) from a catastrophic one (−7) and tells the AI fix loop how far off it is. */
    distance: number | null;
    detail: string;
}

/**
 * Map a user-facing probe to the SPICE node the simulator actually reports. The user thinks in NET names
 * ("out"); the netlist generator emits each net's node from its ID run through sanitizeNodeName. We apply the
 * SAME transform (after stripping a v() wrapper) so "out" / "v(out)" / "V(OUT)" all resolve to the one node the
 * measurement carries. Lowercased (ngspice emits lower-case node names).
 *
 * `refToId` bridges the case where a net's ID differs from its NAME: the generator keys the SPICE node off the
 * net ID, but a criterion usually names the net ("v(out)"). Passing the {name→id, id→id} map (built from the
 * circuit's nets — see netIdByRef) resolves the reference to its canonical ID *before* sanitizing, so a
 * name-based probe still matches. Today net.id === net.name so it is a no-op; once the frontend mints UUID ids
 * (id !== name), it is the difference between "verified" and a permanent "probe not found". Mirrors the
 * generator's netRefToNode precedence (name first, id authoritative).
 */
export function nodeKey(probe: string, refToId?: Map<string, string>): string {
    const m = probe.trim().match(/^v\(([^)]+)\)$/i);
    const bare = (m ? m[1]! : probe.trim()).trim();
    const canonical = refToId?.get(bare.toLowerCase()) ?? bare;
    return sanitizeNodeName(canonical).toLowerCase();
}

/**
 * Build the {net reference → canonical net ID} lookup a criterion's probe is resolved through (see nodeKey).
 * Names are seeded first and IDs overwrite on collision — IDs are unique + authoritative — mirroring exactly
 * the precedence of the generator's netRefToNode, so the assertion evaluator resolves a net reference to the
 * SAME node the generator emitted it as.
 */
export function netIdByRef(nets: ReadonlyArray<{ id: string; name?: string }>): Map<string, string> {
    const map = new Map<string, string>();
    for (const n of nets) if (n.name) map.set(n.name.trim().toLowerCase(), n.id);
    for (const n of nets) map.set(n.id.trim().toLowerCase(), n.id);
    return map;
}

/** A current/power probe (i(R1), @r1[i]) — NOT a node voltage. */
export function isCurrentProbe(probe: string): boolean {
    return /^\s*i\s*\(/i.test(probe) || /\[\s*i\s*\]\s*$/i.test(probe);
}

/**
 * Canonical device designator for a CURRENT probe, so the CRITERION form the model writes (`i(R1)`,
 * `I( V1 )`) and the MEASURED-series form the simulator reports (`@r1[i]` — how `wrdata` + `savecurrents`
 * names a saved R/C branch current; verified on ngspice-41) resolve to the SAME key. Lowercased. Returns
 * null when no device name can be extracted. Without this, a current criterion would never match its own
 * measurement (`nodeKey("i(R1)") !== nodeKey("@r1[i]")`) and would always read as "probe not found".
 */
export function currentKey(probe: string): string | null {
    const p = probe.trim();
    const paren = p.match(/^i\s*\(\s*([^)]+?)\s*\)$/i); // i(R1), I( V1 )
    if (paren) return paren[1]!.toLowerCase();
    const at = p.match(/^@\s*([^[\s]+?)\s*\[\s*i\s*\]$/i); // @r1[i]
    if (at) return at[1]!.toLowerCase();
    return null;
}

/** Device prefixes whose branch current ngspice can actually report (R/C via @<dev>[i] + savecurrents;
 *  V/L/E/H via native i()). A diode (D), transistor (Q/M/J), subckt (X), behavioral (B), switch (S) etc.
 *  have NO branch-current vector — the generator silently drops such a probe, so it would read as
 *  "probe not found" rather than measure anything. Lets callers reject it up front with a clear message
 *  (probe a series resistor's current instead). */
const OBSERVABLE_CURRENT_DEVICE = /^[rcvleh]/i;
export function isObservableCurrentProbe(probe: string): boolean {
    const dev = currentKey(probe);
    return dev !== null && OBSERVABLE_CURRENT_DEVICE.test(dev);
}

/**
 * The probes a criteria set needs UNIONed into the netlist beyond the generator's default node-voltage sweep.
 * Today that is EXACTLY the branch-CURRENT criteria (`i(R1)` / `@r1[i]`): the generator auto-probes every node
 * VOLTAGE but never a branch current, so a current criterion must have its probe added via generateNetlist's
 * `extraProbes` or it reads "probe not found". Voltage criteria need nothing (auto-probed); a frequency (`cutoff`),
 * `thd`, or `gain` criterion rides on the ANALYSIS request (ac / fourier / tf), not on a probe. This is the ONE
 * place the criterion→extra-probe seam is derived, shared by the nominal verify path AND every variant batch
 * (Monte-Carlo / corner / sweep) so those paths can't measure a different set and silently diverge.
 */
export function extraProbesForCriteria(criteria: { probe: string }[]): string[] {
    return criteria.filter((c) => isCurrentProbe(c.probe)).map((c) => c.probe);
}

/** Namespaced match key: a current probe keys by its device (`i:r1`), a voltage probe by its node
 *  (`v:<nodeKey>`). Keeps the two kinds from colliding AND bridges `i(R1)` ↔ the measured `@r1[i]`.
 *  `refToId` (net reference → canonical id) is applied only to VOLTAGE keys, to resolve a name-based probe to
 *  its id-derived node (see nodeKey); the measured node is already a SPICE node so it is keyed with no map. */
function matchKey(probeOrNode: string, refToId?: Map<string, string>): string {
    if (isCurrentProbe(probeOrNode)) {
        return `i:${currentKey(probeOrNode) ?? probeOrNode.trim().toLowerCase()}`;
    }
    return `v:${nodeKey(probeOrNode, refToId)}`;
}

export function compareAssertion(actual: number, op: AcceptanceCriterion['op'], target: number, tol?: number): boolean {
    switch (op) {
        case 'lt':
            return actual < target;
        case 'lte':
            return actual <= target;
        case 'gt':
            return actual > target;
        case 'gte':
            return actual >= target;
        case 'approx': {
            // Default tolerance: 5% of |target|, or an absolute 1e-9 floor so target=0 still works.
            const t = tol ?? Math.max(Math.abs(target) * 0.05, 1e-9);
            return Math.abs(actual - target) <= t;
        }
    }
}

/**
 * Evaluate each assertion against the measurements. When the sim didn't run (simOk=false) every assertion
 * is unmet (actual=null) — you can't certify a spec you couldn't measure.
 *
 * `nets` (the circuit's nets) is OPTIONAL but should be passed whenever available: it lets a criterion that
 * names a net ("v(out)") resolve to the SPICE node the generator emitted from that net's ID, so the check still
 * matches when the net's id differs from its name (universal once the frontend mints UUID ids). Omitted → the
 * probe is matched by its sanitized text exactly as before (correct while id === name).
 */
export function evaluateAssertions(
    measurements: SimMeasurement[],
    assertions: AcceptanceCriterion[],
    simOk = true,
    nets?: ReadonlyArray<{ id: string; name?: string }>,
): AssertionResult[] {
    const refToId = nets?.length ? netIdByRef(nets) : undefined;
    // Measured nodes are ALREADY sanitized SPICE nodes → keyed with no ref map; only the user-facing criterion
    // probe is resolved through refToId (net name/id → canonical id → node).
    const byKey = new Map(measurements.map((m) => [matchKey(m.node), m]));
    return assertions.map((a) => {
        const label = a.label ?? `${a.probe} ${a.metric} ${a.op} ${a.value}`;
        const base = { label, probe: a.probe, metric: a.metric, op: a.op, target: a.value, tol: a.tol };
        const m = simOk ? byKey.get(matchKey(a.probe, refToId)) : undefined;
        if (!m) {
            return {
                ...base,
                actual: null,
                distance: null,
                pass: false,
                detail: simOk ? `probe "${a.probe}" not found in simulation output` : 'simulation did not produce results',
            };
        }
        let measured: number;
        if (a.metric === 'cutoff') {
            // The −3 dB corner is derived ONLY for an AC magnitude series; it is `null` when the sweep didn't
            // bracket exactly one crossing (flat / out-of-band / band-pass) and absent for a non-AC run.
            // Either way the frequency target was not actually MEASURED → not verified (never a silent pass).
            const fc = m.cutoff ?? null;
            if (fc === null) {
                return {
                    ...base,
                    actual: null,
                    distance: null,
                    pass: false,
                    detail: `cutoff(${a.probe}) not determinable — use an AC analysis ("type":"ac") on a source declared "AC 1" and widen the sweep so |H| crosses −3 dB exactly once around the corner`,
                };
            }
            measured = fc;
        } else if (a.metric === 'thd') {
            // THD (%) is folded onto the measurement from a fourier request (attachFourierThd) — it is NOT
            // derivable from the series. Absent ⇒ the probe wasn't fourier-analyzed ⇒ not measured ⇒ not
            // verified (never a silent pass), mirroring the cutoff handling above.
            if (m.thd === undefined || !Number.isFinite(m.thd)) {
                return {
                    ...base,
                    actual: null,
                    distance: null,
                    pass: false,
                    detail: `thd(${a.probe}) not determinable — needs a "tran" analysis with a "fourier" request on this probe`,
                };
            }
            measured = m.thd;
        } else if (a.metric === 'gain') {
            // Small-signal DC gain (Vout/Vin) is folded onto the measurement from a `.tf` request
            // (attachTransferFunction) — NOT derivable from the series. Absent ⇒ no tf to this probe ⇒ not
            // measured ⇒ not verified (never a silent pass), mirroring cutoff/thd.
            if (m.gain === undefined || !Number.isFinite(m.gain)) {
                return {
                    ...base,
                    actual: null,
                    distance: null,
                    pass: false,
                    detail: `gain(${a.probe}) not determinable — needs an "op" analysis with a "tf" request to this probe`,
                };
            }
            measured = m.gain;
        } else {
            // Read FULL-PRECISION values (the rounded display fields can flip a marginal check — audit #8).
            const src = m.raw ?? { min: m.min, max: m.max, final: m.final, pp: m.pp, avg: m.avg, rms: m.rms };
            if (isCurrentProbe(a.probe)) {
                // Current is SIGNED by device pin order in ngspice (a correctly-wired resistor's @r1[i] can
                // read negative); a current spec is a MAGNITUDE ("~10mA through R1"). For a PEAK query
                // (min/max) the worst case is the largest |excursion| in EITHER direction — |max| alone
                // misses a large NEGATIVE swing (audit #5). final is one signed instant; pp is already ≥ 0.
                // Taking the magnitude here is also why a sound design can satisfy a positive current target
                // (the fix loop can't chase a positive spec against a negative reading otherwise).
                measured =
                    a.metric === 'max' || a.metric === 'min'
                        ? Math.max(Math.abs(src.min), Math.abs(src.max))
                        : Math.abs(src[a.metric]);
            } else {
                measured = src[a.metric];
            }
        }
        // No FINITE value → the probe matched a series with no usable samples (empty / all-NaN — summarizeSeries
        // returns NaN, never 0). A 0 here would silently SATISFY specs like "v(x) < 1"; treat it as unmeasurable
        // (actual = null), never a pass. (cutoff/thd/gain already returned null above when absent.)
        if (!Number.isFinite(measured)) {
            return {
                ...base,
                actual: null,
                distance: null,
                pass: false,
                detail: `${a.metric}(${a.probe}) not measurable — the probe's series had no finite samples (empty / all-NaN)`,
            };
        }
        // Verdict on the full-precision `measured`; round ONLY for display (audit #8). A cutoff is a frequency
        // already reported at full precision, so it is shown as-is (matches prior behaviour).
        const pass = compareAssertion(measured, a.op, a.value, a.tol);
        const actual = a.metric === 'cutoff' ? measured : Number(measured.toPrecision(4));
        return {
            ...base,
            actual,
            distance: actual - a.value,
            pass,
            detail: `${a.metric}(${a.probe}) = ${actual} ${pass ? '✓' : '✗'} ${a.op} ${a.value}`,
        };
    });
}

/**
 * Fold each `.four`/fourier THD (PERCENT) onto the matching per-node measurement, so a `thd` criterion is
 * evaluated through the SAME measurement path as every other metric (mirrors how `cutoff` rides on the AC
 * measurement). Matches a fourier result's probe to a measurement's node by the canonical node key. Mutates
 * `measurements` in place; a no-op when there is no fourier data. This is the ONE place THD enters the verdict,
 * so it composes with BOTH the nominal check AND the Monte-Carlo per-variant eval (the MC runner calls it too).
 */
export function attachFourierThd(measurements: SimMeasurement[], fourier: FourierResult[] | undefined): void {
    if (!fourier || fourier.length === 0) return;
    for (const m of measurements) {
        const f = fourier.find((fr) => nodeKey(fr.probe) === nodeKey(m.node));
        if (f && Number.isFinite(f.thd)) m.thd = f.thd;
    }
}

/**
 * Fold a `.tf` small-signal DC gain onto the measurement of its output node, so a `gain` criterion is evaluated
 * through the SAME measurement path as every other metric (same posture as attachFourierThd). A single tf result
 * (one output node) → at most one measurement updated, matched by node key. Mutates; no-op without a finite gain.
 */
export function attachTransferFunction(measurements: SimMeasurement[], tf: TransferFunctionResult | undefined): void {
    if (!tf || !Number.isFinite(tf.gain)) return;
    const m = measurements.find((mm) => nodeKey(mm.node) === nodeKey(tf.outputNode));
    if (m) m.gain = tf.gain;
}

/** A one-line, human/AI-readable description of a failed criterion incl. how far off it is — fed to the
 *  AI fix loop so it knows "gain 3 vs 10" (catastrophic) differs from "4.99 vs 5.00" (marginal). */
export function describeFailure(r: AssertionResult): string {
    if (r.actual === null) {
        return `${r.label}: ${r.detail}`;
    }
    const off = r.distance ?? 0;
    const rel = r.target !== 0 ? ` (${((off / Math.abs(r.target)) * 100).toFixed(0)}% off)` : '';
    return `${r.label}: measured ${r.metric}(${r.probe}) = ${r.actual}, required ${r.op} ${r.target} — off by ${off.toPrecision(3)}${rel}`;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * Spec-coverage: does the design's criteria set actually measure the QUANTITY the user named?
 *
 * The adversarial-jury finding behind this: when the user's load-bearing quantity is a single DC node
 * voltage, criteria are faithful and "verified" is sound. But when it is a CURRENT (or a FREQUENCY), the
 * model tends to substitute a loosely-coupled node-voltage PROXY and still claim verified=true (e.g. an LED
 * "≈10mA" spec "verified" by checking the anode sits at ≈2V — a 3×-wrong resistor would pass). The fix is
 * a CODE-side gate (the model rationalizes past prompt suggestions): if the user named a current target,
 * a criterion MUST probe a branch current, or the design is not "verified".
 *
 * The same reasoning extends to THD (total harmonic distortion): a numeric distortion target (e.g. "THD < 1%")
 * has NO node-voltage proxy — it is measurable ONLY via the fourier `thd` metric — so a bounded THD target
 * without a `thd` criterion is a hard coverage gap. (Detection requires the NUMBER: a bare "warm harmonic
 * distortion" is a WANTED effect, not a spec, and must not trip the gate.) GAIN is deliberately NOT gated here: unlike current/frequency/THD, a gain target has a
 * LEGITIMATE voltage proxy — a peak-to-peak (pp) swing criterion verifies gain when the input amplitude is
 * pinned (gain = Vout_pp / Vin_pp). Gating gain on the `gain` metric alone would false-DOWNGRADE those valid
 * designs, breaking this gate's invariant (a false positive must only ever downgrade an OVER-claim, never a
 * sound design). Proper ratio-vs-swing gain checking belongs in the typed RequirementSpec layer, not here.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────── */

export type SpecDimension = 'voltage' | 'current' | 'frequency' | 'thd';

/** Physical quantity a single criterion actually measures. The `cutoff` metric measures a frequency (the
 *  −3 dB corner of an AC magnitude response); the `thd` metric measures total harmonic distortion (from the
 *  fourier listing); an i()/@…[i] probe measures a current; any other node probe measures a voltage. So a
 *  `cutoff` criterion COVERS the frequency dimension, and a `thd` criterion COVERS the distortion dimension. */
export function criterionDimension(c: { probe: string; metric?: string }): SpecDimension {
    if (c.metric === 'cutoff') return 'frequency';
    if (c.metric === 'thd') return 'thd';
    return isCurrentProbe(c.probe) ? 'current' : 'voltage';
}

// Conservative, magnitude-anchored detectors. The lookbehind keeps an embedded token (a part number like
// "BD139A", or a "10k" value) from tripping the unit — only a standalone number + unit counts.
const CURRENT_MAGNITUDE_RE = /(?<![a-z0-9.])\d+(?:\.\d+)?\s*(?:m|u|µ|n|k|p)?a\b/i; // 10mA, 5 A, 0.5A
const CURRENT_WORD_RE = /(?<![a-z0-9.])\d+(?:\.\d+)?\s*(?:milli|micro|nano|kilo)?amp(?:ere)?s?\b/i; // 10 milliamps
const FREQUENCY_MAGNITUDE_RE = /(?<![a-z0-9.])\d+(?:\.\d+)?\s*(?:k|m|g)?hz\b/i; // 1kHz, 60 Hz
const FREQUENCY_WORD_RE = /\b(?:cutoff|corner\s+frequenc(?:y|ies)|bandwidth|-?\s*3\s*db|passband|stopband|resonant\s+frequency)\b/i;
// THD is magnitude-anchored like current/frequency above: a distortion TERM must sit next to a numeric BOUND
// (a percent or a dB figure), in either order, within a short window. A bare mention is NOT enough — "warm
// harmonic distortion" (a WANTED guitar/tube/tape effect), "M3 THD mounting holes" (THD = threaded), or "THD
// resistors" (through-hole) carry no bound and must never trip the gate and false-downgrade a sound design.
// Requiring the number keeps THD faithful to this module's contract: only a quantity the user put a NUMBER on.
const THD_TERM = String.raw`(?:\bthd\b|\b(?:total\s+)?harmonic\s+distortion\b)`;
const THD_BOUND = String.raw`\d+(?:\.\d+)?\s*(?:%|percent\b|db[c]?\b)`; // 1%, 0.1 %, 5 percent, -60 dB, dBc
const THD_SPEC_RE = new RegExp(String.raw`${THD_TERM}[^.\n]{0,24}${THD_BOUND}|${THD_BOUND}[^.\n]{0,24}${THD_TERM}`, 'i');

/** Quantities the user EXPLICITLY put a numeric target on, detected conservatively from the prompt —
 *  CODE-side, NOT model-trusted (the model is what under-specifies). Voltage is intentionally never
 *  inferred: it is the default everywhere and almost always already carries a criterion. A false negative
 *  is safe (status quo); a false positive only ever DOWNGRADES an over-claimed "verified", never the
 *  reverse — so erring toward not-detecting keeps the gate conservative. */
export function requiredDimensions(prompt: string): Set<SpecDimension> {
    const dims = new Set<SpecDimension>();
    const p = prompt ?? '';
    if (CURRENT_MAGNITUDE_RE.test(p) || CURRENT_WORD_RE.test(p)) dims.add('current');
    if (FREQUENCY_MAGNITUDE_RE.test(p) || FREQUENCY_WORD_RE.test(p)) dims.add('frequency');
    if (THD_SPEC_RE.test(p)) dims.add('thd');
    return dims;
}

/** Required dimensions that we can ACTUALLY verify (have a metric for) yet NO criterion measures — these
 *  must block a "verified" verdict. Three are enforceable: 'current' (i(Rn) branch-current), 'frequency'
 *  (the `cutoff` metric over an AC sweep), and 'thd' (the fourier distortion metric). Each is a quantity
 *  with NO sound voltage proxy, so a target named for it but checked only by a node-voltage criterion is a
 *  fidelity gap, not "verified". (Voltage is never gated — it is the default and almost always already
 *  carries a criterion; gain is never gated — a pp-swing criterion is a legitimate proxy, see above.) */
export function uncoveredRequiredDimensions(
    prompt: string,
    criteria: { probe: string; metric?: string }[],
): SpecDimension[] {
    const required = requiredDimensions(prompt);
    const covered = new Set(criteria.map(criterionDimension));
    // Adding a member to SpecDimension does NOT auto-enforce it — a new enforceable dimension must be wired in
    // THREE coupled places or it silently under-enforces / gives a hint-less fix loop: (1) a detector in
    // requiredDimensions above, (2) a metric mapping in criterionDimension, (3) this ENFORCEABLE list, and
    // (4) a fix-loop hint in llm-core design-core.ts (the `uncovered.includes(...)` chain).
    const ENFORCEABLE: SpecDimension[] = ['current', 'frequency', 'thd'];
    return ENFORCEABLE.filter((d) => required.has(d) && !covered.has(d));
}
