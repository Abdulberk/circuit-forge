/**
 * Deck ↔ schematic coverage.
 *
 * The bug this closes: a circuit whose op-amp is a catalog-only `generic` part passes ERC, generates a
 * valid deck WITHOUT the op-amp, simulates cleanly, and returns a flat waveform. Nothing in the result
 * distinguished that from a circuit that is genuinely at steady state.
 *
 * So these tests assert the DISCRIMINATION, not merely that a function returns something: a part whose
 * absence the deck cannot feel must not raise an alarm, and a part whose absence guts the result must.
 */
import { simulationCoverage, describeCoverage } from '../src/netlist/coverage';
import { generateNetlist } from '../src/netlist/generator';
import { runErc } from '../src/erc/checker';
import type { CircuitJson } from '../src/types/circuit';

const circuit = (components: CircuitJson['components'], nets: CircuitJson['nets'] = []): CircuitJson =>
    ({ version: '1.0', components, nets }) as CircuitJson;

const pin = (pinId: string, netId: string) => ({ pinId, netId });

describe('simulationCoverage', () => {
    it('an all-simulatable circuit is complete and has nothing to disclose', () => {
        const c = circuit([
            { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [pin('+', 'vcc'), pin('-', 'gnd')] },
            { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [pin('1', 'vcc'), pin('2', 'gnd')] },
        ] as CircuitJson['components']);

        const cov = simulationCoverage(c);
        expect(cov.omitted).toEqual([]);
        expect(cov.complete).toBe(true);
        expect(describeCoverage(cov)).toBeNull();
    });

    it('ground is NOT an omission — it is node 0, a full representation rather than a missing device', () => {
        const c = circuit([
            { id: 'g1', type: 'ground', designator: 'GND1', pins: [pin('1', 'gnd')] },
            { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [pin('1', 'vcc'), pin('2', 'gnd')] },
        ] as CircuitJson['components']);

        expect(simulationCoverage(c).omitted).toEqual([]);
        expect(simulationCoverage(c).complete).toBe(true);
    });

    it('a generic part bridging two simulated nets is LOAD-BEARING — the deck has an open where it belongs', () => {
        // R1 —[IN]— U1 —[OUT]— R2 : removing U1 disconnects the two halves.
        const c = circuit([
            { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [pin('1', 'vcc'), pin('2', 'in')] },
            { id: 'u1', type: 'generic', designator: 'U1', pins: [pin('1', 'in'), pin('2', 'out')] },
            { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', pins: [pin('1', 'out'), pin('2', 'gnd')] },
        ] as CircuitJson['components']);

        const cov = simulationCoverage(c);
        expect(cov.loadBearing.map((o) => o.designator)).toEqual(['U1']);
        expect(cov.complete).toBe(false);
        expect(describeCoverage(cov)).toContain('does NOT contain U1 (generic)');
    });

    it('a generic part on ONE net is disclosed but not load-bearing — a test point costs the result nothing', () => {
        const c = circuit([
            { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [pin('1', 'vcc'), pin('2', 'gnd')] },
            { id: 'tp1', type: 'generic', designator: 'TP1', pins: [pin('1', 'vcc')] },
        ] as CircuitJson['components']);

        const cov = simulationCoverage(c);
        expect(cov.omitted.map((o) => o.designator)).toEqual(['TP1']);
        expect(cov.loadBearing).toEqual([]);
        expect(cov.complete).toBe(true);
        expect(describeCoverage(cov)).toContain('does not bridge simulated nets');
    });

    it('a generic part on nets NO simulated device touches is not load-bearing — those nets are not in the deck at all', () => {
        // A two-pin connector wired only to another connector: nothing simulated can observe the gap.
        const c = circuit([
            { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [pin('1', 'vcc'), pin('2', 'gnd')] },
            { id: 'j1', type: 'generic', designator: 'J1', pins: [pin('1', 'aux_a'), pin('2', 'aux_b')] },
            { id: 'j2', type: 'generic', designator: 'J2', pins: [pin('1', 'aux_a'), pin('2', 'aux_b')] },
        ] as CircuitJson['components']);

        const cov = simulationCoverage(c);
        expect(cov.omitted.map((o) => o.designator).sort()).toEqual(['J1', 'J2']);
        expect(cov.loadBearing).toEqual([]);
        expect(cov.complete).toBe(true);
    });

    it('multiple pins on the SAME net do not count as bridging — an 8-pin connector all on GND is not an open', () => {
        const c = circuit([
            { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [pin('1', 'vcc'), pin('2', 'gnd')] },
            {
                id: 'j1',
                type: 'generic',
                designator: 'J1',
                pins: [pin('1', 'gnd'), pin('2', 'gnd'), pin('3', 'gnd'), pin('4', 'gnd')],
            },
        ] as CircuitJson['components']);

        const cov = simulationCoverage(c);
        expect(cov.omitted[0]!.netIds).toEqual(['gnd']); // deduplicated
        expect(cov.loadBearing).toEqual([]);
    });

    it('reports EVERY omitted part, so a reader knows which designators to distrust', () => {
        const c = circuit([
            { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [pin('1', 'a'), pin('2', 'b')] },
            { id: 'u1', type: 'generic', designator: 'U1', pins: [pin('1', 'a'), pin('2', 'b')] },
            { id: 'u2', type: 'generic', designator: 'U2', pins: [pin('1', 'b'), pin('2', 'a')] },
        ] as CircuitJson['components']);

        const detail = describeCoverage(simulationCoverage(c))!;
        expect(detail).toContain('U1');
        expect(detail).toContain('U2');
    });
});

describe('the gap this closes, end to end', () => {
    // An inverting amplifier whose op-amp is a catalog part. This is the shape that shipped a lie.
    const opampAmp = circuit([
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 0.2 1k)', pins: [pin('+', 'in'), pin('-', 'gnd')] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '10k', pins: [pin('1', 'in'), pin('2', 'inm')] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '100k', pins: [pin('1', 'inm'), pin('2', 'out')] },
        { id: 'u1', type: 'generic', designator: 'U1', pins: [pin('1', 'inm'), pin('2', 'gnd'), pin('3', 'out'), pin('4', 'vcc')] },
        { id: 'v2', type: 'voltage_source', designator: 'V2', value: 'DC 9', pins: [pin('+', 'vcc'), pin('-', 'gnd')] },
        { id: 'g1', type: 'ground', designator: 'GND1', pins: [pin('1', 'gnd')] },
    ] as CircuitJson['components'],
        [
            { id: 'in', name: 'IN' },
            { id: 'inm', name: 'INM' },
            { id: 'out', name: 'OUT' },
            { id: 'vcc', name: 'VCC' },
            { id: 'gnd', name: 'GND' },
        ] as CircuitJson['nets']);

    it('ERC passes and a deck generates — the two gates that were supposed to catch this cannot', () => {
        const erc = runErc(opampAmp);
        expect(erc.summary.errors).toBe(0);
        expect(erc.passed).toBe(true);

        const deck = generateNetlist(opampAmp, { type: 'tran', stopTime: '5m', stepTime: '5u' });
        expect(deck).toContain('R1');
        expect(deck).not.toMatch(/^\s*\w*U1\b/m); // the op-amp is simply not there
    });

    it('coverage is the only thing that can say so', () => {
        const cov = simulationCoverage(opampAmp);
        expect(cov.complete).toBe(false);
        expect(cov.loadBearing.map((o) => o.designator)).toEqual(['U1']);
        expect(describeCoverage(cov)).toContain('do not describe the schematic as drawn');
    });
});
