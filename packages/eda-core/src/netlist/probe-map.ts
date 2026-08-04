/**
 * The ONE answer to "what did the simulator call this piece of copper?"
 *
 * WHY THIS FILE EXISTS, stated as the bug it closes rather than as an architecture preference. This
 * mapping used to live inside `generateNetlist`, and the assertion evaluator — which has to arrive at the
 * SAME name or a criterion can never meet its own measurement — kept a private second copy of it. The copy
 * was a subset, and every place it fell short was a defect that reported a correct design as unverifiable:
 *
 *   • GROUND. The generator sends a ground net to SPICE node `0`; the copy sent it to `x_gnd`.
 *   • DIGITAL. A pure-digital net carries an event, not a voltage, so it cannot be sampled at all; the
 *     generator synthesises a converter onto an analog twin and probes THAT. The copy modelled none of it,
 *     so a criterion on any digital output resolved to a node the deck never contained.
 *   • DIFFERENTIAL. `v(a,b)` is two references; the generator maps each side independently, the copy
 *     flattened the whole string into one token. Worse than missing: the flattened token can COLLIDE with
 *     a real net (a comma and a hyphen sanitise identically), so the criterion binds to an unrelated
 *     signal and answers with confidence.
 *
 * Three symptoms, one cause. So the fix is not three patches but the removal of the second authority: the
 * mapping moves here, and BOTH the generator and the evaluator call it. That the GENERATOR consumes it is
 * the load-bearing part — a shared function only one side uses is still two implementations waiting to
 * drift, whereas this one cannot drift without the generator's own tests going red.
 *
 * PURE. Everything here is derived from the circuit (plus `logicVoltage`, the single option that reaches
 * the digital planner), with no I/O and no hidden state, so a caller that has only a `CircuitJson` can
 * reconstruct exactly what a generated deck used.
 */
import type { CircuitJson, Net } from '../types/circuit';

import { planMixedSignal, type MixedSignalPlan } from './digital';
import { sanitizeNodeName } from './sanitizer';

/**
 * net id -> the SPICE node name a simulation of this circuit will report.
 *
 * EXPORTED because it is the only correct answer to "which simulation signal is this piece of copper?".
 * The rule is not obvious — a net id is lower-cased, non-word characters collapse, SPICE reserved words
 * take an `x_` prefix, everything else takes an `n` prefix, and a result that collides with an ngspice
 * operator token escapes again — so any consumer that re-derived it would be a second implementation of a
 * naming rule that must have exactly one. This is the same function generateNetlist emits against, so a
 * caller joining on it is joining on what the simulator actually saw.
 *
 * Ground is `0`, per SPICE.
 */
export function buildNodeMap(nets: Net[]): Map<string, string> {
    const nodeMap = new Map<string, string>();

    for (const net of nets) {
        if (net.isGround) {
            nodeMap.set(net.id, '0');
        } else {
            nodeMap.set(net.id, sanitizeNodeName(net.id));
        }
    }

    return nodeMap;
}

/**
 * net reference (id OR name, lower-cased) -> the node actually emitted.
 *
 * Three passes, and the ORDER is the contract. Names are seeded first and ids overwrite them, because ids
 * are unique and authoritative while two nets may legitimately carry the same name. The digital overlay is
 * applied LAST so it wins over the raw node: a caller naming a digital net must reach the twin, which is
 * the only thing that has a value.
 */
