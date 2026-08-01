/**
 * CircuitJson (+UiJson) -> tscircuit JSX source generation.
 *
 * We generate tscircuit CODE (a string) and let `@tscircuit/eval` run it headless — proven far
 * simpler than assembling their element-array by hand (Faz-0 PoC). Everything emitted here is
 * constructed from sanitized identifiers and numeric literals, so the string cannot escape the JSX
 * attribute grammar.
 *
 * The adapter also returns EXPECTATIONS — our pin->net partition, derived ONLY from our CircuitJson —
 * which the parity module later checks against tscircuit's evaluated output (approval condition 1).
 * Net connectivity is expressed as one `<trace from={pin} to="net.NAME" />` per pin, so tscircuit's
 * nets carry OUR names (GND normalization included) — that is what makes parity, the GND pour and the
 * Faz-3 per-net width constraints addressable by name.
 */
import type { CircuitJson, UiJson, Component } from '@circuit-forge/eda-core';
import { parseSpiceValue } from '@circuit-forge/eda-core';

import type { ComponentPlan, LayoutabilityResult, LayoutDiagnostic } from './layoutability';

export interface PinExpectation {
    /** Sanitized designator as emitted into the tscircuit code (e.g. "R1"). */
    name: string;
    /** OUR pinId (e.g. "anode", "c", "1"). */
    pinId: string;
    /** tscircuit port selector for this pin (e.g. ".Q1 > .collector"). */
    selector: string;
    /** Just the port half of the selector (e.g. "collector", "pin1"). Carried separately so a consumer
     *  joining OUR pinId to a rendered pad never has to parse the selector string back apart. */
    port: string;
    /** OUR (sanitized) net name this pin must land on. */
    netName: string;
}

export interface AdapterResult {
    code: string;
    expectations: PinExpectation[];
    /** our netId -> emitted net name (GND-normalized, sanitized, uniquified). */
    netNameById: Record<string, string>;
    /** our componentId -> emitted (sanitized, uniquified) name — deterministic across passes, so a
     *  placement computed against pass-1 names re-applies exactly on pass 2 (Lever 2 two-pass flow). */
    namesById: Record<string, string>;
    diagnostics: LayoutDiagnostic[];
    boardWidthMm: number;
    boardHeightMm: number;
}

export interface AdapterOptions {
    boardWidthMm?: number;
    boardHeightMm?: number;
    /** Extra attributes injected into the <board> tag (fab profile / autorouter config). */
    boardExtraProps?: string;
    /** Lever 2 direct-mm placement override, keyed by EMITTED name: coordinates are used VERBATIM
     *  (board-center mm) — unlike UiJson positions, which are schematic-space and get scaled/centered
     *  to fill the board. Parts absent from the map fall back to the normal placement path. */
    placementsById?: Record<string, { x: number; y: number; rotation?: number }>;
}

const MARGIN_MM = 4;
const GRID_PITCH_MM = 10;

// ---------------------------------------------------------------- identifiers

/** Sanitize a designator into a safe JSX name/selector token ([A-Za-z][A-Za-z0-9_]*). */
export function sanitizeName(raw: string): string {
    const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_');
    return /^[A-Za-z]/.test(cleaned) ? cleaned : `X${cleaned}`;
}

/** Net name: upper-cased sanitized name; numeric-only gets an N prefix. */
function baseNetName(net: { id: string; name: string }): string {
    const cleaned = (net.name || net.id).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
    return /^[A-Za-z]/.test(cleaned) ? cleaned : `N${cleaned}`;
}

/**
 * Assign emitted names to all nets. GROUND SEMANTICS mirror the SPICE generator: EVERY isGround net
 * maps to THE SAME "GND" name (the generator maps them all to node 0 — separate GND/GND_2 islands
 * would make the board differ from the verified circuit). "GND" is RESERVED: a signal net whose name
 * sanitizes to GND is renamed away so the pour and per-net rules can never attach to a signal net.
 */
