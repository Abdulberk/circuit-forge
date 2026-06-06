/**
 * Active-device (BJT / MOSFET) support: model-based netlist emission, canonical node ordering,
 * circuit.models de-dup, the generic model library, and the ERC rules.
 */
import { generateNetlist } from '../src/netlist/generator';
import { parseNetlist } from '../src/parser/netlist-parser';
import { runErc } from '../src/erc/checker';
import { ErcCode } from '../src/types/erc';
import { GENERIC_MODELS, resolveModelForPart, resolveGenericModels, buildZenerModel, normalizeControlledSourceGain, parseTransformerParams, parseTransmissionLineParams } from '../src/models/library';
import { isSimulatable } from '../src/types/circuit';
import type { CircuitJson, ModelDef } from '../src/types/circuit';
import type { TranAnalysis } from '../src/types/analysis';

const NPN: ModelDef = GENERIC_MODELS.npn!;
const TRAN: TranAnalysis = { type: 'tran', stopTime: '1m' };

/** Common-emitter NPN stage. Q1 pins authored OUT OF canonical order to prove reordering. */
function npnCircuit(model?: string): CircuitJson {
    return {
        version: '1.0',
        components: [
            { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [
                { pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
            { id: 'rc', type: 'resistor', designator: 'RC1', value: '1k', pins: [
                { pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'col' }] },
            // pins authored emitter, base, collector — the generator must reorder to c b e.
            { id: 'q1', type: 'bjt', designator: 'Q1', model, pins: [
                { pinId: 'e', netId: 'gnd' }, { pinId: 'b', netId: 'base' }, { pinId: 'c', netId: 'col' }] },
            { id: 'vb', type: 'voltage_source', designator: 'V2', value: 'DC 0.7', pins: [
                { pinId: '+', netId: 'base' }, { pinId: '-', netId: 'gnd' }] },
        ],
        nets: [
            { id: 'vcc', name: 'VCC' }, { id: 'col', name: 'COL' }, { id: 'base', name: 'BASE' },
            { id: 'gnd', name: 'GND', isGround: true },
        ],
        models: model ? [NPN] : undefined,
    };
}

describe('active devices', () => {
    it('emits a BJT in canonical c,b,e order (by pinId, not authored order) + the model body once', () => {
        const netlist = generateNetlist(npnCircuit('QGENNPN'), TRAN);
        expect(netlist).toContain('.model QGENNPN NPN(');
        const q = netlist.split('\n').find((l) => l.startsWith('Q1 '))!;
        expect(q).toBeTruthy();
        const parts = q.split(/\s+/); // Q1 <c> <b> <e> QGENNPN
        expect(parts[4]).toBe('QGENNPN');
        // Emitter (authored FIRST) maps to ground '0' and must land in the LAST node slot (canonical e).
        expect(parts[3]).toBe('0');
        expect(parts[1]).not.toBe('0'); // collector slot is not ground
    });

    it('de-dupes circuit.models by name (two BJTs, one .model line)', () => {
        const c = npnCircuit('QGENNPN');
        c.components.push({ id: 'q2', type: 'bjt', designator: 'Q2', model: 'QGENNPN', pins: [
            { pinId: 'c', netId: 'col' }, { pinId: 'b', netId: 'base' }, { pinId: 'e', netId: 'gnd' }] });
        c.models = [NPN, NPN];
        const netlist = generateNetlist(c, TRAN);
        expect(netlist.match(/\.model QGENNPN/g)?.length).toBe(1);
        expect(netlist).toContain('Q1 ');
        expect(netlist).toContain('Q2 ');
    });

    it('skips a BJT with no model (cannot emit a valid device line)', () => {
        const netlist = generateNetlist(npnCircuit(undefined), TRAN);
        expect(netlist).not.toMatch(/^Q1 /m);
    });

    it('throws on two models sharing a name with DIFFERENT bodies (no silent wrong-model)', () => {
        const c = npnCircuit('QGENNPN');
        // Same name as the genuine NPN model, but a conflicting (PNP) body — emitting only the first
        // would silently simulate the wrong device, so the generator must refuse.
        c.models = [NPN, { name: 'QGENNPN', device: 'bjt', body: '.model QGENNPN PNP(BF=50)', tier: 'generic' }];
        expect(() => generateNetlist(c, TRAN)).toThrow(/Conflicting definitions for model 'QGENNPN'/);
    });

    it('does not emit DDEFAULT twice when a caller supplies an identical DDEFAULT model', () => {
        // A model-less diode triggers the built-in DDEFAULT; a caller-supplied identical DDEFAULT must dedup.
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'd1', type: 'diode', designator: 'D1', pins: [
                    { pinId: 'anode', netId: 'in' }, { pinId: 'cathode', netId: 'gnd' }] },
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [
                    { pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
            ],
            nets: [{ id: 'in', name: 'IN' }, { id: 'gnd', name: 'GND', isGround: true }],
            models: [{ name: 'DDEFAULT', device: 'diode', body: '.model DDEFAULT D(IS=1e-14 N=1.05 RS=10 BV=100 IBV=1e-10)' }],
        };
        const netlist = generateNetlist(circuit, TRAN);
        expect(netlist.match(/\.model DDEFAULT/g)?.length).toBe(1);
    });

    it('throws when a caller-supplied DDEFAULT conflicts with the built-in default diode model', () => {
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'd1', type: 'diode', designator: 'D1', pins: [
                    { pinId: 'anode', netId: 'in' }, { pinId: 'cathode', netId: 'gnd' }] },
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [
                    { pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
            ],
            nets: [{ id: 'in', name: 'IN' }, { id: 'gnd', name: 'GND', isGround: true }],
            models: [{ name: 'DDEFAULT', device: 'diode', body: '.model DDEFAULT D(IS=2e-14)' }],
        };
        expect(() => generateNetlist(circuit, TRAN)).toThrow(/Conflicting definitions for model 'DDEFAULT'/);
    });

    it('emits a MOSFET in canonical d,g,s,b order', () => {
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'm1', type: 'mosfet', designator: 'M1', model: 'MGENNMOS', pins: [
                    { pinId: 's', netId: 'gnd' }, { pinId: 'g', netId: 'in' }, { pinId: 'd', netId: 'out' }, { pinId: 'b', netId: 'gnd' }] },
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [
                    { pinId: '+', netId: 'out' }, { pinId: '-', netId: 'gnd' }] },
            ],
            nets: [{ id: 'in', name: 'IN' }, { id: 'out', name: 'OUT' }, { id: 'gnd', name: 'GND', isGround: true }],
            models: [GENERIC_MODELS.nmos!],
        };
        const netlist = generateNetlist(circuit, TRAN);
        const m = netlist.split('\n').find((l) => l.startsWith('M1 '))!;
        const parts = m.split(/\s+/); // M1 <d> <g> <s> <b> MGENNMOS  (6 tokens)
        expect(parts[5]).toBe('MGENNMOS'); // model is the last token (after 4 nodes)
        expect(parts[3]).toBe('0'); // source -> gnd
        expect(parts[4]).toBe('0'); // bulk -> gnd
        expect(parts[1]).not.toBe('0'); // drain (authored 3rd) reordered into the 1st node slot
    });

    it('round-trips a BJT line through the parser (c,b,e pins)', () => {
        const result = parseNetlist('Q1 col base 0 QGENNPN\n.end');
        const q = result.circuit.components.find((c) => c.designator === 'Q1')!;
        expect(q.type).toBe('bjt');
        expect(q.model).toBe('QGENNPN');
        expect(q.pins.map((p) => p.pinId)).toEqual(['c', 'b', 'e']);
    });

    it('emits a JFET in canonical d,g,s order (by pinId) + round-trips through the parser', () => {
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                // authored source, gate, drain — generator must reorder to d,g,s
                { id: 'j1', type: 'jfet', designator: 'J1', model: 'JGENNJF', pins: [
                    { pinId: 's', netId: 'gnd' }, { pinId: 'g', netId: 'in' }, { pinId: 'd', netId: 'out' }] },
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [
                    { pinId: '+', netId: 'out' }, { pinId: '-', netId: 'gnd' }] },
            ],
            nets: [{ id: 'in', name: 'IN' }, { id: 'out', name: 'OUT' }, { id: 'gnd', name: 'GND', isGround: true }],
            models: [GENERIC_MODELS.njf!],
        };
        const netlist = generateNetlist(circuit, TRAN);
        expect(netlist).toContain('.model JGENNJF NJF(');
        const j = netlist.split('\n').find((l) => l.startsWith('J1 '))!;
        const parts = j.split(/\s+/); // J1 <d> <g> <s> JGENNJF (5 tokens)
        expect(parts[4]).toBe('JGENNJF');
        expect(parts[3]).toBe('0'); // source (authored 1st) reordered into the LAST node slot
        expect(parts[1]).not.toBe('0'); // drain slot is not ground

        const rt = parseNetlist('J1 nd ng ns JGENNJF\n.end').circuit.components.find((c) => c.designator === 'J1')!;
        expect(rt.type).toBe('jfet');
        expect(rt.model).toBe('JGENNJF');
        expect(rt.pins.map((p) => p.pinId)).toEqual(['d', 'g', 's']);
    });

    describe('library', () => {
        it('resolves generic models by polarity', () => {
            expect(resolveModelForPart({ type: 'bjt', subtype: 'npn' })!.name).toBe('QGENNPN');
            expect(resolveModelForPart({ type: 'bjt', subtype: 'pnp' })!.name).toBe('QGENPNP');
            expect(resolveModelForPart({ type: 'mosfet', subtype: 'pmos' })!.name).toBe('MGENPMOS');
            expect(resolveModelForPart({ type: 'jfet', subtype: 'pjf' })!.name).toBe('JGENPJF');
            expect(resolveModelForPart({ type: 'jfet' })!.name).toBe('JGENNJF'); // default n-channel
            expect(resolveModelForPart({ type: 'bjt' })!.name).toBe('QGENNPN'); // default npn
            expect(resolveModelForPart({ type: 'resistor' })).toBeNull();
        });
    });

    describe('ERC', () => {
        it('flags an active device with no model as MODEL_REQUIRED (error)', () => {
            const issues = runErc(npnCircuit(undefined)).issues;
            const mr = issues.find((i) => i.code === ErcCode.MODEL_REQUIRED);
            expect(mr).toBeTruthy();
            expect(mr!.severity).toBe('error');
        });

        it('flags a BJT with the wrong pin count', () => {
            const c = npnCircuit('QGENNPN');
            (c.components.find((x) => x.id === 'q1')!).pins = [
                { pinId: 'c', netId: 'col' }, { pinId: 'e', netId: 'gnd' }]; // only 2 pins
            const issues = runErc(c).issues;
            expect(issues.some((i) => i.code === ErcCode.PIN_COUNT_MISMATCH)).toBe(true);
        });

        it('warns UNRESOLVED_MODEL when a device references a model not defined in the circuit', () => {
            // Q1.model = 'Q2N2222' but circuit.models only defines QGENNPN -> the name is dangling.
            const c = npnCircuit('Q2N2222');
            const issues = runErc(c).issues;
            const u = issues.find((i) => i.code === ErcCode.UNRESOLVED_MODEL);
            expect(u).toBeTruthy();
            expect(u!.severity).toBe('warning');
        });

        it('does NOT warn UNRESOLVED_MODEL when the referenced model is defined (or built-in)', () => {
            // QGENNPN is in circuit.models -> resolved; a model-less diode uses the built-in DDEFAULT.
            const c = npnCircuit('QGENNPN');
            c.components.push({ id: 'd1', type: 'diode', designator: 'D1', pins: [
                { pinId: 'anode', netId: 'col' }, { pinId: 'cathode', netId: 'gnd' }] });
            const issues = runErc(c).issues;
            expect(issues.some((i) => i.code === ErcCode.UNRESOLVED_MODEL)).toBe(false);
        });
    });

    it('bjt/mosfet/jfet/subckt/vcvs/vccs are simulatable types; generic is not', () => {
        expect(isSimulatable({ type: 'bjt' })).toBe(true);
        expect(isSimulatable({ type: 'mosfet' })).toBe(true);
        expect(isSimulatable({ type: 'jfet' })).toBe(true);
        expect(isSimulatable({ type: 'subckt' })).toBe(true);
        expect(isSimulatable({ type: 'vcvs' })).toBe(true);
        expect(isSimulatable({ type: 'vccs' })).toBe(true);
        expect(isSimulatable({ type: 'generic' })).toBe(false);
    });

    describe('controlled sources (VCVS / VCCS)', () => {
        // Output pair + control pair; control pins authored FIRST to prove canonical (+,-,c+,c-) binding.
        function csCircuit(type: 'vcvs' | 'vccs', value?: string): CircuitJson {
            return {
                version: '1.0',
                components: [
                    { id: 'vin', type: 'voltage_source', designator: 'V1', value: 'SIN(0 0.1 1k)', pins: [
                        { pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
                    { id: 'e1', type, designator: type === 'vcvs' ? 'E1' : 'G1', value, pins: [
                        { pinId: 'c+', netId: 'in' }, { pinId: 'c-', netId: 'gnd' },
                        { pinId: '+', netId: 'out' }, { pinId: '-', netId: 'gnd' }] },
                    { id: 'rl', type: 'resistor', designator: 'RL1', value: '1k', pins: [
                        { pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
                ],
                nets: [{ id: 'in', name: 'IN' }, { id: 'out', name: 'OUT' }, { id: 'gnd', name: 'GND', isGround: true }],
            };
        }

        it('emits E/G with 4 nodes in canonical (out+,out-,c+,c-) order + the gain value', () => {
            const e = generateNetlist(csCircuit('vcvs', '10'), TRAN).split('\n').find((l) => l.startsWith('E1 '))!;
            const ep = e.split(/\s+/); // E1 <out+> <out-> <c+> <c-> 10  (6 tokens)
            expect(ep.length).toBe(6);
            expect(ep[ep.length - 1]).toBe('10');
            expect(ep[2]).toBe('0'); // out- -> ground (despite control pins authored first)
            expect(ep[4]).toBe('0'); // c- -> ground
            const g = generateNetlist(csCircuit('vccs', '1m'), TRAN).split('\n').find((l) => l.startsWith('G1 '))!;
            expect(g.split(/\s+/).pop()).toBe('1m');
        });

        it('round-trips E/G through the parser (+,-,c+,c- pins)', () => {
            const e = parseNetlist('E1 op on cp cn 100\n.end').circuit.components.find((c) => c.designator === 'E1')!;
            expect(e.type).toBe('vcvs');
            expect(e.value).toBe('100');
            expect(e.pins.map((p) => p.pinId)).toEqual(['+', '-', 'c+', 'c-']);
            const g = parseNetlist('G1 op on cp cn 1m\n.end').circuit.components.find((c) => c.designator === 'G1')!;
            expect(g.type).toBe('vccs');
        });

        it('ERC flags a value-less controlled source (MISSING_VALUE) and a wrong pin count', () => {
            const issues = runErc(csCircuit('vcvs', undefined)).issues;
            expect(issues.some((i) => i.code === ErcCode.MISSING_VALUE && i.relatedIds.includes('e1'))).toBe(true);
            const c = csCircuit('vcvs', '10');
            (c.components.find((x) => x.id === 'e1')!).pins = [
                { pinId: '+', netId: 'out' }, { pinId: '-', netId: 'gnd' }]; // only 2 of 4 pins
            expect(runErc(c).issues.some((i) => i.code === ErcCode.PIN_COUNT_MISMATCH && i.relatedIds.includes('e1'))).toBe(true);
        });

        it('normalizes a controlled-source gain: tolerates a stray "DC", rejects keyword/expression forms', () => {
            expect(normalizeControlledSourceGain('10')).toBe('10');
            expect(normalizeControlledSourceGain('1e3')).toBe('1e3');
            expect(normalizeControlledSourceGain('1m')).toBe('1m');
            expect(normalizeControlledSourceGain('DC 100')).toBe('100'); // tolerated stray prefix
            expect(normalizeControlledSourceGain('POLY(1) in 0 0 2')).toBeNull();
            expect(normalizeControlledSourceGain('VALUE = {5*V(in)}')).toBeNull();
            expect(normalizeControlledSourceGain('DC')).toBeNull();
        });

        it('a "DC "-prefixed gain is emitted as a bare number (would otherwise crash ngspice)', () => {
            const e = generateNetlist(csCircuit('vcvs', 'DC 10'), TRAN).split('\n').find((l) => l.startsWith('E1 '))!;
            expect(e.split(/\s+/).pop()).toBe('10'); // 'DC ' stripped -> valid linear VCVS
        });

        it('skips a keyword-form gain in the generator and flags it INVALID_VALUE in ERC', () => {
            const c = csCircuit('vcvs', 'POLY(1) in 0 0 2');
            expect(generateNetlist(c, TRAN)).not.toMatch(/^E1 /m); // not emitted (would crash ngspice)
            const issues = runErc(c).issues;
            expect(issues.some((i) => i.code === ErcCode.INVALID_VALUE && i.relatedIds.includes('e1'))).toBe(true);
        });

        it('parser skips a non-linear (POLY/VALUE=) controlled source instead of inventing phantom nodes', () => {
            const r = parseNetlist('E1 out 0 POLY(1) in 0 0 2\n.end');
            expect(r.circuit.components.some((c) => c.type === 'vcvs')).toBe(false);
            expect(r.circuit.nets.some((n) => /poly/i.test(n.id))).toBe(false); // no phantom 'POLY(1)' net
            expect(r.warnings.length).toBeGreaterThan(0);
        });
    });

    it('ERC flags a JFET with no model (MODEL_REQUIRED) and a wrong pin count', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'j1', type: 'jfet', designator: 'J1', pins: [ // no model + only 2 pins
                    { pinId: 'd', netId: 'out' }, { pinId: 's', netId: 'gnd' }] },
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [
                    { pinId: '+', netId: 'out' }, { pinId: '-', netId: 'gnd' }] },
            ],
            nets: [{ id: 'out', name: 'OUT' }, { id: 'gnd', name: 'GND', isGround: true }],
        };
        const issues = runErc(c).issues;
        expect(issues.some((i) => i.code === ErcCode.MODEL_REQUIRED && i.relatedIds.includes('j1'))).toBe(true);
        expect(issues.some((i) => i.code === ErcCode.PIN_COUNT_MISMATCH && i.relatedIds.includes('j1'))).toBe(true);
    });

    describe('transformer (coupled inductors)', () => {
        function xfmrCircuit(props?: Record<string, unknown>): CircuitJson {
            return {
                version: '1.0',
                components: [
                    { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 1 50k)', pins: [
                        { pinId: '+', netId: 'prim' }, { pinId: '-', netId: 'gnd' }] },
                    // pins authored shuffled to prove canonical p+,p-,s+,s- binding
                    { id: 't1', type: 'transformer', designator: 'T1', properties: props, pins: [
                        { pinId: 's+', netId: 'sec' }, { pinId: 'p-', netId: 'gnd' },
                        { pinId: 's-', netId: 'gnd' }, { pinId: 'p+', netId: 'prim' }] },
                    { id: 'rl', type: 'resistor', designator: 'RL1', value: '10k', pins: [
                        { pinId: '1', netId: 'sec' }, { pinId: '2', netId: 'gnd' }] },
                ],
                nets: [{ id: 'prim', name: 'PRIM' }, { id: 'sec', name: 'SEC' }, { id: 'gnd', name: 'GND', isGround: true }],
            };
        }

        it('parses winding params: requires both inductances, defaults coupling, rejects bad k', () => {
            expect(parseTransformerParams({ primaryInductance: '100m', secondaryInductance: '25m' })).toEqual({
                lp: '100m', ls: '25m', k: '0.999',
            });
            expect(parseTransformerParams({ primaryInductance: '10m', secondaryInductance: '10m', coupling: '0.95' })!.k).toBe('0.95');
            expect(parseTransformerParams({ primaryInductance: '10m' })).toBeNull(); // missing secondary
            expect(parseTransformerParams({ primaryInductance: '10m', secondaryInductance: 'abc' })).toBeNull();
            expect(parseTransformerParams({ primaryInductance: '10m', secondaryInductance: '10m', coupling: '1.5' })).toBeNull();
            expect(parseTransformerParams({ primaryInductance: '10m', secondaryInductance: '10m', coupling: '0' })).toBeNull();
            // strictly-positive windings: a negative or zero inductance is non-physical and is rejected
            expect(parseTransformerParams({ primaryInductance: '-10m', secondaryInductance: '25m' })).toBeNull();
            expect(parseTransformerParams({ primaryInductance: '0', secondaryInductance: '25m' })).toBeNull();
            // a JS-coercible but non-decimal coupling ("0x1" -> Number 1) must NOT slip through
            expect(parseTransformerParams({ primaryInductance: '10m', secondaryInductance: '10m', coupling: '0x1' })).toBeNull();
        });

        it('expands one transformer into two coupled windings (L+series-R) + a K statement, bound by pinId', () => {
            const TRAN1: TranAnalysis = { type: 'tran', stopTime: '60u', stepTime: '0.1u' };
            const netlist = generateNetlist(xfmrCircuit({ primaryInductance: '100m', secondaryInductance: '25m', coupling: '0.99' }), TRAN1);
            const lp = netlist.split('\n').find((l) => l.startsWith('LT1P '))!;
            const ls = netlist.split('\n').find((l) => l.startsWith('LT1S '))!;
            const k = netlist.split('\n').find((l) => l.startsWith('KT1 '))!;
            expect(lp.split(/\s+/)[1]).toBe('nprim'); // p+ -> primary net (despite being authored last)
            expect(lp).toContain('100m');
            expect(ls).toContain('25m');
            expect(k).toBe('KT1 LT1P LT1S 0.99'); // K couples the two winding inductors
            // a tiny series winding resistance is emitted for DC-path conditioning
            expect(netlist).toMatch(/^RT1P .* 1m$/m);
            expect(netlist).toMatch(/^RT1S .* 1m$/m);
        });

        it('ERC flags a transformer with missing/invalid winding params + the wrong pin count', () => {
            // a missing key -> MISSING_VALUE
            expect(runErc(xfmrCircuit({ primaryInductance: '10m' })).issues
                .some((i) => i.code === ErcCode.MISSING_VALUE && i.relatedIds.includes('t1'))).toBe(true);
            // both present but non-physical (negative) -> INVALID_VALUE
            expect(runErc(xfmrCircuit({ primaryInductance: '-10m', secondaryInductance: '25m' })).issues
                .some((i) => i.code === ErcCode.INVALID_VALUE && i.relatedIds.includes('t1'))).toBe(true);
            const c = xfmrCircuit({ primaryInductance: '10m', secondaryInductance: '10m' });
            (c.components.find((x) => x.id === 't1')!).pins = [
                { pinId: 'p+', netId: 'prim' }, { pinId: 'p-', netId: 'gnd' }]; // only 2 of 4
            expect(runErc(c).issues.some((i) => i.code === ErcCode.PIN_COUNT_MISMATCH && i.relatedIds.includes('t1'))).toBe(true);
        });

        it('transformer is a simulatable type', () => {
            expect(isSimulatable({ type: 'transformer' })).toBe(true);
        });

        it('emits a bleeder to ground for an ISOLATED secondary (no DC reference otherwise)', () => {
            const TRAN1: TranAnalysis = { type: 'tran', stopTime: '60u', stepTime: '1u' };
            // secondary on floating nets sa/sb (neither is ground) -> needs a bleeder; primary is grounded.
            const c: CircuitJson = {
                version: '1.0',
                components: [
                    { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 1 50k)', pins: [
                        { pinId: '+', netId: 'prim' }, { pinId: '-', netId: 'gnd' }] },
                    { id: 't1', type: 'transformer', designator: 'T1', properties: { primaryInductance: '100m', secondaryInductance: '25m' }, pins: [
                        { pinId: 'p+', netId: 'prim' }, { pinId: 'p-', netId: 'gnd' },
                        { pinId: 's+', netId: 'sa' }, { pinId: 's-', netId: 'sb' }] },
                    { id: 'rl', type: 'resistor', designator: 'RL1', value: '1k', pins: [
                        { pinId: '1', netId: 'sa' }, { pinId: '2', netId: 'sb' }] },
                ],
                nets: [{ id: 'prim', name: 'PRIM' }, { id: 'sa', name: 'SA' }, { id: 'sb', name: 'SB' }, { id: 'gnd', name: 'GND', isGround: true }],
            };
            const netlist = generateNetlist(c, TRAN1);
            expect(netlist).toMatch(/^RT1SG \S+ 0 1G$/m); // isolated secondary tied to ground via a 1G bleeder
            expect(netlist).not.toMatch(/^RT1PG /m); // primary is grounded -> no primary bleeder
        });

        it('throws when a transformer sub-element name collides with another component', () => {
            const c = xfmrCircuit({ primaryInductance: '10m', secondaryInductance: '10m' });
            // a user inductor named LT1P collides with transformer T1's primary winding name
            c.components.push({ id: 'lx', type: 'inductor', designator: 'LT1P', value: '1m', pins: [
                { pinId: '1', netId: 'sec' }, { pinId: '2', netId: 'gnd' }] });
            const TRAN1: TranAnalysis = { type: 'tran', stopTime: '1m' };
            expect(() => generateNetlist(c, TRAN1)).toThrow(/Duplicate device name 'LT1P'/);
        });

        it('parser skips a mutual-coupling K line (export-only) instead of failing to parse it', () => {
            const r = parseNetlist('LT1P a b 100m\nLT1S c d 25m\nKT1 LT1P LT1S 0.99\n.end');
            expect(r.circuit.components.filter((x) => x.type === 'inductor').length).toBe(2);
            expect(r.warnings.some((w) => /coupling not imported/i.test(w))).toBe(true);
            expect(r.circuit.nets.some((n) => /lt1/i.test(n.id))).toBe(false); // no phantom net from the K line
        });
    });

    describe('subckt (op-amp)', () => {
        // Inverting amp built around the generic OPAMPGEN. Op-amp pins authored in the contract order
        // out, in+, in-, vcc, vee. designator U1 (schematic) must be emitted as XU1 (SPICE 'X' prefix).
        function opampCircuit(model?: string): CircuitJson {
            return {
                version: '1.0',
                components: [
                    { id: 'vp', type: 'voltage_source', designator: 'V1', value: 'DC 15', pins: [
                        { pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
                    { id: 'vn', type: 'voltage_source', designator: 'V2', value: 'DC -15', pins: [
                        { pinId: '+', netId: 'vee' }, { pinId: '-', netId: 'gnd' }] },
                    { id: 'rg', type: 'resistor', designator: 'RG1', value: '1k', pins: [
                        { pinId: '1', netId: 'in' }, { pinId: '2', netId: 'inv' }] },
                    { id: 'rf', type: 'resistor', designator: 'RF1', value: '10k', pins: [
                        { pinId: '1', netId: 'inv' }, { pinId: '2', netId: 'out' }] },
                    { id: 'u1', type: 'subckt', designator: 'U1', model, pins: [
                        { pinId: 'out', netId: 'out' }, { pinId: 'in+', netId: 'gnd' }, { pinId: 'in-', netId: 'inv' },
                        { pinId: 'vcc', netId: 'vcc' }, { pinId: 'vee', netId: 'vee' }] },
                    { id: 'vin', type: 'voltage_source', designator: 'V3', value: 'SIN(0 0.5 1k)', pins: [
                        { pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
                ],
                nets: [
                    { id: 'vcc', name: 'VCC' }, { id: 'vee', name: 'VEE' }, { id: 'in', name: 'IN' },
                    { id: 'inv', name: 'INV' }, { id: 'out', name: 'OUT' }, { id: 'gnd', name: 'GND', isGround: true },
                ],
                models: model === 'OPAMPGEN' ? [GENERIC_MODELS.opamp!] : undefined,
            };
        }

        it('emits an X-prefixed instance (U1 -> XU1) in macromodel port order + the .subckt body once', () => {
            const netlist = generateNetlist(opampCircuit('OPAMPGEN'), TRAN);
            expect(netlist).toContain('.subckt OPAMPGEN out inp inn vcc vee');
            expect(netlist.match(/\.subckt OPAMPGEN/g)!.length).toBe(1); // body emitted exactly once
            const x = netlist.split('\n').find((l) => l.startsWith('XU1 '))!;
            expect(x).toBeTruthy();
            const parts = x.split(/\s+/); // XU1 <out> <in+> <in-> <vcc> <vee> OPAMPGEN
            expect(parts.length).toBe(7); // designator + 5 nodes + model
            expect(parts[parts.length - 1]).toBe('OPAMPGEN');
            expect(parts[2]).toBe('0'); // in+ (2nd port) tied to ground
        });

        it('binds subckt nodes by macromodel PORT order — a reordered pin array nets identically', () => {
            const canonical = opampCircuit('OPAMPGEN');
            const shuffled = opampCircuit('OPAMPGEN');
            // same five (correct) pins, deliberately authored OUT of the contract order:
            shuffled.components.find((c) => c.id === 'u1')!.pins = [
                { pinId: 'in-', netId: 'inv' },
                { pinId: 'vee', netId: 'vee' },
                { pinId: 'out', netId: 'out' },
                { pinId: 'in+', netId: 'gnd' },
                { pinId: 'vcc', netId: 'vcc' },
            ];
            const xCanon = generateNetlist(canonical, TRAN).split('\n').find((l) => l.startsWith('XU1 '))!;
            const xShuf = generateNetlist(shuffled, TRAN).split('\n').find((l) => l.startsWith('XU1 '))!;
            expect(xShuf).toBe(xCanon); // pinId binding => authored array order is irrelevant
            expect(xShuf.split(/\s+/)[2]).toBe('0'); // in+ still resolves to ground
        });

        it('throws when a subckt is missing a port its macromodel requires', () => {
            const c = opampCircuit('OPAMPGEN');
            const u = c.components.find((x) => x.id === 'u1')!;
            u.pins = u.pins.filter((p) => p.pinId !== 'vee'); // drop a required port
            expect(() => generateNetlist(c, TRAN)).toThrow(/missing pin 'vee'/);
        });

        it('skips a subckt with no model (cannot emit a valid instance)', () => {
            const netlist = generateNetlist(opampCircuit(undefined), TRAN);
            expect(netlist).not.toMatch(/^XU1 /m);
        });

        it('round-trips an X line through the parser (variable arity, index-based pinIds)', () => {
            const result = parseNetlist('XU1 out 0 inv vcc vee OPAMPGEN\n.end');
            const u = result.circuit.components.find((c) => c.designator === 'XU1')!;
            expect(u.type).toBe('subckt');
            expect(u.model).toBe('OPAMPGEN');
            expect(u.pins.map((p) => p.netId)).toEqual(['out', '0', 'inv', 'vcc', 'vee']);
            expect(u.pins.map((p) => p.pinId)).toEqual(['1', '2', '3', '4', '5']);
        });

        it('ERC flags a subckt with no model as MODEL_REQUIRED, but never a pin-count mismatch', () => {
            const issues = runErc(opampCircuit(undefined)).issues;
            expect(issues.some((i) => i.code === ErcCode.MODEL_REQUIRED && i.relatedIds.includes('u1'))).toBe(true);
            // variable arity -> subckt is exempt from the pin-count check
            expect(issues.some((i) => i.code === ErcCode.PIN_COUNT_MISMATCH && i.relatedIds.includes('u1'))).toBe(false);
        });

        it('library resolves OPAMPGEN and the host injects its body by name', () => {
            expect(GENERIC_MODELS.opamp!.name).toBe('OPAMPGEN');
            expect(GENERIC_MODELS.opamp!.device).toBe('subckt');
            const extra = resolveGenericModels({
                components: [{ id: 'u1', type: 'subckt', designator: 'U1', model: 'OPAMPGEN', pins: [] }],
                models: [],
            });
            expect(extra.map((m) => m.name)).toContain('OPAMPGEN');
        });
    });

    describe('zener (parametric breakdown model)', () => {
        const OP: TranAnalysis = { type: 'tran', stopTime: '1m' };
        // Shunt regulator: 12V -> 1k -> reg; zener clamps reg to Vz. Zener pins authored cathode-first
        // to prove canonical anode,cathode binding (polarity is what makes a zener clamp).
        function zenerCircuit(value?: string): CircuitJson {
            return {
                version: '1.0',
                components: [
                    { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 12', pins: [
                        { pinId: '+', netId: 'vin' }, { pinId: '-', netId: 'gnd' }] },
                    { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [
                        { pinId: '1', netId: 'vin' }, { pinId: '2', netId: 'reg' }] },
                    { id: 'dz', type: 'zener', designator: 'DZ1', value, pins: [
                        { pinId: 'cathode', netId: 'reg' }, { pinId: 'anode', netId: 'gnd' }] },
                ],
                nets: [{ id: 'vin', name: 'VIN' }, { id: 'reg', name: 'REG' }, { id: 'gnd', name: 'GND', isGround: true }],
            };
        }

        it('builds a parametric breakdown model from the voltage (incl. 5V1 notation), rejects junk', () => {
            expect(buildZenerModel('5.1')!.name).toBe('DZ5P1');
            expect(buildZenerModel('5.1')!.body).toContain('BV=5.1');
            expect(buildZenerModel('5.1')!.device).toBe('diode');
            expect(buildZenerModel('5V1')!.name).toBe('DZ5P1'); // European Zener notation
            expect(buildZenerModel('12V')!.name).toBe('DZ12');
            expect(buildZenerModel('5.1V')!.name).toBe('DZ5P1'); // trailing unit
            expect(buildZenerModel('abc')).toBeNull();
            expect(buildZenerModel('0')).toBeNull();
            // Strict whole-string parse: never prefix-parse an MPN, a multi-token spec, or a range.
            expect(buildZenerModel('1N4733A')).toBeNull(); // a real 5.1V Zener MPN — must NOT become 1V
            expect(buildZenerModel('5V1 0.5W')).toBeNull(); // Vz + power rating — ambiguous, reject
            expect(buildZenerModel('4.5...16')).toBeNull(); // a range — reject (not a single voltage)
            expect(buildZenerModel('-5')).toBeNull();
        });

        it('ERC flags a present-but-unparseable zener value as INVALID_VALUE (not silently dropped)', () => {
            const c = zenerCircuit('1N4733A'); // value present (truthy) but not a parseable voltage
            const issues = runErc(c).issues;
            const iv = issues.find((i) => i.code === ErcCode.INVALID_VALUE && i.relatedIds.includes('dz'));
            expect(iv).toBeTruthy();
            expect(iv!.severity).toBe('error');
            expect(issues.some((i) => i.code === ErcCode.MISSING_VALUE && i.relatedIds.includes('dz'))).toBe(false);
        });

        it('emits a generated .model from value + a D-line in canonical anode,cathode order', () => {
            const netlist = generateNetlist(zenerCircuit('5.1'), OP);
            expect(netlist).toContain('.model DZ5P1 D(');
            expect(netlist).toContain('BV=5.1');
            const d = netlist.split('\n').find((l) => l.startsWith('DZ1 '))!;
            const parts = d.split(/\s+/); // DZ1 <anode> <cathode> DZ5P1
            expect(parts[parts.length - 1]).toBe('DZ5P1');
            expect(parts[1]).toBe('0'); // anode -> ground first, despite cathode being authored first
        });

        it('de-dupes identical Vz and emits distinct models for distinct Vz', () => {
            const c = zenerCircuit('5.1');
            c.components.push({ id: 'dz2', type: 'zener', designator: 'DZ2', value: '5.1', pins: [
                { pinId: 'anode', netId: 'gnd' }, { pinId: 'cathode', netId: 'reg' }] });
            c.components.push({ id: 'dz3', type: 'zener', designator: 'DZ3', value: '12', pins: [
                { pinId: 'anode', netId: 'gnd' }, { pinId: 'cathode', netId: 'reg' }] });
            const netlist = generateNetlist(c, OP);
            expect(netlist.match(/\.model DZ5P1 /g)!.length).toBe(1); // shared across DZ1+DZ2
            expect(netlist.match(/\.model DZ12 /g)!.length).toBe(1);
        });

        it('skips a value-less zener and ERC flags MISSING_VALUE (not UNRESOLVED_MODEL)', () => {
            const netlist = generateNetlist(zenerCircuit(undefined), OP);
            expect(netlist).not.toMatch(/^DZ1 /m);
            const issues = runErc(zenerCircuit(undefined)).issues;
            expect(issues.some((i) => i.code === ErcCode.MISSING_VALUE && i.relatedIds.includes('dz'))).toBe(true);
            expect(issues.some((i) => i.code === ErcCode.UNRESOLVED_MODEL)).toBe(false);
        });

        it('zener is a simulatable type with a 2-pin ERC count', () => {
            expect(isSimulatable({ type: 'zener' })).toBe(true);
            const c = zenerCircuit('5.1');
            (c.components.find((x) => x.id === 'dz')!).pins = [{ pinId: 'anode', netId: 'gnd' }]; // 1 pin
            expect(runErc(c).issues.some((i) => i.code === ErcCode.PIN_COUNT_MISMATCH)).toBe(true);
        });
    });

    describe('switch (voltage-controlled)', () => {
        const TR: TranAnalysis = { type: 'tran', stopTime: '80u', stepTime: '0.5u' };
        function swCircuit(model?: string): CircuitJson {
            return {
                version: '1.0',
                components: [
                    { id: 'vdd', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [
                        { pinId: '+', netId: 'vdd' }, { pinId: '-', netId: 'gnd' }] },
                    { id: 'vc', type: 'voltage_source', designator: 'V2', value: 'PULSE(0 5 0 1u 1u 20u 40u)', pins: [
                        { pinId: '+', netId: 'ctrl' }, { pinId: '-', netId: 'gnd' }] },
                    // control pins authored FIRST to prove canonical +,-,c+,c- binding
                    { id: 's1', type: 'switch', designator: 'S1', model, pins: [
                        { pinId: 'c+', netId: 'ctrl' }, { pinId: 'c-', netId: 'gnd' },
                        { pinId: '+', netId: 'vdd' }, { pinId: '-', netId: 'out' }] },
                    { id: 'rl', type: 'resistor', designator: 'RL1', value: '1k', pins: [
                        { pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
                ],
                nets: [{ id: 'vdd', name: 'VDD' }, { id: 'ctrl', name: 'CTRL' }, { id: 'out', name: 'OUT' }, { id: 'gnd', name: 'GND', isGround: true }],
                models: model === 'SWGEN' ? [GENERIC_MODELS.vswitch!] : undefined,
            };
        }

        it('emits a switch in canonical +,-,c+,c- order + the model body once', () => {
            const netlist = generateNetlist(swCircuit('SWGEN'), TR);
            expect(netlist).toContain('.model SWGEN SW(');
            const s = netlist.split('\n').find((l) => l.startsWith('S1 '))!;
            const parts = s.split(/\s+/); // S1 <+> <-> <c+> <c-> SWGEN  (6 tokens)
            expect(parts.length).toBe(6);
            expect(parts[parts.length - 1]).toBe('SWGEN');
            expect(parts[4]).toBe('0'); // c- -> ground (despite control pins being authored first)
            expect(parts[1]).not.toBe('0'); // the + (switched) terminal is vdd, not ground
        });

        it('round-trips an S line through the parser (+,-,c+,c- pins)', () => {
            const s = parseNetlist('S1 a b c d SWGEN\n.end').circuit.components.find((c) => c.designator === 'S1')!;
            expect(s.type).toBe('switch');
            expect(s.model).toBe('SWGEN');
            expect(s.pins.map((p) => p.pinId)).toEqual(['+', '-', 'c+', 'c-']);
        });

        it('resolves the generic switch model and is a 4-pin, model-required type', () => {
            expect(GENERIC_MODELS.vswitch!.name).toBe('SWGEN');
            expect(GENERIC_MODELS.vswitch!.device).toBe('switch');
            expect(resolveModelForPart({ type: 'switch' })!.name).toBe('SWGEN');
            expect(isSimulatable({ type: 'switch' })).toBe(true);
            const issues = runErc(swCircuit(undefined)).issues; // no model
            expect(issues.some((i) => i.code === ErcCode.MODEL_REQUIRED && i.relatedIds.includes('s1'))).toBe(true);
            const c = swCircuit('SWGEN');
            (c.components.find((x) => x.id === 's1')!).pins = [{ pinId: '+', netId: 'vdd' }, { pinId: '-', netId: 'out' }];
            expect(runErc(c).issues.some((i) => i.code === ErcCode.PIN_COUNT_MISMATCH && i.relatedIds.includes('s1'))).toBe(true);
        });
    });

    describe('transmission line (lossless T)', () => {
        function tlineCircuit(props?: Record<string, unknown>): CircuitJson {
            return {
                version: '1.0',
                components: [
                    { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'PULSE(0 1 0 0.1n 0.1n 5n 20n)', pins: [
                        { pinId: '+', netId: 'src' }, { pinId: '-', netId: 'gnd' }] },
                    { id: 'rs', type: 'resistor', designator: 'RS1', value: '50', pins: [
                        { pinId: '1', netId: 'src' }, { pinId: '2', netId: 'pa' }] },
                    // pins authored shuffled to prove canonical a+,a-,b+,b- binding
                    { id: 't1', type: 'tline', designator: 'T1', properties: props, pins: [
                        { pinId: 'b+', netId: 'pb' }, { pinId: 'a-', netId: 'gnd' },
                        { pinId: 'b-', netId: 'gnd' }, { pinId: 'a+', netId: 'pa' }] },
                    { id: 'rl', type: 'resistor', designator: 'RL1', value: '50', pins: [
                        { pinId: '1', netId: 'pb' }, { pinId: '2', netId: 'gnd' }] },
                ],
                nets: [{ id: 'src', name: 'SRC' }, { id: 'pa', name: 'PA' }, { id: 'pb', name: 'PB' }, { id: 'gnd', name: 'GND', isGround: true }],
            };
        }
        const TR: TranAnalysis = { type: 'tran', stopTime: '25n', stepTime: '0.1n' };

        it('parses z0+td, accepts impedance/delay aliases, rejects missing/non-positive', () => {
            expect(parseTransmissionLineParams({ z0: '50', td: '10n' })).toEqual({ z0: '50', td: '10n' });
            expect(parseTransmissionLineParams({ impedance: '75', delay: '1u' })).toEqual({ z0: '75', td: '1u' });
            expect(parseTransmissionLineParams({ z0: '50' })).toBeNull(); // missing td/f
            expect(parseTransmissionLineParams({ z0: '-50', td: '10n' })).toBeNull();
            expect(parseTransmissionLineParams({ z0: '0', td: '10n' })).toBeNull();
            // trailing units are accepted (ngspice reads "10ns" as 10n, "50ohm" as 50) — the idiomatic form
            expect(parseTransmissionLineParams({ z0: '50ohm', td: '10ns' })).toEqual({ z0: '50ohm', td: '10ns' });
            // frequency form (F + optional normalized length NL), the alternate ngspice lossless-line spec
            expect(parseTransmissionLineParams({ z0: '50', f: '100Meg', nl: '0.25' })).toEqual({ z0: '50', f: '100Meg', nl: '0.25' });
            expect(parseTransmissionLineParams({ z0: '50', f: '1G' })).toEqual({ z0: '50', f: '1G' });
        });

        it('emits T<inst> a+ a- b+ b- Z0=.. TD=.. in canonical pin order', () => {
            const t = generateNetlist(tlineCircuit({ z0: '50', td: '5n' }), TR).split('\n').find((l) => l.startsWith('T1 '))!;
            expect(t).toMatch(/^T1 \S+ 0 \S+ 0 Z0=50 TD=5n$/);
            const parts = t.split(/\s+/); // T1 a+ a- b+ b- Z0=50 TD=5n
            expect(parts[2]).toBe('0'); // a- -> ground
            expect(parts[4]).toBe('0'); // b- -> ground
            expect(parts[1]).not.toBe('0'); // a+ is pa, not ground (despite being authored last)
        });

        it('round-trips a T line (a+,a-,b+,b- pins + z0/td properties)', () => {
            const r = parseNetlist('T1 pa 0 pb 0 Z0=50 TD=5n\n.end');
            const t = r.circuit.components.find((c) => c.designator === 'T1')!;
            expect(t.type).toBe('tline');
            expect(t.pins.map((p) => p.pinId)).toEqual(['a+', 'a-', 'b+', 'b-']);
            expect(t.properties).toMatchObject({ z0: '50', td: '5n' });
        });

        it('supports the F=/NL= frequency form (emit + round-trip), not just TD', () => {
            const t = generateNetlist(tlineCircuit({ z0: '50', f: '100Meg', nl: '0.25' }), TR)
                .split('\n').find((l) => l.startsWith('T1 '))!;
            expect(t).toMatch(/Z0=50 F=100Meg NL=0\.25$/);
            const rt = parseNetlist('T1 pa 0 pb 0 Z0=50 F=100Meg NL=0.25\n.end').circuit.components.find((c) => c.type === 'tline')!;
            expect(rt.properties).toMatchObject({ z0: '50', f: '100Meg', nl: '0.25' });
        });

        it('parser rejects a truncated T line (param leaked into a node slot) instead of inventing nodes', () => {
            const r = parseNetlist('T1 pa 0 Z0=50 TD=5n\n.end'); // only 2 real nodes
            expect(r.circuit.components.some((c) => c.type === 'tline')).toBe(false);
            expect(r.circuit.nets.some((n) => /z0|=|td/i.test(n.id))).toBe(false); // no phantom 'Z0=50' net
            expect(r.warnings.length).toBeGreaterThan(0);
        });

        it('is a simulatable 4-pin type; ERC flags missing params', () => {
            expect(isSimulatable({ type: 'tline' })).toBe(true);
            expect(runErc(tlineCircuit({ z0: '50' })).issues // missing td
                .some((i) => i.code === ErcCode.MISSING_VALUE && i.relatedIds.includes('t1'))).toBe(true);
            const c = tlineCircuit({ z0: '50', td: '5n' });
            (c.components.find((x) => x.id === 't1')!).pins = [{ pinId: 'a+', netId: 'pa' }, { pinId: 'a-', netId: 'gnd' }];
            expect(runErc(c).issues.some((i) => i.code === ErcCode.PIN_COUNT_MISMATCH && i.relatedIds.includes('t1'))).toBe(true);
        });
    });
});
