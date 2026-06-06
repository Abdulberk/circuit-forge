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
    device: 'bjt' | 'mosfet' | 'jfet' | 'diode' | 'subckt' | 'switch';
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
}

/**
 * UI JSON structure for layout information
 */
export interface UiJson {
    viewport?: Viewport;
    positions?: Record<string, Position>;
    wires?: Wire[];
}

/**
 * Viewport state
 */
export interface Viewport {
    x: number;
    y: number;
    zoom: number;
}

/**
 * Component position
 */
export interface Position {
    x: number;
    y: number;
    // Quarter-turn rotation as a string enum — matches PositionSchema (the runtime validator), which
    // accepts only these literals. (Kept as strings, not numbers, so the type and the Zod schema agree.)
    rotation?: '0' | '90' | '180' | '270';
}

/**
 * Wire path for visual routing
 */
export interface Wire {
    netId: string;
    points: Position[];
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