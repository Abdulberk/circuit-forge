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
 * Component types supported in MVP
 */
export type ComponentType =
    | 'resistor'
    | 'capacitor'
    | 'inductor'
    | 'voltage_source'
    | 'current_source'
    | 'diode'
    | 'ground';

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
    rotation?: number; // 0, 90, 180, 270
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
    voltage_source: ['+', '-'],
    current_source: ['+', '-'],
    diode: ['anode', 'cathode'],
    ground: ['1'],
};

/**
 * SPICE element prefixes for each component type
 */
export const SPICE_PREFIXES: Record<ComponentType, string> = {
    resistor: 'R',
    capacitor: 'C',
    inductor: 'L',
    voltage_source: 'V',
    current_source: 'I',
    diode: 'D',
    ground: '', // Ground is a special case (node 0)
};