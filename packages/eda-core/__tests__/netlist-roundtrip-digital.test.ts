/**
 * Digital / XSPICE round-trip (Faz A #2). The generator emits logic as XSPICE 'a'-devices plus SYNTHESIZED
 * analog<->digital bridges (adc/dac), a constant LOW rail, and split mixed-net nodes (`<net>_d`/`_p`). Before
 * this fix the parser produced "Could not parse" for every 'A' line, so a generated digital circuit could not
 * be re-imported at all. The parser now maps each 'A' device back to its ComponentType via its CFD_* model,
 * uses the bridges to RE-MERGE split nets, drops auto-tied set/rst on the LOW rail, and skips the synthesized
 * bridge/rail devices + models (all regenerated on export). Pure generate/parse — no mocks.
 */
import { generateNetlist } from '../src/netlist/generator';
import { parseNetlist } from '../src/parser/netlist-parser';
import type { TranAnalysis } from '../src/types/analysis';
import type { CircuitJson } from '../src/types/circuit';

const TRAN: TranAnalysis = { type: 'tran', stopTime: '2m', stepTime: '5u' };
const rt = (c: CircuitJson) => parseNetlist(generateNetlist(c, TRAN)).circuit;

const AND_GATE: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'va', type: 'voltage_source', designator: 'VA', value: 'PULSE(0 5 0 1n 1n 1m 2m)', pins: [{ pinId: '+', netId: 'a' }, { pinId: '-', netId: '0' }] },
        { id: 'vb', type: 'voltage_source', designator: 'VB', value: 'PULSE(0 5 0 1n 1n 0.5m 1m)', pins: [{ pinId: '+', netId: 'b' }, { pinId: '-', netId: '0' }] },
        { id: 'u1', type: 'logic_and', designator: 'U1', pins: [{ pinId: 'in1', netId: 'a' }, { pinId: 'in2', netId: 'b' }, { pinId: 'out', netId: 'y' }] },
    ],
    nets: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'y', name: 'y' }, { id: '0', name: '0', isGround: true }],
};

const DFF: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'vclk', type: 'voltage_source', designator: 'VCLK', value: 'PULSE(0 5 0 1n 1n 0.5m 1m)', pins: [{ pinId: '+', netId: 'clk' }, { pinId: '-', netId: '0' }] },
        { id: 'vd', type: 'voltage_source', designator: 'VD', value: 'PULSE(0 5 0 1n 1n 1.5m 3m)', pins: [{ pinId: '+', netId: 'd' }, { pinId: '-', netId: '0' }] },
        { id: 'u1', type: 'dff', designator: 'U1', pins: [{ pinId: 'd', netId: 'd' }, { pinId: 'clk', netId: 'clk' }, { pinId: 'q', netId: 'q' }, { pinId: 'qb', netId: 'qb' }] },
    ],
    nets: [{ id: 'clk', name: 'clk' }, { id: 'd', name: 'd' }, { id: 'q', name: 'q' }, { id: 'qb', name: 'qb' }, { id: '0', name: '0', isGround: true }],
};

const pinNet = (c: { pins: { pinId: string; netId: string }[] }, pinId: string) => c.pins.find((p) => p.pinId === pinId)?.netId;

describe('digital round-trip — gates re-import with re-merged mixed nets (Faz A #2)', () => {
    it('a 2-input AND gate round-trips back to logic_and with inputs/output on the same nets as the sources', () => {
        const c = rt(AND_GATE);
        const u = c.components.find((x) => x.type === 'logic_and');
        expect(u).toBeDefined();
        // Inputs were emitted on split digital nodes (na_d/nb_d) and re-merged via the bridges to na/nb —
        // the SAME nodes the PULSE sources drive. (Net ids are the sanitized 'a'->'na', 'b'->'nb', 'y'->'ny'.)
        const va = c.components.find((x) => x.designator === 'VA')!;
        const vb = c.components.find((x) => x.designator === 'VB')!;
        expect(pinNet(u!, 'in1')).toBe(pinNet(va, '+'));
        expect(pinNet(u!, 'in2')).toBe(pinNet(vb, '+'));
        expect(pinNet(u!, 'out')).toBe('ny');
    });

    it('does NOT import the synthesized bridges (adc/dac), the LOW rail source, or the CFD_* models', () => {
        const c = rt(AND_GATE);
        // No synthesized analog<->digital bridge or rail device leaked in as a component.
        expect(c.components.some((x) => /^a?xsyn/i.test(x.designator) || /^vxsyn/i.test(x.designator))).toBe(false);
        // Real components only: VA, VB, the gate, and the ground. No extra synthesized voltage source.
        expect(c.components.filter((x) => x.type === 'voltage_source').map((x) => x.designator).sort()).toEqual(['VA', 'VB']);
        // The engine-synthesized CFD_* digital/bridge models are regenerated on export, not carried back.
        expect((c.models ?? []).some((m) => /^cfd_/i.test(m.name))).toBe(false);
    });
});

describe('digital round-trip — a D flip-flop re-imports and drops the auto-tied set/rst', () => {
    it('round-trips to a dff with d/clk/q/qb on the right nets and NO set/rst (they were tied to the LOW rail)', () => {
        const c = rt(DFF);
        const u = c.components.find((x) => x.type === 'dff');
        expect(u).toBeDefined();
        const vclk = c.components.find((x) => x.designator === 'VCLK')!;
        const vd = c.components.find((x) => x.designator === 'VD')!;
        expect(pinNet(u!, 'd')).toBe(pinNet(vd, '+')); // nd
        expect(pinNet(u!, 'clk')).toBe(pinNet(vclk, '+')); // nclk
        expect(pinNet(u!, 'q')).toBe('nq');
        expect(pinNet(u!, 'qb')).toBe('nqb');
        // set/rst were absent in the authored circuit (auto-tied to dlogic_lo on emit) — dropped on import,
        // not imported as pins onto the synthesized rail net.
        expect(pinNet(u!, 'set')).toBeUndefined();
        expect(pinNet(u!, 'rst')).toBeUndefined();
        // The synthesized LOW-rail voltage source (vxsyn*) is not imported.
        expect(c.components.some((x) => /^vxsyn/i.test(x.designator))).toBe(false);
    });
});
