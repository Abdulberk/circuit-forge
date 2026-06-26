/**
 * SPICE round-trip tests — the contract `parse(generate(x))` must preserve what makes a deck SIMULATE:
 * topology, values, .model/.subckt bodies, .options, and .ic. Before the Faz-A round-trip fix the parser
 * silently dropped every .model/.subckt/.options/.ic card, so a re-exported deck referenced undefined
 * models and no longer simulated. These tests pin that fix WITHOUT mocks (pure generate/parse), plus an
 * idempotence fixed-point check on a model-free circuit.
 */
import { generateNetlist } from '../src/netlist/generator';
import { parseNetlist } from '../src/parser/netlist-parser';
import { sanitizeNodeName } from '../src/netlist/sanitizer';
import type { CircuitJson, ModelDef } from '../src/types/circuit';
import type { TranAnalysis, OpAnalysis } from '../src/types/analysis';

const roundTrip = (c: CircuitJson, a: Parameters<typeof generateNetlist>[1]) => parseNetlist(generateNetlist(c, a));

describe('SPICE round-trip — .model / .subckt survive (Faz A #1)', () => {
    it('captures an explicit .model card (BJT) back into circuit.models with the right device + body', () => {
        const bjtModel: ModelDef = { name: 'QN1', device: 'bjt', body: '.model QN1 NPN(BF=180 IS=1e-15 VAF=80)' };
        const circuit: CircuitJson = {
            version: '1.0',
            models: [bjtModel],
            components: [
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 10', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: '0' }] },
                { id: 'rc', type: 'resistor', designator: 'RC1', value: '2.2k', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'col' }] },
                { id: 'rb', type: 'resistor', designator: 'RB1', value: '220k', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'base' }] },
                { id: 'q1', type: 'bjt', designator: 'Q1', model: 'QN1', pins: [{ pinId: 'c', netId: 'col' }, { pinId: 'b', netId: 'base' }, { pinId: 'e', netId: '0' }] },
            ],
            nets: [{ id: 'vcc', name: 'vcc' }, { id: 'col', name: 'col' }, { id: 'base', name: 'base' }, { id: '0', name: '0', isGround: true }],
        };

        const parsed = roundTrip(circuit, { type: 'op' } as OpAnalysis);
        const models = parsed.circuit.models ?? [];
        const qn = models.find((m) => m.name === 'QN1');
        expect(qn).toBeDefined();
        expect(qn!.device).toBe('bjt');
        expect(qn!.body).toContain('NPN');
        expect(qn!.body).toContain('BF=180');
        // The Q1 device line still references the model name, so the re-export is self-consistent.
        expect(parsed.circuit.components.find((c) => c.designator === 'Q1')?.model).toBe('QN1');
    });

    it('captures a .subckt block (multi-line body + ports) back into circuit.models', () => {
        const opamp: ModelDef = {
            name: 'OPAMP1',
            device: 'subckt',
            body: '.subckt OPAMP1 out inp inn\nE1 out 0 inp inn 100k\n.ends',
            ports: ['out', 'inp', 'inn'],
        };
        const circuit: CircuitJson = {
            version: '1.0',
            models: [opamp],
            components: [
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 1', pins: [{ pinId: '+', netId: 'sig' }, { pinId: '-', netId: '0' }] },
                { id: 'x1', type: 'subckt', designator: 'X1', model: 'OPAMP1', pins: [{ pinId: 'out', netId: 'out' }, { pinId: 'inp', netId: 'sig' }, { pinId: 'inn', netId: '0' }] },
                { id: 'rl', type: 'resistor', designator: 'RL1', value: '10k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: '0' }] },
            ],
            nets: [{ id: 'sig', name: 'sig' }, { id: 'out', name: 'out' }, { id: '0', name: '0', isGround: true }],
        };

        const parsed = roundTrip(circuit, { type: 'op' } as OpAnalysis);
        const sub = (parsed.circuit.models ?? []).find((m) => m.name === 'OPAMP1');
        expect(sub).toBeDefined();
        expect(sub!.device).toBe('subckt');
        expect(sub!.body).toMatch(/^\.subckt OPAMP1 out inp inn/i);
        expect(sub!.body).toContain('E1 out 0 inp inn 100k');
        expect(sub!.body).toMatch(/\.ends/i);
        // ports are deliberately NOT recovered (audit #4): the instance is reconstructed with POSITIONAL
        // pinIds, so recovering named ports would make the generator demand named pins → 'missing pin' on
        // re-export. Undefined ports keeps the positional binding, which re-exports cleanly.
        expect(sub!.ports).toBeUndefined();
        // the macromodel + its instance re-export WITHOUT throwing (the bug the fix addresses) + still wires X1.
        expect(() => generateNetlist(parsed.circuit, { type: 'op' } as OpAnalysis)).not.toThrow();
        expect(generateNetlist(parsed.circuit, { type: 'op' } as OpAnalysis)).toMatch(/^X1\s+\S+\s+\S+\s+\S+\s+OPAMP1/im);
    });
});

