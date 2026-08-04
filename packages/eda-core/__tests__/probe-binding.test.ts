/**
 * Can a criterion reach its own measurement?
 *
 * WHY THIS FILE EXISTS. A criterion ("v(out) should be 5 V") and a measurement (the column ngspice wrote)
 * meet by NAME. The netlist generator decides what that name is; the assertion evaluator has to arrive at
 * the same one. When they disagree the answer is not "wrong" — it is `actual: null, pass: false, "probe not
 * found in simulation output"`. A design that genuinely meets spec is reported as not meeting it, and
 * nothing anywhere says the two halves failed to agree. That is strictly worse than a wrong number,
 * because a wrong number invites a second look.
 *
 * THE ROOT CAUSE IS ONE THING, NOT THREE. The generator builds a real reference→node map: it sends a
 * ground net to SPICE node `0`, redirects a pure-digital net to the analog twin it synthesised so the node
 * can be sampled at all, and splits a differential probe on the comma to map each side independently. The
 * evaluator builds its OWN map (`netIdByRef`), which does none of those. Two authorities on one question;
 * each case below is one place they disagree.
 *
 * HOW THESE ARE CONSTRUCTED, and why that is not cheating. The emitted probe list comes from the REAL
 * generator — no fixture, no hand-typed deck — and the measurement `node` is the emitted token verbatim,
 * because that is precisely what the pipeline does (the CSV header is the wrdata argument list, and
 * `summarizeSeries` carries it through). The NUMBERS are the ones real ngspice produced for these exact
 * decks. So what is under test is the BINDING, which is where the defect is; the physics is established
 * elsewhere and is not re-litigated here on every CI run.
 */
import {
    evaluateAssertions,
    extraProbesForCriteria,
    nodeKey,
    type AcceptanceCriterion,
} from '../src/analysis/assertions';
import type { SimMeasurement } from '../src/analysis/measurements';
import { generateNetlist } from '../src/netlist/generator';
import { buildProbeResolver } from '../src/netlist/probe-map';
import { sanitizeNodeName } from '../src/netlist/sanitizer';
import { extractProbes } from '../src/parser/netlist-parser';
import type { CircuitJson } from '../src/types/circuit';

/** A measurement exactly as the pipeline builds one: `node` IS the emitted wrdata token. */
const meas = (node: string, v: Partial<SimMeasurement> & { flat?: number }): SimMeasurement => {
    const f = v.flat;
    return {
        node,
        min: f ?? 0,
        max: f ?? 0,
        final: f ?? 0,
        pp: 0,
        avg: f ?? 0,
        rms: Math.abs(f ?? 0),
        ...v,
    } as SimMeasurement;
};

/** The CIRCUIT, not its nets — see the legacy-shape test at the bottom for why that distinction matters. */
const evaluate = (measurements: SimMeasurement[], criterion: AcceptanceCriterion, circuit: CircuitJson) =>
    evaluateAssertions(measurements, [criterion], true, circuit)[0]!;

// ---------------------------------------------------------------------------------------------------
// 1. GROUND — "the reference is 0 V" is the one thing every circuit agrees on, and it cannot be asked.
// ---------------------------------------------------------------------------------------------------