export function buildNetNames(circuit: CircuitJson): Record<string, string> {
    const used = new Set<string>(['GND']); // reserved for ground, even when no ground net exists
    const byId: Record<string, string> = {};
    for (const net of circuit.nets) {
        if (net.isGround) byId[net.id] = 'GND'; // ALL grounds merge onto one name, like SPICE node 0
    }
    for (const net of circuit.nets) {
        if (net.isGround) continue;
        let name = baseNetName(net);
        let n = 2;
        while (used.has(name)) name = `${baseNetName(net)}_${n++}`;
        used.add(name);
        byId[net.id] = name;
    }
    return byId;
}

// ---------------------------------------------------------------- pin maps

/** Fixed pinId -> tscircuit port name maps for the direct elements. */
const DIRECT_PIN_MAPS: Record<string, Record<string, string>> = {
    resistor: { '1': 'pin1', '2': 'pin2' },
    capacitor: { '1': 'pin1', '2': 'pin2' },
    inductor: { '1': 'pin1', '2': 'pin2' },
    diode: { anode: 'anode', cathode: 'cathode' },
    led: { anode: 'anode', cathode: 'cathode' },
    // ⚠ tscircuit's transistor port_hints duplicate the WORD aliases across pins (pin2 hints contain
    // BOTH "base" and "emitter", pin3 likewise) — selecting ".Q1 > .base" bound base AND emitter to
    // ONE port and shorted VB/VE (caught by the parity check on day one). The SINGLE-LETTER hints are
    // unique per pin, so we address by letter. Parity's ambiguity guard (PCB025) keeps us honest if
    // upstream ever changes.
    transistor: { c: 'c', b: 'b', e: 'e' },
    mosfet: { d: 'drain', g: 'gate', s: 'source' }, // bulk handled specially below
    pinheader: { '+': 'pin1', '-': 'pin2' },
};

/** BJT/MOSFET polarity prop from the model name (QGENPNP -> pnp; IRF9... treat via 'p' hints). */
function transistorType(component: Component): string {
    return /pnp/i.test(component.model ?? '') ? 'pnp' : 'npn';
}
function mosfetChannel(component: Component): string {
    // tscircuit's mosfet channelType enum is 'n' | 'p' (NOT 'nmos'/'pmos' — that value is rejected at
    // component creation, breaking every mosfet; caught 3 Tem 2026 by the H-bridge gauntlet).
    return /(^|[^a-z])p(mos|chan)|pmos/i.test(component.model ?? '') ? 'p' : 'n';
}

/**
 * Chip pin order: subckt uses the macromodel port order when the ModelDef declares `ports` (the same
 * rule the SPICE generator binds by), else the authored pin order; jfet uses its canonical d,g,s.
 *
 * Returns null for a generic catalog part whose pinIds are ALL NUMERIC — those denote PHYSICAL pad
 * numbers ("3" means pad 3) and must map directly (pinId N -> pinN), NOT by array position: a sparse
 * or out-of-order pins array would otherwise wire nets to the wrong pads (review finding, 3 Tem).
 */
function chipPinOrder(component: Component, circuit: CircuitJson): string[] | null {
    if (component.type === 'jfet') return ['d', 'g', 's'];
    const model = circuit.models?.find((m) => m.name === component.model);
    if (component.type === 'subckt' && model?.ports?.length) return [...model.ports];
    if (component.type === 'generic' && component.pins.every((p) => /^\d+$/.test(p.pinId))) return null;
    return component.pins.map((p) => p.pinId);
}

// ---------------------------------------------------------------- placement

interface Placement {
    x: number;
    y: number;
    rotation?: number;
}

/**
 * Seed placements from UiJson (schematic positions scaled into the board area, relative arrangement
 * preserved) when EVERY physical component has one; otherwise a deterministic grid. Mixed seeding is
 * deliberately not attempted in v1 (documented simplification).
 */