describe('SPICE round-trip — .control output block is NOT parsed as components (audit #1)', () => {
    it('consumes a .control … .endc block instead of injecting phantom devices', () => {
        const deck = [
            '* My amp', 'V1 in 0 DC 5', 'R1 in out 1k', 'R2 out 0 2k',
            '.control', '  set filetype=ascii', '  tran 1u 1m', '  dc V1 0 5 0.1',
            '  let ratio = v(out)/v(in)', '  wrdata output.csv v(out)', '.endc', '.end',
        ].join('\n');
        const parsed = parseNetlist(deck);
        // ONLY the real devices — no phantom tline/diode/inductor from tran/dc/let in the control body.
        expect(parsed.circuit.components.map((c) => c.designator).sort()).toEqual(['GND1', 'R1', 'R2', 'V1']);
        const types = parsed.circuit.components.map((c) => c.type);
        expect(types).not.toContain('tline');
        expect(types).not.toContain('diode');
        expect(types).not.toContain('inductor');
        // no phantom nets (the control body's tokens must not enter the net list)
        const netIds = parsed.circuit.nets.map((n) => n.id);
        for (const phantom of ['1u', '1m', 'ratio', '=']) expect(netIds).not.toContain(phantom);
        // an analysis stated INSIDE the control block is recovered (not lost)
        expect(parsed.analysis).toBeTruthy();
    });
});

describe('SPICE round-trip — .options / .ic survive', () => {
    it('round-trips solver .options onto the analysis', () => {
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'a' }, { pinId: '-', netId: '0' }] },
                { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'a' }, { pinId: '2', netId: '0' }] },
            ],
            nets: [{ id: 'a', name: 'a' }, { id: '0', name: '0', isGround: true }],
        };
        const analysis: TranAnalysis = { type: 'tran', stopTime: '1m', stepTime: '1u', options: { reltol: '0.01', gmin: '1e-9', method: 'gear', itl4: 20 } };
        const parsed = roundTrip(circuit, analysis);
        expect(parsed.analysis?.options).toEqual({ reltol: '0.01', gmin: '1e-9', method: 'gear', itl4: 20 });
    });

    it('round-trips .ic initial conditions onto a tran analysis (keyed by the emitted node)', () => {
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'a' }, { pinId: '-', netId: '0' }] },
                { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'a' }, { pinId: '2', netId: 'cap' }] },
                { id: 'c1', type: 'capacitor', designator: 'C1', value: '1u', pins: [{ pinId: '1', netId: 'cap' }, { pinId: '2', netId: '0' }] },
            ],
            nets: [{ id: 'a', name: 'a' }, { id: 'cap', name: 'cap' }, { id: '0', name: '0', isGround: true }],
        };
        const analysis: TranAnalysis = { type: 'tran', stopTime: '5m', stepTime: '5u', initialConditions: { cap: 0.5 } };
        const parsed = roundTrip(circuit, analysis);
        const ic = (parsed.analysis as TranAnalysis | undefined)?.initialConditions;
        expect(ic).toBeDefined();
        // The generator emits `.ic v(<sanitized-node>)=...`; the parser keys by that node.
        expect(ic![sanitizeNodeName('cap')]).toBe(0.5);
    });
});

describe('SPICE parser — line-continuation folding', () => {
    it("folds '+' continuation lines into the prior .model statement", () => {
        const deck = [
            '* continuation test',
            'V1 vcc 0 DC 10',
            'RC1 vcc col 2.2k',
            'RB1 vcc base 220k',
            'Q1 col base 0 QN1',
            '.model QN1 NPN(BF=180',
            '+ IS=1e-15',
            '+ VAF=80)',
            '.op',
        ].join('\n');
        const parsed = parseNetlist(deck);
        const qn = (parsed.circuit.models ?? []).find((m) => m.name === 'QN1');
        expect(qn).toBeDefined();
        expect(qn!.device).toBe('bjt');
        // All three physical lines are one logical .model statement now.
        expect(qn!.body).toContain('BF=180');
        expect(qn!.body).toContain('IS=1e-15');
        expect(qn!.body).toContain('VAF=80');
        expect(parsed.warnings.filter((w) => /could not parse/i.test(w))).toHaveLength(0);
    });
});

describe('SPICE round-trip — idempotence on a model-free circuit', () => {
    it('generate∘parse∘generate is a fixed point (no drift) for a divider with .options', () => {
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'vin' }, { pinId: '-', netId: '0' }] },
                { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'vin' }, { pinId: '2', netId: 'vout' }] },
                { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', pins: [{ pinId: '1', netId: 'vout' }, { pinId: '2', netId: '0' }] },
            ],
            nets: [{ id: 'vin', name: 'vin' }, { id: 'vout', name: 'vout' }, { id: '0', name: '0', isGround: true }],
        };
        const analysis: OpAnalysis = { type: 'op', options: { gmin: '1e-9' } };
        // Normalize the one deliberately non-deterministic line — the `* <ISO timestamp>` generation stamp —
        // so the comparison measures round-trip fidelity, not wall-clock.
        const stripStamp = (s: string) => s.replace(/^\* \d{4}-\d{2}-\d{2}T[\d:.]+Z$/m, '* <stamp>');
        const n1 = generateNetlist(circuit, analysis);
        const n2 = generateNetlist(parseNetlist(n1).circuit, parseNetlist(n1).analysis ?? analysis);
        expect(stripStamp(n2)).toBe(stripStamp(n1)); // re-importing the deck and re-exporting reproduces it byte-for-byte
    });
});

describe('SPICE parser — lossy directives surface a warning (not a silent drop)', () => {
    it('warns on .include / .lib / .param instead of dropping them silently', () => {
        const deck = ['* lib test', 'R1 a 0 1k', '.include "models.lib"', '.lib "tt.lib" tt', '.op'].join('\n');
        const parsed = parseNetlist(deck);
        expect(parsed.warnings.some((w) => /not imported/i.test(w) && /models\.lib/i.test(w))).toBe(true);
        expect(parsed.warnings.some((w) => /not imported/i.test(w) && /tt\.lib/i.test(w))).toBe(true);
    });
});
