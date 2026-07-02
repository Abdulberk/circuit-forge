import { generateTscircuitCode, buildNetNames, sanitizeName } from './adapter';
import { classifyCircuit } from './layoutability';
import type { CircuitJson, Component, UiJson } from '@circuit-forge/eda-core';

const comp = (over: Partial<Component>): Component => ({
    id: over.designator ?? 'c',
    type: 'resistor',
    designator: 'R1',
    value: '10k',
    pins: [
        { pinId: '1', netId: 'vin' },
        { pinId: '2', netId: 'gnd' },
    ],
    ...over,
});

const baseCircuit = (components: Component[], extraNets: Array<{ id: string; name: string; isGround?: boolean }> = []): CircuitJson => ({
    version: '1.0',
    components,
    nets: [
        { id: 'vin', name: 'VIN' },
        { id: 'gnd', name: 'GND-RAIL', isGround: true },
        ...extraNets,
    ],
});

const generate = (circuit: CircuitJson, ui?: UiJson) =>
    generateTscircuitCode(circuit, ui, classifyCircuit(circuit), {});

describe('sanitizeName / buildNetNames', () => {
    it('sanitizes designators into JSX-safe tokens', () => {
        expect(sanitizeName('R1')).toBe('R1');
        expect(sanitizeName('R-1 a')).toBe('R_1_a');
        expect(sanitizeName('1R')).toBe('X1R');
    });

    it('ground nets normalize to GND; numeric names get an N prefix; collisions uniquify', () => {
        const names = buildNetNames({
            version: '1',
            components: [],
            nets: [
                { id: 'a', name: 'out!', isGround: false },
                { id: 'b', name: 'OUT_' },
                { id: 'g', name: 'whatever', isGround: true },
                { id: 'n', name: '123' },
            ],
        });
        expect(names.g).toBe('GND');
        expect(names.n).toBe('N123');
        expect(names.a).not.toBe(names.b); // OUT_ collision -> uniquified
    });
});

