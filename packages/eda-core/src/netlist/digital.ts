/**
 * Digital / mixed-signal (XSPICE) support for the netlist generator.
 *
 * Logic gates and flip-flops emit XSPICE event-driven `a`-devices (`d_and`, `d_dff`, …). Those live in
 * a separate digital simulation domain from the analog MNA solver, so any net that touches BOTH a digital
 * pin and an analog pin must be BRIDGED (adc_bridge analog→digital, dac_bridge digital→analog). This
 * module:
 *   - classifies every net (analog / pure-digital / mixed) from the pins on it,
 *   - splits a mixed net into an analog node (keeps the original sanitized name, so analog devices and
 *     buildNodeMap are untouched) + a fresh digital node, and synthesizes the right bridge,
 *   - synthesizes a constant digital-LOW rail to tie an unconnected flip-flop set/reset to its INACTIVE
 *     level (d_dff set/reset are active-HIGH — verified empirically on ngspice-41),
 *   - bridges each pure-digital net to an analog node for OBSERVATION (probing a raw digital event node
 *     is unreliable through `wrdata`; an analog column is deterministic),
 *   - emits the gate/flip-flop `a`-device lines.
 *
 * `planMixedSignal` is a NO-OP (everything empty) when the circuit has zero digital components, so an
 * analog-only netlist is byte-for-byte unchanged.
 */
import {
    type CircuitJson,
    type Component,
    isDigitalType,
    isLogicGateType,
    isSingleInputGate,
    digitalPinRole,
} from '../types/circuit';

/**
 * Built-in timing model (one per digital type) — v1 uses fixed sane delays; `value` overrides are PR2.
 * Names are NAMESPACED with a reserved `CFD_` prefix (Circuit-Forge Digital) so an engine-synthesized
 * model can never collide with a caller-supplied `ModelDef` (which now legitimately allows device:'digital'):
 * a generic name like `ADCBRIDGE`/`DLAND` was guessable and would hard-throw "Conflicting definitions".
 */
const DIGITAL_MODEL: Partial<Record<string, { name: string; card: string }>> = {
    logic_and: { name: 'CFD_AND', card: '.model CFD_AND d_and(rise_delay=1n fall_delay=1n input_load=0.5p)' },
    logic_or: { name: 'CFD_OR', card: '.model CFD_OR d_or(rise_delay=1n fall_delay=1n input_load=0.5p)' },
    logic_nand: { name: 'CFD_NAND', card: '.model CFD_NAND d_nand(rise_delay=1n fall_delay=1n input_load=0.5p)' },
    logic_nor: { name: 'CFD_NOR', card: '.model CFD_NOR d_nor(rise_delay=1n fall_delay=1n input_load=0.5p)' },
    logic_xor: { name: 'CFD_XOR', card: '.model CFD_XOR d_xor(rise_delay=1n fall_delay=1n input_load=0.5p)' },
    logic_xnor: { name: 'CFD_XNOR', card: '.model CFD_XNOR d_xnor(rise_delay=1n fall_delay=1n input_load=0.5p)' },
    logic_not: { name: 'CFD_NOT', card: '.model CFD_NOT d_inverter(rise_delay=1n fall_delay=1n input_load=0.5p)' },
    logic_buffer: { name: 'CFD_BUF', card: '.model CFD_BUF d_buffer(rise_delay=1n fall_delay=1n input_load=0.5p)' },
    // set/reset are active-HIGH (verified); ic defaults to 0 (Q starts low).
    dff: { name: 'CFD_DFF', card: '.model CFD_DFF d_dff(clk_delay=1n set_delay=1n reset_delay=1n rise_delay=1n fall_delay=1n)' },
};
const ADC_MODEL = { name: 'CFD_ADC', card: '.model CFD_ADC adc_bridge(in_low=0.8 in_high=2.0)' };
const DAC_MODEL = { name: 'CFD_DAC', card: '.model CFD_DAC dac_bridge(out_low=0 out_high=5)' };

export interface MixedSignalPlan {
    /** False when the circuit is analog-only — all fields below are empty (the generator is a no-op). */
    active: boolean;
    /** `${componentId}:${pinId}` -> digital node, for digital pins on a MIXED net (their analog twin keeps the net's node). */
    nodeOverride: Map<string, string>;
    /** Digital-LOW node to tie an unconnected flip-flop set/reset to (inactive level); null if none needed. */
    lowRailNode: string | null;
    /** `.model` cards to emit once (gate/ff timing + adc/dac bridges), pre-deduped. */
    modelCards: string[];
    /** Synthesized device lines (bridges + the constant-rail DC source). */
    deviceLines: string[];
    /** netId -> analog node a pure-digital net is bridged to FOR PROBING (probe this, not the raw digital node). */
    probeNodeForNet: Map<string, string>;
}

