import { validatePowerRails, driversOf, runSupplyCorner, type SupplyCornerSpec } from '../src/supply-corner';
import type { CircuitJson } from '../src/types/circuit';
import type { SimMeasurement } from '../src/analysis/measurements';
import type { AcceptanceCriterion } from '../src/analysis/assertions';

const meas = (node: string, value: number): SimMeasurement => ({
    node, min: value, max: value, final: value, pp: 0, avg: value, rms: Math.abs(value),
    raw: { min: value, max: value, final: value, pp: 0, avg: value, rms: Math.abs(value) },
});

/** A directly-source-driven rail with ONE consumer. V1 → rail (isPower) → RL → gnd. */
const directRail = (extra: CircuitJson['components'] = [], railNet: Partial<CircuitJson['nets'][number]> = {}): CircuitJson => ({
    version: '1.0',
    components: [
        { id: 'V1', type: 'voltage_source', designator: 'V1', value: 'DC 12', pins: [{ pinId: '+', netId: 'rail' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'RL', type: 'resistor', designator: 'RL', value: '1k', pins: [{ pinId: '1', netId: 'rail' }, { pinId: '2', netId: 'gnd' }] },
        ...extra,
    ],
    nets: [{ id: 'rail', name: 'rail', isPower: true, ...railNet }, { id: 'gnd', name: 'gnd', isGround: true }],
} as unknown as CircuitJson);

describe('driversOf', () => {
    it('finds the DC power source that drives a net, ignoring a pure-signal (DC 0) source', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'VSIG', type: 'voltage_source', designator: 'VSIG', value: 'DC 0 AC 1', pins: [{ pinId: '+', netId: 'sig' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'RS', type: 'resistor', designator: 'RS', value: '1k', pins: [{ pinId: '1', netId: 'sig' }, { pinId: '2', netId: 'rail' }] },
                { id: 'V1', type: 'voltage_source', designator: 'V1', value: 'DC 12', pins: [{ pinId: '+', netId: 'rail' }, { pinId: '-', netId: 'gnd' }] },
            ],
            nets: [{ id: 'sig', name: 'sig' }, { id: 'rail', name: 'rail' }, { id: 'gnd', name: 'gnd', isGround: true }],
        } as unknown as CircuitJson;
        const d = driversOf(c, 'rail').map((x) => x.designator);
        expect(d).toEqual(['V1']); // VSIG (DC 0) is not a power driver even though it is topologically reachable
    });

    it('treats a BARE-number source value ("5") as a DC driver (SPICE default), not a false-defer', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'V1', type: 'voltage_source', designator: 'V1', value: '5', pins: [{ pinId: '+', netId: 'rail' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'RL', type: 'resistor', designator: 'RL', value: '1k', pins: [{ pinId: '1', netId: 'rail' }, { pinId: '2', netId: 'gnd' }] },
            ],
            nets: [{ id: 'rail', name: 'rail' }, { id: 'gnd', name: 'gnd', isGround: true }],
        } as unknown as CircuitJson;
        expect(driversOf(c, 'rail').map((x) => x.designator)).toEqual(['V1']);
    });
});

describe('validatePowerRails — refutation asymmetry (evidence-absent trusts, only evidence-contrary defers)', () => {
    it('TRUSTS a rail driven by one DC source EVEN WITH A SINGLE CONSUMER (absence of corroboration != contradiction)', () => {
        // The critical guardrail: a single-IC LDO/rail must NOT be rejected for "only 1 consumer".
        const r = validatePowerRails(directRail());
        expect(r).toHaveLength(1);
        expect(r[0]!.status).toBe('trusted');
        expect(r[0]!.driverDesignator).toBe('V1');
    });

    it('DEFERS a net marked isPower that is ALSO ground (contradictory)', () => {
        const c = directRail([], { isGround: true });
        const r = validatePowerRails(c);
        expect(r[0]!.status).toBe('deferred');
        expect(r[0]!.reason).toMatch(/isGround|contradict/i);
    });

    it('DEFERS a net marked isPower that NO DC source drives (a signal/reference net, wrongly marked)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'VSIG', type: 'voltage_source', designator: 'VSIG', value: 'DC 0 AC 1', pins: [{ pinId: '+', netId: 'sig' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'RS', type: 'resistor', designator: 'RS', value: '1k', pins: [{ pinId: '1', netId: 'sig' }, { pinId: '2', netId: 'gnd' }] },
            ],
            nets: [{ id: 'sig', name: 'sig', isPower: true }, { id: 'gnd', name: 'gnd', isGround: true }],
        } as unknown as CircuitJson;
        const r = validatePowerRails(c);
        expect(r[0]!.status).toBe('deferred');
        expect(r[0]!.reason).toMatch(/no DC power source|not power-driven/i);
    });

    it('DEFERS an ambiguous rail driven by TWO candidate sources (cannot pick THE supply)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'V1', type: 'voltage_source', designator: 'V1', value: 'DC 12', pins: [{ pinId: '+', netId: 'a' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'R1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'a' }, { pinId: '2', netId: 'mid' }] },
                { id: 'V2', type: 'voltage_source', designator: 'V2', value: 'DC 5', pins: [{ pinId: '+', netId: 'b' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'R2', type: 'resistor', designator: 'R2', value: '1k', pins: [{ pinId: '1', netId: 'b' }, { pinId: '2', netId: 'mid' }] },
            ],
            nets: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'mid', name: 'mid', isPower: true }, { id: 'gnd', name: 'gnd', isGround: true }],
        } as unknown as CircuitJson;
        const r = validatePowerRails(c);
        expect(r[0]!.status).toBe('deferred');
        expect(r[0]!.reason).toMatch(/ambiguous/i);
    });

    it('returns nothing when no net is marked isPower', () => {
        const c: CircuitJson = { version: '1.0', components: [], nets: [{ id: 'gnd', name: 'gnd', isGround: true }] } as unknown as CircuitJson;
        expect(validatePowerRails(c)).toHaveLength(0);
    });
});