describe('generateTscircuitCode', () => {
    it('emits elements + one trace per pin to the NAMED net, and matching expectations', () => {
        const r = generate(baseCircuit([comp({})]));
        expect(r.code).toContain('<resistor name="R1"');
        expect(r.code).toContain('resistance={10000}'); // 10k parsed to a NUMBER (unit drift impossible)
        expect(r.code).toContain('footprint="0603"');
        expect(r.code).toContain('<trace from=".R1 > .pin1" to="net.VIN" />');
        expect(r.code).toContain('<trace from=".R1 > .pin2" to="net.GND" />');
        expect(r.expectations).toEqual([
            { name: 'R1', pinId: '1', selector: '.R1 > .pin1', netName: 'VIN' },
            { name: 'R1', pinId: '2', selector: '.R1 > .pin2', netName: 'GND' },
        ]);
    });

    it('maps semantic pins: transistor via UNIQUE single-letter hints (upstream word-alias collision), diode anode/cathode', () => {
        const r = generate(
            baseCircuit([
                comp({ designator: 'Q1', type: 'bjt', model: 'QGENPNP', value: undefined, pins: [{ pinId: 'c', netId: 'vin' }, { pinId: 'b', netId: 'gnd' }, { pinId: 'e', netId: 'vin' }] }),
                comp({ designator: 'D1', type: 'diode', value: undefined, pins: [{ pinId: 'anode', netId: 'vin' }, { pinId: 'cathode', netId: 'gnd' }] }),
            ]),
        );
        expect(r.code).toContain('type="pnp"');
        // single-letter selectors: tscircuit's word hints (base/emitter) are DUPLICATED across pins —
        // .Q1 > .base would bind ambiguously (real short caught by parity on 3 Tem 2026).
        expect(r.code).toContain('<trace from=".Q1 > .c" to="net.VIN" />');
        expect(r.code).toContain('<trace from=".Q1 > .b" to="net.GND" />');
        expect(r.code).toContain('<trace from=".D1 > .anode" to="net.VIN" />');
    });

    it('mosfet emits BOTH required creation props (channelType + mosfetMode)', () => {
        const r = generate(
            baseCircuit([
                comp({ designator: 'M1', type: 'mosfet', model: 'NMOSGEN', value: undefined, pins: [{ pinId: 'd', netId: 'vin' }, { pinId: 'g', netId: 'gnd' }, { pinId: 's', netId: 'gnd' }, { pinId: 'b', netId: 'gnd' }] }),
            ]),
        );
        expect(r.code).toContain('channelType="nmos" mosfetMode="enhancement"');
    });

    it('subckt chip pins follow the MODEL PORT ORDER (pin1..pinN), not the authored order', () => {
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                comp({
                    designator: 'U1',
                    type: 'subckt',
                    model: 'OPAMPGEN',
                    value: undefined,
                    // authored order DIFFERS from port order on purpose
                    pins: [
                        { pinId: 'vcc', netId: 'vin' },
                        { pinId: 'out', netId: 'out' },
                        { pinId: 'in-', netId: 'gnd' },
                        { pinId: 'in+', netId: 'vin' },
                        { pinId: 'vee', netId: 'gnd' },
                    ],
                }),
                comp({}),
            ],
            nets: [
                { id: 'vin', name: 'VIN' },
                { id: 'gnd', name: 'G', isGround: true },
                { id: 'out', name: 'OUT' },
            ],
            models: [{ name: 'OPAMPGEN', device: 'subckt', body: '...', ports: ['out', 'in+', 'in-', 'vcc', 'vee'] }],
        };
        const r = generateTscircuitCode(circuit, undefined, classifyCircuit(circuit), {});
        const exp = Object.fromEntries(r.expectations.filter((e) => e.name === 'U1').map((e) => [e.pinId, e.selector]));
        expect(exp['out']).toBe('.U1 > .pin1'); // port order, not authored order
        expect(exp['in+']).toBe('.U1 > .pin2');
        expect(exp['vcc']).toBe('.U1 > .pin4');
    });

    it('mosfet bulk on the SOURCE net is silently implicit; on a DIFFERENT net it warns (PCB010)', () => {
        const mos = (bulkNet: string) =>
            comp({
                designator: 'M1',
                type: 'mosfet',
                model: 'NMOSGEN',
                value: undefined,
                pins: [
                    { pinId: 'd', netId: 'vin' },
                    { pinId: 'g', netId: 'gnd' },
                    { pinId: 's', netId: 'gnd' },
                    { pinId: 'b', netId: bulkNet },
                ],
            });
        const same = generate(baseCircuit([mos('gnd')]));
        expect(same.diagnostics.some((d) => d.code === 'PCB010')).toBe(false);
        const diff = generate(baseCircuit([mos('vin')]));
        expect(diff.diagnostics.some((d) => d.code === 'PCB010')).toBe(true);
        // bulk never produces a trace/expectation either way (no physical pin on sot23)
        expect(same.expectations.filter((e) => e.name === 'M1')).toHaveLength(3);
    });

    it('unparseable passive value -> PCB008 warning and NO value prop (never a guessed number)', () => {
        const r = generate(baseCircuit([comp({ value: 'about-ten' })]));
        expect(r.code).not.toContain('resistance=');
        expect(r.diagnostics.some((d) => d.code === 'PCB008')).toBe(true);
    });

    it('board props injection point carries the fab profile attrs', () => {
        const circuit = baseCircuit([comp({})]);
        const r = generateTscircuitCode(circuit, undefined, classifyCircuit(circuit), {
            boardExtraProps: 'autorouter={{ local: true }} minTraceWidth={0.2}',
        });
        expect(r.code).toContain('<board width="20mm" height="20mm" autorouter={{ local: true }} minTraceWidth={0.2}>');
    });

    it('UiJson positions seed pcbX/pcbY (scaled, centered) when EVERY physical component has one', () => {
        const circuit = baseCircuit([comp({ designator: 'R1' }), comp({ designator: 'R2', pins: [{ pinId: '1', netId: 'vin' }, { pinId: '2', netId: 'gnd' }] })]);
        const ui: UiJson = { positions: { R1: { x: 0, y: 0 }, R2: { x: 100, y: 0, rotation: '90' } } };
        const r = generateTscircuitCode(circuit, ui, classifyCircuit(circuit), { boardWidthMm: 30, boardHeightMm: 20 });
        // R1 left of center, R2 right of center, symmetric
        expect(r.code).toMatch(/<resistor name="R1"[^>]*pcbX=\{-11\}/);
        expect(r.code).toMatch(/<resistor name="R2"[^>]*pcbX=\{11\}/);
        expect(r.code).toContain('pcbRotation={90}');
    });

    it('duplicate designators get uniquified emitted names (no silent overwrite)', () => {
        const r = generate(baseCircuit([comp({ id: 'a', designator: 'R1' }), comp({ id: 'b', designator: 'R1' })]));
        expect(r.code).toContain('name="R1"');
        expect(r.code).toContain('name="R1_2"');
    });
});
