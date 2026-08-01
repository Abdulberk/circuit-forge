/**
 * The shape of a laid-out board, as a CONTRACT — types only, zero dependencies, browser-safe.
 *
 * WHY THIS PACKAGE EXISTS. These types were declared inside `@circuit-forge/pcb-core`, which is the right
 * home for the code that PRODUCES them and the wrong home for anything that merely reads them. pcb-core
 * pulls `@tscircuit/eval`, `@tscircuit/footprinter`, `circuit-json-to-gerber`, `circuit-json-to-kicad` and
 * `dsn-converter` — an evaluator, a footprint library and three format converters, none of which belong in
 * a browser bundle and all of which exist precisely because pcb-core is the boundary that confines them to
 * the server.
 *
 * So an editor that wanted `LayoutGeometry` had one option: depend on pcb-core, and drag that entire
 * surface behind it. The boundary would have inverted by accident, on the first import, and been very
 * expensive to reverse afterwards. Splitting the declarations out first makes the dependency impossible
 * rather than discouraged.
 *
 * WHAT IS AND IS NOT HERE. Types only. `shapeLayoutResult`, `parseDrcReport`, `drcToChecks` and
 * `airwiresFromDrc` stay in pcb-core: they read the evaluated tscircuit soup and KiCad's report, so they
 * are producers, and a producer belongs with its tools. pcb-core re-exports everything below, so every
 * existing consumer keeps importing from exactly where it did.
 *
 * NO RUNTIME CODE, EVER. If a value, a schema or a helper ever wants to live here, that is the signal it
 * belongs in eda-core (which is already browser-safe, zod-only) or in the editor. A dependency-free
 * contract stays dependency-free only if the rule is absolute.
 */

export interface Pt {
    x: number;
    y: number;
}

export interface LayoutComponent {
    /** OUR CircuitJson component id when resolvable (cross-probe back to the user's design), else the emitted name. */
    id: string;
    designator: string;
    x: number;
    y: number;
    /** degrees */
    rotation: number;
    /** tscircuit footprinter string (e.g. "soic8"), or null if no cad_component. */
    footprint: string | null;
    /** body box (NOT the courtyard extent — use `courtyard` for collision/drag). */
    bodyWmm: number;
    bodyHmm: number;
    /** 3D body height (mm) from cad_component.position.z, or null. */
    heightMm: number | null;
    /** courtyard polygon (normalized from pcb_courtyard_rect OR pcb_courtyard_outline). */
    courtyard: Pt[];
    layer: string;
}

export interface LayoutPad {
    id: string;
    componentId: string;
    /** best-available pin reference for schematic cross-probe (source_port name / hint), or null. */
    pin: string | null;
    /**
     * OUR authored pinId for this pad ('1', '+', 'anode', 'c'…), or null when it could not be resolved.
     *
     * The delivered join between the design and the copper. Without it a consumer has to reconstruct
     * pcb-core's internal pin-name table from the outside, which works for the handful of component types
     * someone checked and silently mis-attributes for every other part in a catalog of any size.
     */
    sourcePin: string | null;
    /** emitted net name, or null for an unconnected / single-pin pad. */
    net: string | null;
    x: number;
    y: number;
    /** layers the pad sits on ("top" for SMD; ["top","bottom"] for a plated hole). */
    layers: string[];
    shape: string;
    wMm: number;
    hMm: number;
    /** through-hole drill (mm) for plated holes; null for SMD. */
    drillMm: number | null;
}

export interface LayoutTrace {
    id: string;
    /** Emitted net name. Resolved from the soup's `connection_name` (fast route) or, when the freerouting
     *  splice replaced the copper, from `source_trace_id`. Null only when the soup carries neither. */
    net: string | null;
    /** copper polylines split per layer (a trace can change layer via a via). */
    segments: Array<{ layer: string; widthMm: number; points: Pt[] }>;
}

export interface LayoutVia {
    id: string;
    x: number;
    y: number;
    drillMm: number;
    outerMm: number;
    fromLayer: string;
    toLayer: string;
    net: string | null;
}

export interface LayoutGeometry {
    board: { widthMm: number; heightMm: number; outline: Pt[] };
    layers: Array<{ name: string }>;
    components: LayoutComponent[];
    pads: LayoutPad[];
    traces: LayoutTrace[];
    vias: LayoutVia[];
}

/** One finding from the manufacturability check, as a client renders it. */
export interface DrcCheck {
    /** coarse group (the Reviews panel's sections); KiCad's exact type kept in `type`. */
    category: string;
    type: string;
    severity: string;
    message: string;
    /**
     * Where to point on the board, in the SAME frame as everything else here — or null.
     *
     * Null is a real answer and must be rendered as one. KiCad reports positions in its own page frame,
     * offset from the board frame (measured: +100 mm on both axes with Y negated on a 26 mm board), so a
     * raw report coordinate lands several board-widths away while looking like a plausible number. The
     * producer resolves it against our own pads and yields null when it cannot. "There is a problem, we
     * cannot point at it" is true; "the problem is over there" would not be.
     */
    location: Pt | null;
    /** component designators referenced by the entry. */
    refs: string[];
}

/** A connection the router did not make, drawn between OUR pad coordinates. */
export interface Airwire {
    net: string;
    from: Pt;
    to: Pt;
}