/** Fake runner: the rail voltage == the (perturbed) DC value of V1 — a direct-source rail, so a ±5% supply
 *  sweep moves the rail ±5%. Reads the perturbed source out of the variant the orchestrator built. */
const railFollowsSource: (variant: CircuitJson) => Promise<SimMeasurement[] | null> = async (variant) => {
    const v1 = variant.components.find((c) => c.designator === 'V1');
    const m = /DC\s+([\d.]+)/.exec(v1?.value ?? '');
    return [meas('rail', m ? Number.parseFloat(m[1]!) : 0)];
};
const SPEC: SupplyCornerSpec = { tolerance: 0.05, rangeLabel: '±5%' };

describe('runSupplyCorner', () => {
    it('not-applicable with rails:[] when NO power rail is marked (the freeze-era "no data yet" case)', async () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [{ id: 'V1', type: 'voltage_source', designator: 'V1', value: 'DC 12', pins: [{ pinId: '+', netId: 'rail' }, { pinId: '-', netId: 'gnd' }] }],
            nets: [{ id: 'rail', name: 'rail' }, { id: 'gnd', name: 'gnd', isGround: true }], // rail NOT marked isPower
        } as unknown as CircuitJson;
        const r = await runSupplyCorner(c, [], SPEC, railFollowsSource);
        expect(r.applicable).toBe(false);
        expect(r.rails).toHaveLength(0); // caller distinguishes this ("no rail marked") from a deferred rail
    });

    it('not-applicable but rails carries the DEFERRED reason when the marked rail could not be validated', async () => {
        const c = directRail([], { isGround: true }); // isPower + isGround → deferred
        const r = await runSupplyCorner(c, [], SPEC, railFollowsSource);
        expect(r.applicable).toBe(false);
        expect(r.rails[0]!.status).toBe('deferred'); // visible reason, not silently dropped
    });

    it('runs on a trusted rail (single consumer), reports ±5% drift vs the NOMINAL reference', async () => {
        const r = await runSupplyCorner(directRail(), [], SPEC, railFollowsSource);
        expect(r.applicable).toBe(true);
        expect(r.points.every((p) => p.outcome === 'no-limit')).toBe(true); // no criteria → drift-only
        const railDrift = r.drift.find((d) => d.node === 'rail');
        expect(railDrift).toBeDefined();
        expect(railDrift!.nominalValue).toBeCloseTo(12, 6); // reference = nominal run (source at 12), NOT a perturbed run
        expect(Math.abs(railDrift!.deltaPct)).toBeCloseTo(5, 1); // ±5% supply → 5% rail drift on a direct rail
    });

    it('pass/fail comes from the criteria; a spec violated at the low corner fails there (informational)', async () => {
        const crit: AcceptanceCriterion[] = [{ probe: 'rail', metric: 'final', op: 'gte', value: 11.5 }];
        const r = await runSupplyCorner(directRail(), crit, SPEC, railFollowsSource);
        expect(r.hasLimits).toBe(true);
        // hi corner (12.6) passes >= 11.5; lo corner (11.4) fails < 11.5
        expect(r.failed).toBeGreaterThan(0);
        expect(r.passAllCorners).toBe(false);
    });
});