export function buildNetRefToNode(
    circuit: CircuitJson,
    nodeMap: Map<string, string>,
    /** Only `probeNodeForNet` is consulted; narrowed so a caller need not build a whole plan. */
    ms: Pick<MixedSignalPlan, 'probeNodeForNet'>,
): Map<string, string> {
    const netRefToNode = new Map<string, string>();
    for (const net of circuit.nets) {
        const node = nodeMap.get(net.id);
        if (node && net.name) netRefToNode.set(net.name.toLowerCase(), node); // names first…
    }
    for (const net of circuit.nets) {
        const node = nodeMap.get(net.id);
        if (node) netRefToNode.set(net.id.toLowerCase(), node); // …ids win on collision (ids are unique/authoritative)
    }
    // A pure-digital net's raw event node can't be sampled through wrdata, so planMixedSignal bridged it to
    // an analog "_p" twin (probeNodeForNet). generateDefaultProbes already probes the twin; apply the SAME
    // redirect to CALLER-supplied probes (the version-sim path always passes explicit probes) so v(<netId>),
    // v(<netName>) AND v(<sanitized node>) all resolve to the observable analog twin. Overlaid LAST so it
    // wins over the raw node above. No-op for analog-only circuits (probeNodeForNet is empty).
    for (const net of circuit.nets) {
        const twin = ms.probeNodeForNet.get(net.id);
        if (!twin) continue;
        netRefToNode.set(net.id.toLowerCase(), twin);
        if (net.name) netRefToNode.set(net.name.toLowerCase(), twin);
        const raw = nodeMap.get(net.id);
        if (raw) netRefToNode.set(raw.toLowerCase(), twin);
    }
    return netRefToNode;
}

/**
 * Rebuild, from a circuit alone, the mapping a generated deck used.
 *
 * FOR THE CONSUMER SIDE — the assertion evaluator, which is handed measurements and a circuit and never
 * sees the deck. Safe to reconstruct because every input is a pure function of the circuit:
 * `buildNodeMap` reads only `circuit.nets`, and the twin node name comes from `uniqueNode`, whose backing
 * set is seeded from `nodeMap` alone (the device-name uniquifier is a SEPARATE set and never touches a
 * node name). `logicVoltage` is threaded because it is the one generator option that reaches the planner;
 * it selects the logic-high level, not any node's name, and is accepted here so a caller that passed it to
 * `generateNetlist` can pass the same value and get an identical map.
 *
 * The empty `Set` is deliberate: `planMixedSignal` mutates it to reserve synthesized DEVICE names, which
 * do not appear in this result, so the mutation is discarded with the call.
 */
export function buildProbeResolver(circuit: CircuitJson, opts: { logicVoltage?: number } = {}): ProbeResolver {
    const nodeMap = buildNodeMap(circuit.nets);
    const ms = planMixedSignal(circuit, nodeMap, new Set(), opts.logicVoltage);
    return {
        netRefToNode: buildNetRefToNode(circuit, nodeMap, ms),
        groundRefs: new Set(
            circuit.nets
                .filter((n) => n.isGround)
                .flatMap((n) => [n.id.toLowerCase(), n.name?.toLowerCase()])
                .filter((r): r is string => !!r)
                // The literal SPICE reference, but only when no real net has claimed that name. A net whose
                // id is `0` is emitted as node `n0` and is an ordinary node carrying an ordinary voltage;
                // treating a criterion on it as "the reference is 0 V" would answer a real measurement with
                // a constant. Rare, and it is the generator/evaluator disagreement this module exists to
                // remove — so it is not left to chance.
                .concat(circuit.nets.some((n) => n.id.toLowerCase() === '0' && !n.isGround) ? [] : ['0']),
        ),
    };
}

/**
 * What a consumer needs to talk about a deck it cannot see.
 *
 * `groundRefs` is carried separately from the map because ground is the one reference that has no column to
 * bind to and never will: ngspice has no voltage vector for node 0, and asking for one aborts the whole
 * output line and takes every other probe down with it — so the generator drops a ground probe on purpose.
 * A consumer therefore cannot answer a ground criterion by LOOKING; it has to KNOW. Every id and name of
 * every ground net is listed, plus the literal `0`, so all the ways a person might name the reference land
 * on the same answer.
 */
export interface ProbeResolver {
    /** net reference (id or name, lower-cased) → the node the deck emitted. */
    readonly netRefToNode: ReadonlyMap<string, string>;
    /** Every way this circuit's reference node can be named, lower-cased. */
    readonly groundRefs: ReadonlySet<string>;
}

