/**
 * Circuit representation types
 * These types define the canonical format for circuit data
 */

/**
 * Main circuit JSON structure - the canonical representation
 */
export interface CircuitJson {
    version: string;
    components: Component[];
    nets: Net[];
    /** SPICE model/subckt definitions referenced by components' `model` field (active devices). */
    models?: ModelDef[];
    metadata?: CircuitMetadata;
}

/**
 * Circuit metadata
 */
export interface CircuitMetadata {
    name?: string;
    description?: string;
    author?: string;
    createdAt?: string;
    updatedAt?: string;
}

/**
 * Component types.
 *
 * The first group are SPICE-simulatable primitives: passives (R/L/C), sources (V/I), diode, ground,
 * and the active devices bjt (Q) and mosfet (M). Active devices are model-based — they reference a
 * `.model` by name (resolved from CircuitJson.models or an .include'd library). `subckt` (X) is a
 * multi-terminal device defined by a `.subckt` macromodel (e.g. an op-amp); its pins are variable-arity
 * and are emitted in the AUTHORED order, which MUST match the macromodel's port order. `generic` is a
 * catalog-only placeholder for a real part with no simulatable representation yet (logic ICs/MCUs,
 * connectors, sensors, …): it carries full catalog/sourcing metadata and renders on a schematic/BOM,
 * but is NOT emitted to the netlist. Test a component with `isSimulatable()` — never a hardcoded list.
 *
 * This `as const` tuple is the SINGLE SOURCE OF TRUTH: the `ComponentType` union derives from it and
 * the Zod `ComponentTypeSchema` is built from the same array, so the two can never drift.
 */