function computePlacements(
    physical: ComponentPlan[],
    ui: UiJson | undefined,
    boardW: number,
    boardH: number,
): Map<string, Placement> {
    const out = new Map<string, Placement>();
    const positions = ui?.positions ?? {};
    const allPositioned = physical.length > 1 && physical.every((p) => positions[p.component.id]);

    if (allPositioned) {
        const pts = physical.map((p) => positions[p.component.id]!);
        const minX = Math.min(...pts.map((p) => p.x));
        const maxX = Math.max(...pts.map((p) => p.x));
        const minY = Math.min(...pts.map((p) => p.y));
        const maxY = Math.max(...pts.map((p) => p.y));
        const rawSpanX = maxX - minX;
        const rawSpanY = maxY - minY;
        // All points identical -> no arrangement to preserve; fall through to the grid (stacking every
        // component at one point would be unroutable). A single degenerate AXIS is fine: raw spans
        // center it at 0 instead of shoving it off by half a clamped span.
        if (rawSpanX > 0 || rawSpanY > 0) {
            const scale = Math.min(
                (boardW - 2 * MARGIN_MM) / Math.max(1, rawSpanX),
                (boardH - 2 * MARGIN_MM) / Math.max(1, rawSpanY),
            );
            for (const plan of physical) {
                const p = positions[plan.component.id]!;
                out.set(plan.component.id, {
                    x: round2((p.x - minX - rawSpanX / 2) * scale),
                    y: round2((p.y - minY - rawSpanY / 2) * scale),
                    rotation: p.rotation ? Number(p.rotation) : undefined,
                });
            }
            return out;
        }
    }

    const cols = Math.max(1, Math.ceil(Math.sqrt(physical.length)));
    const rows = Math.max(1, Math.ceil(physical.length / cols));
    // Respect an explicitly-sized board: shrink the pitch so the grid never places parts outside the
    // outline (auto-sized boards are derived FROM the default pitch, so they keep it).
    const pitch = Math.max(
        1,
        Math.min(
            GRID_PITCH_MM,
            (boardW - 2 * MARGIN_MM) / Math.max(1, cols - 1 || 1),
            (boardH - 2 * MARGIN_MM) / Math.max(1, rows - 1 || 1),
        ),
    );
    physical.forEach((plan, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        out.set(plan.component.id, {
            x: round2((col - (cols - 1) / 2) * pitch),
            y: round2((row - (rows - 1) / 2) * pitch),
        });
    });
    return out;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------- generation

export function generateTscircuitCode(
    circuit: CircuitJson,
    ui: UiJson | undefined,
    layout: LayoutabilityResult,
    opts: AdapterOptions = {},
): AdapterResult {
    const diagnostics: LayoutDiagnostic[] = [];
    const netNameById = buildNetNames(circuit);
    const physical = layout.plans.filter(
        (p) => p.role === 'direct' || p.role === 'chip-fallback' || p.role === 'connectorized',
    );

    const cols = Math.max(1, Math.ceil(Math.sqrt(physical.length)));
    const rows = Math.max(1, Math.ceil(physical.length / cols));
    const boardW = opts.boardWidthMm ?? Math.max(20, cols * GRID_PITCH_MM + 2 * MARGIN_MM);
    const boardH = opts.boardHeightMm ?? Math.max(20, rows * GRID_PITCH_MM + 2 * MARGIN_MM);

    const placements = computePlacements(physical, ui, boardW, boardH);
    const usedNames = new Set<string>();
    const namesById: Record<string, string> = {};
    const elementLines: string[] = [];
    const traceLines: string[] = [];
    const expectations: PinExpectation[] = [];

    for (const plan of physical) {
        const c = plan.component;
        let name = sanitizeName(c.designator);
        let n = 2;
        while (usedNames.has(name)) name = `${sanitizeName(c.designator)}_${n++}`;
        usedNames.add(name);
        namesById[c.id] = name;

        // Lever 2 direct-mm override (by emitted name): verbatim coordinates, no scaling/centering.
        const pos: Placement = opts.placementsById?.[name] ?? placements.get(c.id)!;
        const attrs: string[] = [`name="${name}"`];
        const element = plan.element!;

        if (plan.footprint) attrs.push(`footprint="${plan.footprint.footprint}"`);
        pushValueAttr(element, c, attrs, diagnostics);
        if (element === 'transistor') attrs.push(`type="${transistorType(c)}"`);
        // mosfet REQUIRES both props (component creation fails without them — probed 3 Tem 2026).
        if (element === 'mosfet') attrs.push(`channelType="${mosfetChannel(c)}" mosfetMode="enhancement"`);
        if (element === 'pinheader') attrs.push('pinCount={2}');
        attrs.push(`pcbX={${pos.x}} pcbY={${pos.y}}`);
        if (pos.rotation) attrs.push(`pcbRotation={${pos.rotation}}`);
        elementLines.push(`    <${element} ${attrs.join(' ')} />`);

        // pins -> traces to named nets + parity expectations
        const isChip = element === 'chip';
        const chipOrder = isChip ? chipPinOrder(c, circuit) : null;
        for (const pin of c.pins) {
            const port = portNameFor(element, pin.pinId, isChip, chipOrder, c, diagnostics);
            if (!port) continue; // declared-unmappable pin (e.g. mosfet bulk on the source net)
            const netName = netNameById[pin.netId];
            if (!netName) {
                diagnostics.push({
                    code: 'PCB007',
                    severity: 'warning',
                    componentId: c.id,
                    message: `${c.designator}.${pin.pinId} references unknown net "${pin.netId}" — pin left unconnected.`,
                });
                continue;
            }
            const selector = `.${name} > .${port}`;
            traceLines.push(`    <trace from="${selector}" to="net.${netName}" />`);
            expectations.push({ name, pinId: pin.pinId, selector, port, netName });
        }
    }

    const code = [
        'export default () => (',
        `  <board width="${boardW}mm" height="${boardH}mm"${opts.boardExtraProps ? ` ${opts.boardExtraProps}` : ''}>`,
        ...elementLines,
        ...traceLines,
        '  </board>',
        ')',
    ].join('\n');

    return { code, expectations, netNameById, namesById, diagnostics, boardWidthMm: boardW, boardHeightMm: boardH };
}

/** Value props for the passive elements — numeric (SI base units) so unit-spelling can never drift. */
function pushValueAttr(element: string, c: Component, attrs: string[], diagnostics: LayoutDiagnostic[]): void {
    const propByElement: Record<string, string> = {
        resistor: 'resistance',
        capacitor: 'capacitance',
        inductor: 'inductance',
    };
    const prop = propByElement[element];
    if (!prop) return;
    // eda-core's canonical parser returns a ParsedValue record ({value, isValid, ...}), never throws.
    const parsed = c.value !== undefined ? parseSpiceValue(c.value) : null;
    if (!parsed?.isValid || !Number.isFinite(parsed.value)) {
        diagnostics.push({
            code: 'PCB008',
            severity: 'warning',
            componentId: c.id,
            message: `${c.designator} has no parseable value ("${c.value ?? ''}") — ${prop} omitted; the board carries the footprint only.`,
        });
        return;
    }
    attrs.push(`${prop}={${parsed.value}}`);
}

/**
 * tscircuit port name for one of OUR pins. Chip elements address ports positionally (pin1..pinN in
 * the declared order); direct elements use their semantic names. Returns null for a pin that is
 * DECLARED unmapped (mosfet bulk tied to source); pushes a diagnostic when the unmapped pin would
 * change connectivity.
 */
function portNameFor(
    element: string,
    pinId: string,
    isChip: boolean,
    chipOrder: string[] | null,
    c: Component,
    diagnostics: LayoutDiagnostic[],
): string | null {
    if (isChip) {
        // Numeric-direct mapping (generic catalog part, all-numeric pinIds): pinId = the PHYSICAL pad
        // number, so "3" MUST land on pin3 — positional mapping would miswire sparse pin arrays.
        if (chipOrder === null) return `pin${pinId}`;
        const idx = chipOrder.indexOf(pinId);
        if (idx === -1) {
            diagnostics.push({
                code: 'PCB009',
                severity: 'warning',
                componentId: c.id,
                message: `${c.designator}.${pinId} is not in the chip pin order — left unconnected.`,
            });
            return null;
        }
        return `pin${idx + 1}`;
    }

    if (element === 'mosfet' && pinId === 'b') {
        // SOT-23 has no bulk pin: same-net-as-source is implicit; a DIFFERENT net was already judged
        // by layoutability (PCB010, error unless allowPartial) — either way the pin emits no trace.
        return null;
    }

    const map = DIRECT_PIN_MAPS[element];
    const port = map?.[pinId];
    if (!port) {
        diagnostics.push({
            code: 'PCB009',
            severity: 'warning',
            componentId: c.id,
            message: `${c.designator}.${pinId}: no ${element} port mapping — left unconnected.`,
        });
        return null;
    }
    return port;
}