/**
 * Normalize a caller-supplied probe: a BARE node token (no v()/i()/@ wrapper) is a voltage probe, so wrap it as
 * v(<token>) — then it flows through the SAME net-id → sanitized-node resolution (rewriteProbeNodeRefs) as an
 * explicit v(<net>). Without this a probe like "out" (a natural thing for a client/UI to send) lands in the
 * wrdata line verbatim as `out`, which is NOT a valid ngspice vector (it must be v(x_out)); wrdata then emits
 * nothing and the run yields an opaque "no output file" failure. Already-typed probes — v(...), i(...), @dev[i],
 * or any token containing '(' or '@' — pass through untouched.
 */
export function normalizeProbe(probe: string): string {
    const t = probe.trim();
    if (!t || t.includes('(') || t.includes('@')) return t;
    return `v(${t})`;
}

/**
 * Rewrite node references — v(<net>) and the differential v(<net>,<net>) — in a probe so they point at
 * the sanitized SPICE node name actually emitted (e.g. net "rail"→"nrail", reserved "out"→"x_out"). A
 * caller naturally writes v(rail)/v(out) using the circuit's net id (or name), but ngspice only knows the
 * sanitized node, so the raw reference resolves to "no such vector". `map` is keyed by the lower-cased net
 * id AND net name (id wins on collision). Each comma-separated arg is mapped independently; an arg that is
 * already a sanitized node (or otherwise unknown) is left as-is, so default/correct probes are untouched.
 *
 * THE WHOLE INNER STRING IS TRIED AS A KEY FIRST, before the comma is treated as a separator. A comma is
 * legal in a net id, and `v(a,b)` is then genuinely ambiguous — one net called `a,b`, or the difference of
 * two nets. An exact match on what the circuit actually contains is the better reading of the two, and it
 * is what the sanitiser already assumes: it collapses a comma to `_` exactly like any other separator, so
 * a net id of `a,b` emits node `na_b` and a probe naming it has to be able to reach that.
 */
export function rewriteProbeNodeRefs(
    probe: string,
    map: ReadonlyMap<string, string>,
    keepGroundFirstSingleEnded = false,
): string {
    return probe.replace(/\bv\s*\(\s*([^)]+?)\s*\)/gi, (whole, inner: string) => {
        const exact = map.get(inner.trim().toLowerCase());
        if (exact !== undefined) return exact === '0' ? '' : `v(${exact})`;
        const parts = inner.split(',').map((p) => p.trim());
        const mapped = parts.map((p) => map.get(p.toLowerCase()) ?? p);
        // ngspice has no voltage vector for ground (node 0): a v(node,gnd) differential is just the
        // single-ended v(node), and a pure-ground probe v(gnd)/v(0) is meaningless — emitting either
        // v(0) or v(node,0) errors with "no such vector 0" and aborts the WHOLE wrdata, killing every
        // other probe on the line. So drop ground args; a probe that reduces to nothing is dropped.
        //
        // Dropping ground is only sign-SAFE when ground is the SUBTRAHEND: v(a,0) = v(a) - 0 = v(a). When
        // ground is the FIRST operand, v(0,b) = 0 - v(b) = -v(b) — for a wrdata probe (sign matters) we DROP
        // it rather than emit the sign-FLIPPED v(b) (which would corrupt an acceptance criterion). For a
        // .noise/.sens OUTPUT the sign is irrelevant (a PSD/sensitivity magnitude) AND the card must resolve
        // to a real node or the whole analysis fails — so those callers pass keepGroundFirstSingleEnded to
        // keep the sanitized single-ended v(b) instead of dropping.
        if (!keepGroundFirstSingleEnded && mapped.length === 2 && mapped[0] === '0') return ''; // v(0,b)=-v(b) → drop
        const nonGround = mapped.filter((a) => a !== '0');
        const unchanged = nonGround.length === parts.length && nonGround.every((a, i) => a === parts[i]);
        if (unchanged) return whole; // no remap and no ground arg — preserve the original text verbatim
        return nonGround.length === 0 ? '' : `v(${nonGround.join(',')})`;
    });
}
