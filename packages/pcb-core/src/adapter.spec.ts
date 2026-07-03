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

    it('MULTIPLE isGround nets merge onto ONE "GND" (SPICE node-0 semantics — no ground islands)', () => {
        const names = buildNetNames({
            version: '1',
            components: [],
            nets: [
                { id: 'g1', name: 'gnd', isGround: true },
                { id: 'g2', name: 'agnd', isGround: true },
            ],
        });
        expect(names.g1).toBe('GND');
        expect(names.g2).toBe('GND'); // merged, never GND_2
    });

    it('"GND" is RESERVED: a signal net named gnd cannot steal it from (or without) a real ground', () => {
        const names = buildNetNames({
            version: '1',
            components: [],
            nets: [
                { id: 'fake', name: 'GND' }, // signal net, listed FIRST
                { id: 'real', name: 'earth', isGround: true },
            ],
        });
        expect(names.real).toBe('GND');
        expect(names.fake).not.toBe('GND'); // pour/per-net rules can never attach to the signal net
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
        expect(r.code).toContain('channelType="n" mosfetMode="enhancement"'); // tscircuit enum is n|p, not nmos
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

    it('mosfet bulk pin never emits a trace/expectation (no SOT-23 pad); the diff-net POLICY lives in layoutability', () => {
        const mos = comp({
            designator: 'M1',
            type: 'mosfet',
            model: 'NMOSGEN',
            value: undefined,
            pins: [
                { pinId: 'd', netId: 'vin' },
                { pinId: 'g', netId: 'gnd' },
                { pinId: 's', netId: 'gnd' },
                { pinId: 'b', netId: 'gnd' },
            ],
        });
        const r = generate(baseCircuit([mos]));
        expect(r.expectations.filter((e) => e.name === 'M1')).toHaveLength(3); // d/g/s only
        expect(r.code).not.toContain('.M1 > .b'); // bulk emits nothing
        // policy diagnostic (PCB010, error-by-default) is layoutability's job now — see its spec
        expect(r.diagnostics.some((d) => d.code === 'PCB010')).toBe(false);
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

    it('generic catalog part with ALL-NUMERIC pinIds maps pinId -> PHYSICAL pad (pinN), not array position', () => {
        // sparse, out-of-order: pin "7" first, pin "3" second — positional mapping would miswire both
        const r = generate(
            baseCircuit([
                comp({
                    designator: 'U9',
                    type: 'generic',
                    footprint: 'SOIC-8',
                    value: undefined,
                    pins: [
                        { pinId: '7', netId: 'vin' },
                        { pinId: '3', netId: 'gnd' },
                    ],
                }),
                comp({}),
            ]),
        );
        const exp = Object.fromEntries(r.expectations.filter((e) => e.name === 'U9').map((e) => [e.pinId, e.selector]));
        expect(exp['7']).toBe('.U9 > .pin7'); // NOT pin1
        expect(exp['3']).toBe('.U9 > .pin3'); // NOT pin2
    });

    it('DIRECT_PIN_MAPS anchors: per-element port tokens are UNIQUE (a c->b style typo cannot pass silently)', () => {
        // structural guard for the parity shared-fate residue: each map's values must be distinct.
        const r = generate(
            baseCircuit([
                comp({ designator: 'Q1', type: 'bjt', model: 'Q', value: undefined, pins: [{ pinId: 'c', netId: 'vin' }, { pinId: 'b', netId: 'gnd' }, { pinId: 'e', netId: 'vin' }] }),
            ]),
        );
        const selectors = r.expectations.filter((e) => e.name === 'Q1').map((e) => e.selector);
        expect(new Set(selectors).size).toBe(selectors.length);
    });

    it('degenerate UiJson (all positions identical) falls back to the grid — never stacks parts', () => {
        const circuit = baseCircuit([comp({ designator: 'R1' }), comp({ designator: 'R2', pins: [{ pinId: '1', netId: 'vin' }, { pinId: '2', netId: 'gnd' }] })]);
        const ui: UiJson = { positions: { R1: { x: 50, y: 50 }, R2: { x: 50, y: 50 } } };
        const r = generateTscircuitCode(circuit, ui, classifyCircuit(circuit), {});
        const xs = [...r.code.matchAll(/pcbX=\{([-\d.]+)\}/g)].map((m) => Number(m[1]));
        expect(new Set(xs).size).toBeGreaterThan(1); // grid spread, not a single stacked point
    });

    it('explicit small board dims shrink the grid pitch (parts stay inside the outline)', () => {
        const many = Array.from({ length: 9 }, (_, i) =>
            comp({ id: `r${i}`, designator: `R${i + 1}`, pins: [{ pinId: '1', netId: 'vin' }, { pinId: '2', netId: 'gnd' }] }),
        );
        const circuit = baseCircuit(many);
        const r = generateTscircuitCode(circuit, undefined, classifyCircuit(circuit), { boardWidthMm: 20, boardHeightMm: 20 });
        const coords = [...r.code.matchAll(/pcb[XY]=\{([-\d.]+)\}/g)].map((m) => Math.abs(Number(m[1])));
        // 3x3 grid on a 20mm board with 4mm margins: every coordinate within ±6mm
        expect(Math.max(...coords)).toBeLessThanOrEqual(6.01);
    });
});
