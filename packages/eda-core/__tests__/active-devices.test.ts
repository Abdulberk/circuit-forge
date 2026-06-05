/**
 * Active-device (BJT / MOSFET) support: model-based netlist emission, canonical node ordering,
 * circuit.models de-dup, the generic model library, and the ERC rules.
 */
import { generateNetlist } from '../src/netlist/generator';
import { parseNetlist } from '../src/parser/netlist-parser';
import { runErc } from '../src/erc/checker';
import { ErcCode } from '../src/types/erc';
import { GENERIC_MODELS, resolveModelForPart, resolveGenericModels } from '../src/models/library';
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

    describe('library', () => {
        it('resolves generic models by polarity', () => {
            expect(resolveModelForPart({ type: 'bjt', subtype: 'npn' })!.name).toBe('QGENNPN');
            expect(resolveModelForPart({ type: 'bjt', subtype: 'pnp' })!.name).toBe('QGENPNP');
            expect(resolveModelForPart({ type: 'mosfet', subtype: 'pmos' })!.name).toBe('MGENPMOS');
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

    it('bjt/mosfet/subckt are simulatable types; generic is not', () => {
        expect(isSimulatable({ type: 'bjt' })).toBe(true);
        expect(isSimulatable({ type: 'mosfet' })).toBe(true);
        expect(isSimulatable({ type: 'subckt' })).toBe(true);
        expect(isSimulatable({ type: 'generic' })).toBe(false);
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
});