const DIVIDER = (groundName: string): CircuitJson => ({
    version: '1.0',
    components: [
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: '5',
            pins: [
                { pinId: '+', netId: 'vin' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '1k',
            pins: [
                { pinId: '1', netId: 'vin' },
                { pinId: '2', netId: 'out' },
            ],
        },
        {
            id: 'r2',
            type: 'resistor',
            designator: 'R2',
            value: '1k',
            pins: [
                { pinId: '1', netId: 'out' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
    ] as never,
    nets: [
        { id: 'vin', name: 'VIN' },
        { id: 'out', name: 'OUT' },
        { id: 'gnd', name: groundName, isGround: true },
    ],
});

describe('a criterion on GROUND', () => {
    // Nothing refuses this upstream: the API validates a probe only as a 1–64 character string, and the
    // one probe-shape guard it has rejects unmeasurable CURRENT probes. "v(gnd) should be 0" is a
    // reasonable thing for a person — or the AI, which is told a probe is "a net name from your circuit" —
    // to write, and it is the single most obviously true assertion a circuit has.

    it('is not measured at all, deliberately — so no map can ever find it', () => {
        // Established first, because it is what makes this different from the other two cases here. ngspice
        // has no vector for node 0; asking for it aborts the WHOLE wrdata line and takes every other probe
        // on it down. So the generator drops a ground probe on purpose. The consequence is that fixing the
        // NAME lookup cannot fix this one: there is no column to bind to.
        const probes = extractProbes(generateNetlist(DIVIDER('GND'), { type: 'op' }));
        expect(probes).toEqual(['v(nvin)', 'v(x_out)']);
        expect(probes.some((p) => /gnd|\(0\)/i.test(p))).toBe(false);
    });

    it('BINDS TO ZERO — the reference voltage is known without measuring it', () => {
        // The honest answer. We are not missing this value; we know it exactly, by definition of what a
        // ground net IS. Refusing the criterion would be defensible and worse: it tells the user their
        // question is illegal when we can simply answer it.
        const circuit = DIVIDER('GND');
        const measurements = [meas('v(nvin)', { flat: 5 }), meas('v(x_out)', { flat: 2.5 })];

        const verdict = evaluate(measurements, { probe: 'v(GND)', metric: 'final', op: 'approx', value: 0 }, circuit);
        expect({ actual: verdict.actual, pass: verdict.pass }).toEqual({ actual: 0, pass: true });
    });

    it('binds by the net ID too, and by the SPICE node the deck uses', () => {
        const circuit = DIVIDER('GND');
        const measurements = [meas('v(nvin)', { flat: 5 })];
        for (const probe of ['v(gnd)', 'gnd', 'v(0)']) {
            const verdict = evaluate(measurements, { probe, metric: 'final', op: 'approx', value: 0 }, circuit);
            expect({ probe, actual: verdict.actual }).toEqual({ probe, actual: 0 });
        }
    });

    it('binds when the ground net is CALLED something else', () => {
        // A board with a separate analog ground names it AGND, and it is still the reference. Keying off
        // the literal string "gnd" would work for the common case and quietly miss this one.
        const circuit = DIVIDER('AGND');
        const verdict = evaluate(
            [meas('v(nvin)', { flat: 5 })],
            { probe: 'v(AGND)', metric: 'final', op: 'approx', value: 0 },
            circuit,
        );
        expect({ actual: verdict.actual, pass: verdict.pass }).toEqual({ actual: 0, pass: true });
    });

    it('a criterion that ground makes trivial still answers, rather than reading as unmeasurable', () => {
        // v(out,gnd) is just v(out) — the generator already knows that and emits the single-ended form.
        const circuit = DIVIDER('GND');
        const verdict = evaluate(
            [meas('v(nvin)', { flat: 5 }), meas('v(x_out)', { flat: 2.5 })],
            { probe: 'v(OUT,GND)', metric: 'final', op: 'approx', value: 2.5 },
            circuit,
        );
        expect({ actual: verdict.actual, pass: verdict.pass }).toEqual({ actual: 2.5, pass: true });
    });
});

// ---------------------------------------------------------------------------------------------------
// 2. DIGITAL — the product's own prompt steers the AI straight into this one.
// ---------------------------------------------------------------------------------------------------

/**
 * One inverter. `a` is MIXED (an analog source drives it, a digital gate reads it); `y` is PURE DIGITAL
 * (only a digital gate drives it), which is what triggers the bridge.
 *
 * A pure-digital net carries an event, not a voltage, so `wrdata` cannot sample it. The generator
 * synthesises a converter onto an analog twin node and probes THAT instead — which is correct, and is why
 * the emitted probe is not the name anybody wrote.
 */
const INVERTER: CircuitJson = {
    version: '1.0',
    components: [
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: 'PULSE(0 5 0 1n 1n 1u 2u)',
            pins: [
                { pinId: '+', netId: 'a' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'u1',
            type: 'logic_not',
            designator: 'U1',
            pins: [
                { pinId: 'in1', netId: 'a' },
                { pinId: 'out', netId: 'y' },
            ],
        },
    ] as never,
    nets: [
        { id: 'a', name: 'a' },
        { id: 'y', name: 'y' },
        { id: 'gnd', name: 'gnd', isGround: true },
    ],
};

describe('a criterion on a DIGITAL net', () => {
    it('the deck probes the analog twin, not the net anybody named', () => {
        const probes = extractProbes(generateNetlist(INVERTER, { type: 'tran', stopTime: '4u', stepTime: '10n' }));
        expect(probes).toEqual(['v(na)', 'v(ny_p)']);
    });

    it('BINDS the criterion to that twin', () => {
        // The values are the ones real ngspice-42 produced for this deck: the inverter works, the output
        // reaches 5 V. Before this was fixed the criterion read `actual: null` on that working inverter —
        // and note the nets here all have id === name, so this has nothing to do with id/name divergence.
        // It fires on the plainest digital circuit anyone can write.
        const measurements = [
            meas('v(na)', { min: 0, max: 5, final: 0 }),
            meas('v(ny_p)', { min: 0, max: 5, final: 5 }),
        ];

        const verdict = evaluate(measurements, { probe: 'v(y)', metric: 'max', op: 'gte', value: 4 }, INVERTER);
        expect({ actual: verdict.actual, pass: verdict.pass }).toEqual({ actual: 5, pass: true });
    });

    it('binds a MIXED net by its own node, unchanged', () => {
        // The bridge applies only where it is needed. A net an analog source drives is sampled directly,
        // and must keep resolving the way it always did.
        const measurements = [
            meas('v(na)', { min: 0, max: 5, final: 0 }),
            meas('v(ny_p)', { min: 0, max: 5, final: 5 }),
        ];
        const verdict = evaluate(measurements, { probe: 'v(a)', metric: 'max', op: 'gte', value: 4 }, INVERTER);
        expect({ actual: verdict.actual, pass: verdict.pass }).toEqual({ actual: 5, pass: true });
    });
});

// ---------------------------------------------------------------------------------------------------
// 3. DIFFERENTIAL — and the one case in this file that can report a wrong PASS.
// ---------------------------------------------------------------------------------------------------

/** High-side shunt: 10 V across 1 Ω + 9 Ω → 1 A, so v(SUP) − v(LOAD) is exactly 1.000 V. */
const SHUNT = (loadNetName: string): CircuitJson => ({
    version: '1.0',
    components: [
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: '10',
            pins: [
                { pinId: '+', netId: 'sup' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'rs',
            type: 'resistor',
            designator: 'RSENSE',
            value: '1',
            pins: [
                { pinId: '1', netId: 'sup' },
                { pinId: '2', netId: 'load' },
            ],
        },
        {
            id: 'rl',
            type: 'resistor',
            designator: 'RLOAD',
            value: '9',
            pins: [
                { pinId: '1', netId: 'load' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
    ] as never,
    nets: [
        { id: 'sup', name: 'SUP' },
        { id: 'load', name: loadNetName },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
});

/**
 * The same shunt plus a DECOY: a second, unrelated branch whose mid-net has the id `sup-load`.
 *
 * The node comes from the net ID (not the name), so this is what puts a real, measured column at exactly
 * the token a flattened `v(SUP,LOAD)` produces. Nothing contrived about the circuit — a hyphenated net id
 * is ordinary — which is the point.
 */
const SHUNT_WITH_DECOY: CircuitJson = {
    version: '1.0',
    components: [
        ...(SHUNT('LOAD').components ?? []),
        {
            id: 'v2',
            type: 'voltage_source',
            designator: 'V2',
            value: '6',
            pins: [
                { pinId: '+', netId: 'aux' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'ra',
            type: 'resistor',
            designator: 'RA',
            value: '1k',
            pins: [
                { pinId: '1', netId: 'aux' },
                { pinId: '2', netId: 'sup-load' },
            ],
        },
        {
            id: 'rb',
            type: 'resistor',
            designator: 'RB',
            value: '1k',
            pins: [
                { pinId: '1', netId: 'sup-load' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
    ] as never,
    nets: [...(SHUNT('LOAD').nets ?? []), { id: 'aux', name: 'AUX' }, { id: 'sup-load', name: 'SUP-LOAD' }],
};

describe('a DIFFERENTIAL criterion', () => {
    it('is actually ASKED FOR — the deck contains the column, end to end', () => {
        // Review caught this: the key resolution was fixed and the column was never requested, so the
        // criterion still read "probe not found" on a working board. The default sweep probes single nodes;
        // a difference is a column of its own and has to be unioned in exactly like a branch current. A
        // correct key for a column nobody asked ngspice to write is half a fix that measures as a whole one.
        const circuit = SHUNT('LOAD');
        const criteria = [{ probe: 'v(SUP,LOAD)', metric: 'final', op: 'approx', value: 1 } as AcceptanceCriterion];

        const extra = extraProbesForCriteria(criteria);
        expect(extra).toEqual(['v(SUP,LOAD)']);

        // …and the generator turns that request into the emitted differential, both args resolved.
        const probes = extractProbes(generateNetlist(circuit, { type: 'op' }, { extraProbes: extra }));
        expect(probes).toContain('v(nsup,nload)');

        // The whole round trip, keyed off what the deck really wrote rather than off a hand-typed column.
        const measurements = probes.map((p) => meas(p, { flat: p === 'v(nsup,nload)' ? 1 : p === 'v(nsup)' ? 10 : 9 }));
        const verdict = evaluateAssertions(measurements, criteria, true, circuit)[0]!;
        expect({ actual: verdict.actual, pass: verdict.pass }).toEqual({ actual: 1, pass: true });
    });

    it('BINDS to the differential the deck emitted', () => {
        // The generator maps each side of the comma independently and emits v(nsup,nload). The evaluator
        // used to capture the whole inner string and sanitise it as one token — "sup,load" → "nsup_load" —
        // which no emitted probe can ever equal. Real ngspice measured the 1.000 V correctly and the
        // criterion still reported it as unfound.
        const circuit = SHUNT('LOAD');
        const measurements = [
            meas('v(nsup)', { flat: 10 }),
            meas('v(nload)', { flat: 9 }),
            meas('v(nsup,nload)', { flat: 1 }),
        ];
        const verdict = evaluate(
            measurements,
            { probe: 'v(SUP,LOAD)', metric: 'final', op: 'approx', value: 1 },
            circuit,
        );
        expect({ actual: verdict.actual, pass: verdict.pass }).toEqual({ actual: 1, pass: true });
    });

    it('does NOT collide with an unrelated net that flattens to the same token', () => {
        // The dangerous one, and the only case in this file that produces a wrong ANSWER rather than a
        // missing one. The sanitiser collapses every non-word character to "_", so after flattening a comma
        // and a hyphen are the same character: "sup,load" and "sup-load" both become "nsup_load". A board
        // with a net called SUP-LOAD is completely ordinary — hyphens in net names are everywhere.
        //
        // So a differential criterion across the shunt lands, with full confidence, on a DIFFERENT net's
        // single-ended voltage. Here that is 3 V against a true differential of 1 V. Written as
        // `approx 3` it would report PASS on a board drawing three times the current it was asked to.
        expect(sanitizeNodeName('sup,load')).toBe(sanitizeNodeName('sup-load')); // the collision, measured

        const circuit = SHUNT_WITH_DECOY;
        const measurements = [
            meas('v(nsup)', { flat: 10 }),
            meas('v(nload)', { flat: 9 }),
            meas('v(nsup_load)', { flat: 3 }), // the DECOY: an unrelated net whose id is "sup-load"
            meas('v(nsup,nload)', { flat: 1 }), // the real differential
        ];

        const verdict = evaluate(
            measurements,
            { probe: 'v(SUP,LOAD)', metric: 'final', op: 'approx', value: 1 },
            circuit,
        );
        expect({ actual: verdict.actual, pass: verdict.pass }).toEqual({ actual: 1, pass: true });

        // And stated the other way round, because this is the shape that ships a wrong verdict rather than
        // an obviously missing one: asking for the decoy's value must NOT pass.
        const wrong = evaluate(
            measurements,
            { probe: 'v(SUP,LOAD)', metric: 'final', op: 'approx', value: 3 },
            circuit,
        );
        expect(wrong.pass).toBe(false);
    });
});

// ---------------------------------------------------------------------------------------------------
// 4. The two maps must not be two maps.
// ---------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------
// 4. The ways this fix itself went wrong, found by attacking it. Each of these SHIPPED a wrong verdict.
// ---------------------------------------------------------------------------------------------------

describe('the failure modes the fix introduced on its first attempt', () => {
    it('does NOT answer a ground-FIRST differential as zero', () => {
        // The worst defect the review found, and worse than the bugs being fixed: `v(gnd,out)` is −v(out),
        // a real quantity that is NOT zero. The first version conflated two different reasons a probe can
        // rewrite to nothing — "it named ground alone" and "it was dropped because the sign would be
        // flipped" — and answered 0 with pass=true on a divider genuinely sitting at −2.5 V.
        //
        // The code being replaced keyed this as an invented node and reported "probe not found": a worse
        // answer that was at least fail-SAFE. A wrong pass is not.
        const circuit = DIVIDER('GND');
        const measurements = [meas('v(nvin)', { flat: 5 }), meas('v(x_out)', { flat: 2.5 })];

        for (const probe of ['v(GND,OUT)', 'v(0,out)', 'v(gnd,vin)']) {
            const verdict = evaluate(measurements, { probe, metric: 'final', op: 'approx', value: 0 }, circuit);
            expect({ probe, actual: verdict.actual, pass: verdict.pass }).toEqual({
                probe,
                actual: null,
                pass: false,
            });
        }
        // …and says how to ask for it unambiguously, rather than just refusing.
        const verdict = evaluate(measurements, { probe: 'v(GND,OUT)', metric: 'final', op: 'lt', value: 1 }, circuit);
        expect(verdict.detail).toMatch(/other way round/);
    });

    it('does NOT answer ground when the simulation produced no measurements at all', () => {
        // Ground is answered without reading a column, so nothing about it depends on the run having
        // worked — which is exactly how a Monte-Carlo batch whose every variant returned nothing reported
        // 10/10 passing, i.e. a 100% robustness verdict manufactured out of an empty result set. A verdict
        // that survives its own evidence disappearing is the worst thing this file can produce.
        const verdict = evaluate([], { probe: 'v(GND)', metric: 'final', op: 'approx', value: 0 }, DIVIDER('GND'));
        expect({ actual: verdict.actual, pass: verdict.pass }).toEqual({ actual: null, pass: false });
    });

    it('reports the ground distance SIGNED, like every other path', () => {
        // `distance` is documented as `actual − target` and the AI fix loop reads its SIGN to know which way
        // to move. An absolute value here would tell it a target of 5 was missed by +5 when it is −5.
        const verdict = evaluate(
            [meas('v(nvin)', { flat: 5 })],
            { probe: 'v(GND)', metric: 'final', op: 'approx', value: 5 },
            DIVIDER('GND'),
        );
        expect({ actual: verdict.actual, distance: verdict.distance, pass: verdict.pass }).toEqual({
            actual: 0,
            distance: -5,
            pass: false,
        });
    });

    it('binds a net whose emitted node is ITSELF a reserved word', () => {
        // SYMMETRY, not idempotence. The first version sanitised only the tokens the map could not resolve,
        // reasoning that a resolved token is already an emitted node. But the MEASURED side sanitises
        // unconditionally, so the two sides have to do the same thing to the same value — and there is
        // exactly one value where that matters: a net whose id is `one` emits node `none`, which is itself
        // reserved, so the measured column keys as `x_none` while the criterion stopped at `none`. The net
        // WAS measured and the criterion could not reach it.
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                {
                    id: 'v1',
                    type: 'voltage_source',
                    designator: 'V1',
                    value: '5',
                    pins: [
                        { pinId: '+', netId: 'one' },
                        { pinId: '-', netId: 'gnd' },
                    ],
                },
                {
                    id: 'r1',
                    type: 'resistor',
                    designator: 'R1',
                    value: '1k',
                    pins: [
                        { pinId: '1', netId: 'one' },
                        { pinId: '2', netId: 'gnd' },
                    ],
                },
            ] as never,
            nets: [
                { id: 'one', name: 'ONE' },
                { id: 'gnd', name: 'GND', isGround: true },
            ],
        };
        expect(extractProbes(generateNetlist(circuit, { type: 'op' }))).toEqual(['v(none)']);

        const verdict = evaluate(
            [meas('v(none)', { flat: 5 })],
            { probe: 'v(one)', metric: 'final', op: 'approx', value: 5 },
            circuit,
        );
        expect({ actual: verdict.actual, pass: verdict.pass }).toEqual({ actual: 5, pass: true });
    });

    it('does not treat a net whose id is literally 0 as the ground reference', () => {
        // `0` is SPICE's name for the reference, so every way of naming ground maps to it — but a net whose
        // id happens to BE `0` is an ordinary node carrying an ordinary voltage, emitted as `n0`. Answering
        // a criterion on it with the constant 0 would replace a real measurement with a definition.
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                {
                    id: 'v1',
                    type: 'voltage_source',
                    designator: 'V1',
                    value: '5',
                    pins: [
                        { pinId: '+', netId: '0' },
                        { pinId: '-', netId: 'gnd' },
                    ],
                },
                {
                    id: 'r1',
                    type: 'resistor',
                    designator: 'R1',
                    value: '1k',
                    pins: [
                        { pinId: '1', netId: '0' },
                        { pinId: '2', netId: 'gnd' },
                    ],
                },
            ] as never,
            nets: [
                { id: '0', name: 'RAIL' },
                { id: 'gnd', name: 'GND', isGround: true },
            ],
        };
        expect(extractProbes(generateNetlist(circuit, { type: 'op' }))).toEqual(['v(n0)']);

        const verdict = evaluate(
            [meas('v(n0)', { flat: 5 })],
            { probe: 'v(0)', metric: 'final', op: 'approx', value: 5 },
            circuit,
        );
        expect({ actual: verdict.actual, pass: verdict.pass }).toEqual({ actual: 5, pass: true });
    });

    it('binds a net whose id CONTAINS a comma, instead of reading it as a differential', () => {
        // A comma is legal in a net id, and `v(a,b)` is then genuinely ambiguous. Splitting first made the
        // map's own `a,b` key unreachable and broke a criterion that used to work. An exact match on what
        // the circuit actually contains is the better of the two readings.
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                {
                    id: 'v1',
                    type: 'voltage_source',
                    designator: 'V1',
                    value: '5',
                    pins: [
                        { pinId: '+', netId: 'a,b' },
                        { pinId: '-', netId: 'gnd' },
                    ],
                },
                {
                    id: 'r1',
                    type: 'resistor',
                    designator: 'R1',
                    value: '1k',
                    pins: [
                        { pinId: '1', netId: 'a,b' },
                        { pinId: '2', netId: 'gnd' },
                    ],
                },
            ] as never,
            nets: [
                { id: 'a,b', name: 'AB' },
                { id: 'gnd', name: 'GND', isGround: true },
            ],
        };
        expect(extractProbes(generateNetlist(circuit, { type: 'op' }))).toEqual(['v(na_b)']);

        const verdict = evaluate(
            [meas('v(na_b)', { flat: 5 })],
            { probe: 'v(a,b)', metric: 'final', op: 'approx', value: 5 },
            circuit,
        );
        expect({ actual: verdict.actual, pass: verdict.pass }).toEqual({ actual: 5, pass: true });
    });
});

describe('what each caller shape can and cannot resolve', () => {
    // `evaluateAssertions` is published API and its fourth argument used to be a bare `nets` array. That
    // shape is still honoured rather than broken, and these two tests pin exactly how far it gets — so the
    // limit is a stated property with a test on it, not something a caller discovers as a wrong verdict.

    it('the legacy nets-array shape resolves ground and differentials', () => {
        const circuit = DIVIDER('GND');
        const verdict = evaluateAssertions(
            [meas('v(nvin)', { flat: 5 })],
            [{ probe: 'v(GND)', metric: 'final', op: 'approx', value: 0 }],
            true,
            circuit.nets, // the old shape
        )[0]!;
        expect(verdict.actual).toBe(0);
    });

    it('…but CANNOT resolve a digital net, because the twin is derived from the COMPONENTS', () => {
        // Not a defect in the shape — a fact about it. A net list says nothing about which nets are driven
        // by a logic gate, and that is what decides whether a net is sampled directly or through a bridge.
        // Pinned so nobody "fixes" the caller shape and believes digital came along with it.
        const measurements = [meas('v(na)', { min: 0, max: 5 }), meas('v(ny_p)', { min: 0, max: 5, final: 5 })];
        const criterion: AcceptanceCriterion = { probe: 'v(y)', metric: 'max', op: 'gte', value: 4 };

        const withNets = evaluateAssertions(measurements, [criterion], true, INVERTER.nets)[0]!;
        expect(withNets.actual).toBeNull();

        const withCircuit = evaluateAssertions(measurements, [criterion], true, INVERTER)[0]!;
        expect(withCircuit.actual).toBe(5);
    });

    it('a prebuilt resolver behaves identically to the circuit it came from', () => {
        // The shape a loop uses — Monte-Carlo, corners, a sweep — where rebuilding per variant would plan
        // the digital bridge a hundred times for one answer. It must not be a different answer.
        const measurements = [meas('v(na)', { min: 0, max: 5 }), meas('v(ny_p)', { min: 0, max: 5, final: 5 })];
        const criterion: AcceptanceCriterion = { probe: 'v(y)', metric: 'max', op: 'gte', value: 4 };
        const viaResolver = evaluateAssertions(measurements, [criterion], true, buildProbeResolver(INVERTER))[0]!;
        const viaCircuit = evaluateAssertions(measurements, [criterion], true, INVERTER)[0]!;
        expect(viaResolver).toEqual(viaCircuit);
    });
});

describe('the criterion resolver and the netlist generator are ONE authority', () => {
    it('resolves every net reference to the node the generator actually emitted', () => {
        // The property that makes the three cases above impossible as a class rather than fixed one at a
        // time. Whatever a reference resolves to must be a probe the deck really contains — otherwise a
        // fourth divergence is waiting for whatever the generator learns to do next.
        for (const [circuit, analysis] of [
            [DIVIDER('GND'), { type: 'op' }],
            [INVERTER, { type: 'tran', stopTime: '4u', stepTime: '10n' }],
            [SHUNT('LOAD'), { type: 'op' }],
        ] as Array<[CircuitJson, never]>) {
            const emitted = new Set(extractProbes(generateNetlist(circuit, analysis)).map((p) => nodeKey(p)));
            const resolver = buildProbeResolver(circuit);

            for (const net of circuit.nets) {
                if (net.isGround) continue; // deliberately not emitted — covered above, and answered as 0
                for (const ref of [net.id, net.name!]) {
                    const key = nodeKey(`v(${ref})`, resolver);
                    expect({ ref, key, emitted: [...emitted] }).toEqual({
                        ref,
                        key,
                        emitted: expect.arrayContaining([key]),
                    });
                }
            }
        }
    });
});