const EMPTY_PLAN: MixedSignalPlan = {
    active: false,
    nodeOverride: new Map(),
    lowRailNode: null,
    modelCards: [],
    deviceLines: [],
    probeNodeForNet: new Map(),
};

/** Sorted input pinIds of a gate: every pin matching `in<number>`, ascending. */
function gateInputPins(component: Component): string[] {
    return component.pins
        .map((p) => p.pinId)
        .filter((id) => /^in\d+$/i.test(id))
        .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

/** Per-net tally of the pins touching it, used for classification + bridge direction. */
interface NetRoles {
    analog: number;
    digitalSource: number;
    digitalSink: number;
}

export function planMixedSignal(
    circuit: CircuitJson,
    nodeMap: Map<string, string>,
    /** Lower-cased SPICE instance names of the real components, so synthesized device names avoid them. */
    usedDeviceNames: Set<string> = new Set(),
): MixedSignalPlan {
    if (!circuit.components.some((c) => isDigitalType(c.type))) return EMPTY_PLAN;

    // 1) Classify each net by the roles of the pins on it.
    const roles = new Map<string, NetRoles>();
    const bump = (netId: string, k: keyof NetRoles) => {
        const r = roles.get(netId) ?? { analog: 0, digitalSource: 0, digitalSink: 0 };
        r[k] += 1;
        roles.set(netId, r);
    };
    for (const c of circuit.components) {
        if (c.type === 'ground' || c.type === 'generic') continue; // not emitted; don't influence bridging
        const digital = isDigitalType(c.type);
        for (const pin of c.pins) {
            if (!digital) {
                bump(pin.netId, 'analog');
                continue;
            }
            const role = digitalPinRole(c.type, pin.pinId);
            bump(pin.netId, role === 'source' ? 'digitalSource' : 'digitalSink');
        }
    }

    // Name-uniqueness: synthesized NODES must not collide with any existing node (no dup-guard for nodes).
    const usedNodes = new Set<string>(nodeMap.values());
    const uniqueNode = (base: string): string => {
        let name = base;
        let n = 1;
        while (usedNodes.has(name)) name = `${base}_${n++}`;
        usedNodes.add(name);
        return name;
    };
    // Synthesized DEVICE names (bridges + the rail source) must not collide with a real component's emitted
    // instance name — the generator's dup-device guard would otherwise abort the run. These devices are
    // leaf/unreferenced (nothing names them back), so a collision-avoiding rename is always safe.
    const uniqueDevice = (base: string): string => {
        let name = base;
        let n = 1;
        while (usedDeviceNames.has(name.toLowerCase())) name = `${base}_${n++}`;
        usedDeviceNames.add(name.toLowerCase());
        return name;
    };

    const plan: MixedSignalPlan = {
        active: true,
        nodeOverride: new Map(),
        lowRailNode: null,
        modelCards: [],
        deviceLines: [],
        probeNodeForNet: new Map(),
    };
    const modelSet = new Set<string>(); // dedup model cards by their card text
    const addModel = (m: { name: string; card: string }) => {
        if (!modelSet.has(m.card)) {
            modelSet.add(m.card);
            plan.modelCards.push(m.card);
        }
    };
    // Gate/ff timing models for every digital type actually present.
    for (const c of circuit.components) {
        const m = DIGITAL_MODEL[c.type];
        if (m) addModel(m);
    }

    let synthN = 0;
    const dev = (line: string) => plan.deviceLines.push(line);

    // 2) Per net: decide digital node + bridges.
    //    The digital node for a pin lives in nodeOverride keyed by `${componentId}:${pinId}`.
    for (const [netId, r] of roles) {
        const hasDigital = r.digitalSource + r.digitalSink > 0;
        if (!hasDigital) continue; // pure analog — unchanged
        const analogNode = nodeMap.get(netId);
        if (!analogNode) continue; // net not in map (shouldn't happen)
        const mixed = r.analog > 0;

        if (!mixed) {
            // Pure-digital net: digital pins use the net's own node (= analogNode name, but it's a digital
            // event node since only digital devices touch it). Bridge it to a fresh analog node FOR PROBING.
            if (r.digitalSource > 0) {
                const probe = uniqueNode(`${analogNode}_p`);
                addModel(DAC_MODEL);
                dev(`${uniqueDevice(`axsyn${synthN++}`)} [${analogNode}] [${probe}] ${DAC_MODEL.name}`);
                plan.probeNodeForNet.set(netId, probe);
            }
            continue;
        }

        // Mixed net: digital pins get a fresh digital node; analog pins keep `analogNode`; bridge between them.
        const digNode = uniqueNode(`${analogNode}_d`);
        for (const c of circuit.components) {
            if (!isDigitalType(c.type)) continue;
            for (const pin of c.pins) {
                if (pin.netId === netId) plan.nodeOverride.set(`${c.id}:${pin.pinId}`, digNode);
            }
        }
        if (r.digitalSource > 0) {
            // Digital drives → DAC mirrors the digital node onto the analog node (analog pins read it).
            addModel(DAC_MODEL);
            dev(`${uniqueDevice(`axsyn${synthN++}`)} [${digNode}] [${analogNode}] ${DAC_MODEL.name}`);
        } else {
            // Analog drives digital sinks (e.g. a PULSE clock) → ADC samples the analog node to the digital node.
            addModel(ADC_MODEL);
            dev(`${uniqueDevice(`axsyn${synthN++}`)} [${analogNode}] [${digNode}] ${ADC_MODEL.name}`);
        }
    }

    // 3) Constant digital-LOW rail for unconnected flip-flop set/reset (active-HIGH → inactive = LOW).
    const needsLowRail = circuit.components.some(
        (c) => c.type === 'dff' && (!c.pins.some((p) => p.pinId === 'set') || !c.pins.some((p) => p.pinId === 'rst')),
    );
    if (needsLowRail) {
        const railAnalog = uniqueNode('dlogic_lo_a');
        const railDigital = uniqueNode('dlogic_lo');
        addModel(ADC_MODEL);
        dev(`${uniqueDevice(`vxsyn${synthN++}`)} ${railAnalog} 0 DC 0`);
        dev(`${uniqueDevice(`axsyn${synthN++}`)} [${railAnalog}] [${railDigital}] ${ADC_MODEL.name}`);
        plan.lowRailNode = railDigital;
    }

    return plan;
}

/** Emit one digital component (gate or flip-flop) as an XSPICE `a`-device line. Null if it can't be emitted. */
export function emitDigitalComponent(
    component: Component,
    nodeMap: Map<string, string>,
    plan: MixedSignalPlan,
): string | null {
    const inst = aInstanceName(component.designator);
    const nodeOf = (pinId: string): string | null => {
        const override = plan.nodeOverride.get(`${component.id}:${pinId}`);
        if (override) return override;
        const pin = component.pins.find((p) => p.pinId === pinId);
        if (!pin) return null; // pin absent → a shape error, surfaced by ERC (DIGITAL_PIN_SHAPE)
        const node = nodeMap.get(pin.netId);
        if (!node) {
            // A pin wired to an UNDECLARED net: mirror the analog path (componentToSpice / nodesForPinOrder),
            // which hard-throws rather than silently dropping the device from the netlist.
            throw new Error(`Net not found: ${pin.netId} for component ${component.designator} (${component.type})`);
        }
        return node;
    };

    if (isLogicGateType(component.type)) {
        const model = DIGITAL_MODEL[component.type];
        if (!model) return null;
        const out = nodeOf('out');
        if (!out) return null; // ERC flags a gate with no output
        const inputs = gateInputPins(component).map(nodeOf);
        if (inputs.length === 0 || inputs.some((n) => n === null)) return null; // ERC flags a gate with no/bad inputs
        // Single-input gates (not/buffer) take ONE scalar input port — emit only the first input node; an
        // over-connected not/buffer (>1 `in*`) is an authoring error flagged by ERC (DIGITAL_PIN_SHAPE), and
        // joining all of them here would shift the output/model columns into a malformed line. Multi-input
        // gates use bracket syntax.
        return isSingleInputGate(component.type)
            ? `${inst} ${inputs[0]} ${out} ${model.name}`
            : `${inst} [${inputs.join(' ')}] ${out} ${model.name}`;
    }

    if (component.type === 'dff') {
        const model = DIGITAL_MODEL.dff!;
        const d = nodeOf('d');
        const clk = nodeOf('clk');
        const q = nodeOf('q');
        const qb = nodeOf('qb');
        if (!d || !clk || !q || !qb) return null; // required pins missing → ERC flags it
        // set/reset are optional: an absent one is tied to the inactive (LOW) digital rail.
        const set = nodeOf('set') ?? plan.lowRailNode;
        const rst = nodeOf('rst') ?? plan.lowRailNode;
        if (!set || !rst) return null; // lowRailNode should exist when needed; guard defensively
        return `${inst} ${d} ${clk} ${set} ${rst} ${q} ${qb} ${model.name}`;
    }

    return null;
}

/** XSPICE 'a'-device instance name (mirrors generator.spiceInstanceName for prefix 'A'; avoids a circular import). */
export function aInstanceName(designator: string): string {
    const safe = designator.replace(/[^A-Za-z0-9_]/g, '');
    return /^a/i.test(safe) ? safe : `A${safe}`;
}