export const COMPONENT_TYPES = [
    'resistor',
    'capacitor',
    'inductor',
    'transformer',
    'tline',
    'voltage_source',
    'current_source',
    'vcvs',
    'vccs',
    'bsource',
    'switch',
    'diode',
    'zener',
    'bjt',
    'mosfet',
    'jfet',
    'subckt',
    // Digital / mixed-signal (XSPICE event-driven). Gates are variable-arity (in1..inN + out);
    // dff is a fixed-arity D flip-flop. All emit XSPICE 'a'-devices; the generator auto-inserts
    // analog<->digital bridges. See DIGITAL_PIN_ROLES + planMixedSignal in the netlist generator.
    'logic_and',
    'logic_or',
    'logic_nand',
    'logic_nor',
    'logic_xor',
    'logic_xnor',
    'logic_not',
    'logic_buffer',
    'dff',
    // Sequential/bus extensions (XSPICE, port orders live-verified on ngspice-41): JK and T flip-flops,
    // a level-sensitive D latch, and the tristate buffer (the one legitimate multi-driver bus element).
    'jkff',
    'tff',
    'dlatch',
    'tristate',
    'ground',
    'generic',
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

/**
 * A SPICE model definition (a `.model` card or `.subckt` body) referenced by name from a component's
 * `model` field. Lives at circuit level so a body is emitted once and shared across placements.
 */
export interface ModelDef {
    name: string; // referenced by Component.model, e.g. "QGENNPN"
    device: 'bjt' | 'mosfet' | 'jfet' | 'diode' | 'subckt' | 'switch' | 'digital';
    body: string; // the literal SPICE line(s): ".model QGENNPN NPN(...)" or ".subckt ... .ends"
    /** Fidelity of this model relative to the real part (Flux-style honesty). */
    tier?: 'manufacturer' | 'generic' | 'ideal';
    /**
     * For a `subckt`: the component pinIds in the macromodel's PORT order (i.e. matching the order of
     * the `.subckt` declaration line). When present, the generator binds nodes BY pinId in this order —
     * so the authored pin-array order no longer matters and a caller/LLM that supplies the right pins
     * in any order still nets correctly (mirroring the canonical ordering of bjt/mosfet). A subckt
     * whose model has no `ports` falls back to the authored pin-array order.
     */
    ports?: string[];
}

/**
 * Sourcing / catalog metadata for a real manufacturer part attached to a component.
 * Populated when a component is created from a distributor catalog (e.g. TME, DigiKey).
 */
export interface ComponentSourcing {
    supplier: string; // e.g. "tme"
    supplierId: string; // supplier's own part identifier (e.g. TME symbol)
    unitCost?: number; // price for quantity 1, in `currency`
    currency?: string; // e.g. "EUR"
    stock?: number; // available quantity at the supplier
    datasheetUrl?: string;
}

/**
 * Component definition
 */
export interface Component {
    id: string;
    type: ComponentType;
    designator: string; // R1, C1, V1, etc.
    value?: string; // "10k", "100n", "5V", "SIN(0 1 1k)"
    model?: string; // For diodes, transistors - model name
    /** Fractional manufacturing tolerance (e.g. 0.05 = ±5%) used by Monte-Carlo yield analysis. */
    tolerance?: number;
    /** Provenance of `tolerance`: 'catalog' = a datasheet fact from the sourced real part; 'user' = the
     *  design/user stated it explicitly. Lets the robustness verdict disclose the tolerance basis honestly. */
    toleranceSource?: 'user' | 'catalog';
    pins: PinConnection[];
    properties?: Record<string, unknown>;
    // Optional real-part / catalog metadata (added when a component is created from a parts catalog)
    mpn?: string; // Manufacturer Part Number, e.g. "NE555P"
    manufacturer?: string; // e.g. "TEXAS INSTRUMENTS"
    footprint?: string; // package/case, e.g. "0603", "SOIC-8"
    sourcing?: ComponentSourcing;
}

/**
 * Pin connection - maps a component pin to a net
 */
export interface PinConnection {
    pinId: string;
    netId: string;
}

/**
 * Net (electrical connection)
 */
export interface Net {
    id: string;
    name: string;
    isGround?: boolean;
    /** Marks this net as a POWER/supply RAIL (e.g. VCC/VDD/+5V) — the designer's/AI's DECLARATION, mirroring
     *  `isGround`. It is INTENT to be validated, never settled fact: consumers must cross-check it against the
     *  topology (a source drives it) before acting, exactly as KiCad ERC validates a designer-placed power symbol.
     *  Unlocks supply-voltage corners (and, later, power-rail-aware checks). Absent = rail unmarked. */
    isPower?: boolean;
}

/**
 * The DRAWING: where things sit on the sheet, and how the wires between them are routed.
 *
 * WHY THIS IS A SEPARATE DOCUMENT FROM `CircuitJson`, and must stay one. Connectivity here is DECLARED —
 * a pin names its net — not inferred from coordinates. KiCad computes nets from wire geometry; copying that
 * would make our netlist, ERC and the whole layout pipeline depend on pixel positions, and a design would
 * change meaning when someone nudged a symbol.
 *
 * It also cannot live ON `CircuitJson`. The zod schemas are plain objects that STRIP unknown keys, and four
 * hot paths forward the parsed result rather than the raw input — AI generate, AI edit, simulate, netlist
 * export. Geometry placed there would be deleted, without an error, by the first "edit this circuit" round
 * trip. The separation is not tidiness; it is the only place the drawing survives.
 *
 * THE COST OF THE SPLIT, stated plainly: nothing checks that the drawing agrees with the netlist. A wire can
 * carry `netId: "N"` while its endpoints sit on pins bound to net "M" and no validator objects. The editor
 * is what must keep them in step, by translating every drawn wire into a change to the pin list — and that
 * is step five, not this one.
 */
export interface UiJson {
    /**
     * Which shape of this document you are reading.
     *
     * Present from the first version that has anything worth migrating. Absent means the original shape:
     * viewport + positions + wires with no ids, which is what the two rows in existence today hold.
     */
    schemaVersion?: 1;
    viewport?: Viewport;
    positions?: Record<string, Position>;
    wires?: Wire[];
    /**
     * The sheet this drawing is on.
     *
     * One sheet today, and the field exists anyway — a schematic that outgrows one page is ordinary, and
     * retrofitting a sheet id onto stored drawings later is a migration where adding it now is a default.
     * Nothing reads it yet, which is stated rather than implied.
     */
    sheetId?: string;
}

/** Viewport state. */
export interface Viewport {
    x: number;
    y: number;
    zoom: number;
}

/** A point on the sheet. No rotation — a coordinate is not an object with an orientation. */
export interface Point {
    x: number;
    y: number;
}

/**
 * Where a component sits on the sheet, and how it is oriented.
 *
 * CONSUMED OUTSIDE THE EDITOR: `pcb-core`'s adapter seeds PCB placement from `positions`, all-or-nothing,
 * scaling and re-centring the whole arrangement into the board. So these are SHEET coordinates in an
 * arbitrary unit, not millimetres, and changing that meaning is a cross-package break.
 */
export interface Position extends Point {
    // Quarter-turn rotation as a string enum — matches PositionSchema (the runtime validator), which
    // accepts only these literals. (Kept as strings, not numbers, so the type and the Zod schema agree.)
    rotation?: '0' | '90' | '180' | '270';
    /**
     * Flip the symbol about an axis. Routine in real schematics — an op-amp with its inputs on the right,
     * a connector facing the other way — and not expressible by rotation alone.
     *
     * Purely a DRAWING property: mirroring a symbol says nothing about which side of the board the part is
     * on, which is a placement fact and belongs to the layout. `pcb-core` correctly ignores it.
     */
    mirror?: 'x' | 'y';
}

/**
 * One drawn connection between two points on the sheet.
 *
 * `id` exists so a wire survives a save. Selecting, deleting and dragging a bend all work by array index
 * inside a session; nothing addressed by index survives a reload or a second tab, which is exactly when a
 * user notices that the editor has forgotten which wire they meant.
 *
 * `netId` is the ELECTRICAL truth, unchanged: this wire draws part of that net. The endpoints are the
 * drawing's own record of what it was attached to when it was drawn.
 */
export interface Wire {
    /** Stable across saves. Absent on drawings authored before wires had one. */
    id?: string;
    netId: string;
    points: Point[];
    /**
     * The pin each end terminates on, when it terminates on one at all.
     *
     * Recorded rather than recomputed from coordinates: geometric matching is exact until two pins coincide
     * after a move, until a T-junction puts three ends at one point, or until an endpoint is deliberately
     * left in mid-air — and then it silently attaches a wire to the wrong part. `null` says "this end is
     * attached to nothing", which is a real state and different from "we do not know".
     */
    from?: PinRef | null;
    to?: PinRef | null;
}

/** A reference to one terminal of one component, in the design's own vocabulary. */
export interface PinRef {
    componentId: string;
    pinId: string;
}

/**
 * Component pin definitions for each component type
 */
export const COMPONENT_PINS: Record<ComponentType, string[]> = {
    resistor: ['1', '2'],
    capacitor: ['1', '2'],
    inductor: ['1', '2'],
    // Two magnetically-coupled windings. Dotted terminals are p+ and s+ (same winding sense).
    transformer: ['p+', 'p-', 's+', 's-'],
    // Lossless transmission line: port A (a+,a-) and port B (b+,b-); characteristic impedance + delay.
    tline: ['a+', 'a-', 'b+', 'b-'],
    voltage_source: ['+', '-'],
    current_source: ['+', '-'],
    // Linear controlled sources: output pair (+,-) then the controlling voltage pair (c+,c-).
    vcvs: ['+', '-', 'c+', 'c-'], // SPICE E: V_out = gain * V(c+,c-)
    vccs: ['+', '-', 'c+', 'c-'], // SPICE G: I_out = gm  * V(c+,c-)
    bsource: ['+', '-'], // SPICE B: arbitrary behavioral source, V= / I= a math expression
    switch: ['+', '-', 'c+', 'c-'], // SPICE S: voltage-controlled switch across (+,-), sensed at (c+,c-)
    diode: ['anode', 'cathode'],
    zener: ['anode', 'cathode'], // SPICE D device; the breakdown voltage rides in `value`
    bjt: ['c', 'b', 'e'], // SPICE Q: collector base emitter (canonical node order)
    mosfet: ['d', 'g', 's', 'b'], // SPICE M: drain gate source bulk
    jfet: ['d', 'g', 's'], // SPICE J: drain gate source
    subckt: [], // variable arity — pins are emitted in AUTHORED order to match the .subckt port order
    // Logic gates are VARIABLE arity (like subckt): pins are `in1`..`inN` + `out` (not/buffer use a
    // single `in1`). The generator derives the input list from the authored pins, so `[]` here and a
    // custom ERC pin-shape check replaces the fixed pin-count check.
    logic_and: [],
    logic_or: [],
    logic_nand: [],
    logic_nor: [],
    logic_xor: [],
    logic_xnor: [],
    logic_not: [],
    logic_buffer: [],
    // D flip-flop (XSPICE d_dff): fixed XSPICE port order D CLK SET RST Q QB. set/rst are optional in
    // the authored circuit — the generator auto-ties an omitted one to the inactive (LOW) digital rail.
    dff: ['d', 'clk', 'set', 'rst', 'q', 'qb'],
    // JK flip-flop (XSPICE d_jkff, port order J K CLK SET RST Q NQ): J=K=1 toggles. set/rst optional.
    jkff: ['j', 'k', 'clk', 'set', 'rst', 'q', 'qb'],
    // T (toggle) flip-flop (XSPICE d_tff, port order T CLK SET RST Q NQ). set/rst optional.
    tff: ['t', 'clk', 'set', 'rst', 'q', 'qb'],
    // Level-sensitive D latch (XSPICE d_dlatch, port order DATA ENABLE SET RST Q NQ): transparent while
    // en is HIGH, holds on en LOW. set/rst optional.
    dlatch: ['d', 'en', 'set', 'rst', 'q', 'qb'],
    // Tristate buffer (XSPICE d_tristate, port order IN ENABLE OUT): drives `out` from `in1` while `en`
    // is HIGH, releases the net (high-Z) on en LOW — the one digital source allowed to SHARE a bus net.
    tristate: ['in1', 'en', 'out'],
    ground: ['1'],
    generic: [], // variable arity — pins come from the catalog part / schematic layer
};

/**
 * SPICE element prefixes for each component type
 */
export const SPICE_PREFIXES: Record<ComponentType, string> = {
    resistor: 'R',
    capacitor: 'C',
    inductor: 'L',
    transformer: '', // composite: expands to two L windings + a K coupling (handled before this map)
    tline: 'T', // lossless transmission line
    voltage_source: 'V',
    current_source: 'I',
    vcvs: 'E', // voltage-controlled voltage source
    vccs: 'G', // voltage-controlled current source
    bsource: 'B', // arbitrary behavioral source (expression-valued)
    switch: 'S', // voltage-controlled switch (model-based)
    diode: 'D',
    zener: 'D', // a Zener is the same SPICE diode device, with a breakdown (BV) model
    bjt: 'Q',
    mosfet: 'M',
    jfet: 'J', // SPICE J: junction FET
    subckt: 'X', // SPICE subcircuit instance call
    // Digital / mixed-signal: all XSPICE code-model instances use the 'A' prefix.
    logic_and: 'A',
    logic_or: 'A',
    logic_nand: 'A',
    logic_nor: 'A',
    logic_xor: 'A',
    logic_xnor: 'A',
    logic_not: 'A',
    logic_buffer: 'A',
    dff: 'A',
    jkff: 'A',
    tff: 'A',
    dlatch: 'A',
    tristate: 'A',
    ground: '', // Ground is a special case (node 0)
    generic: '', // Catalog-only — not emitted to SPICE
};

/**
 * Whether a component TYPE can be emitted to a SPICE netlist. Catalog-only `generic` parts are not
 * simulatable. (Active/model-based devices bjt/mosfet/subckt ARE simulatable types — they emit a
 * Q/M/X line; whether a specific one has a resolvable model is a separate concern surfaced by ERC.)
 * Prefer this over comparing `type` against a hardcoded list.
 */
export function isSimulatable(component: Pick<Component, 'type'>): boolean {
    return component.type !== 'generic';
}

/** The variable-arity XSPICE logic gates (pins `in1`..`inN` + `out`). */
const LOGIC_GATE_TYPES = new Set<ComponentType>([
    'logic_and',
    'logic_or',
    'logic_nand',
    'logic_nor',
    'logic_xor',
    'logic_xnor',
    'logic_not',
    'logic_buffer',
]);

/** Fixed-arity sequential elements (flip-flops + the latch) — share the dff emission/tie-off pattern. */
export const SEQUENTIAL_TYPES = new Set<ComponentType>(['dff', 'jkff', 'tff', 'dlatch']);

/** All digital / mixed-signal component types (gates + sequential + tristate) — emit XSPICE `a`-devices. */
const DIGITAL_TYPES = new Set<ComponentType>([...LOGIC_GATE_TYPES, ...SEQUENTIAL_TYPES, 'tristate']);

/** True for a single-input gate (only `logic_not` / `logic_buffer`) — emitted with a scalar input port. */
export function isSingleInputGate(type: ComponentType): boolean {
    return type === 'logic_not' || type === 'logic_buffer';
}

export function isLogicGateType(type: ComponentType): boolean {
    return LOGIC_GATE_TYPES.has(type);
}

/** True if the component participates in the digital domain (drives/reads XSPICE event nodes). */
export function isDigitalType(type: ComponentType): boolean {
    return DIGITAL_TYPES.has(type);
}

/**
 * Role of a digital component's pin on its net: a `source` DRIVES the net (gate `out`; flip-flop `q`/`qb`),
 * a `sink` READS it (gate inputs `in*`; flip-flop `d`/`clk`/`set`/`rst`). Drives the auto-bridging
 * (net classification + adc/dac direction) in the netlist generator. Returns null for non-digital types.
 */
export function digitalPinRole(type: ComponentType, pinId: string): 'source' | 'sink' | null {
    if (isLogicGateType(type)) return pinId === 'out' ? 'source' : 'sink';
    if (SEQUENTIAL_TYPES.has(type)) return pinId === 'q' || pinId === 'qb' ? 'source' : 'sink';
    if (type === 'tristate') return pinId === 'out' ? 'source' : 'sink';
    return null;
}
