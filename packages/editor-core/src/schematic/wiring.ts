/**
 * Drawn wires: the drawing is the user's document, and nothing redraws it behind their back.
 *
 * The netlist stays the electrical authority (simulation, PCB and AI read it). This module keeps the stored
 * wires and the netlist in step: a drawn wire becomes a connection in the same revision, and a netlist change
 * (an AI edit, a disconnect) never moves a part or reroutes a wire — it only shows what is not drawn yet.
 */
import type { CircuitJson, PinRef, Position, UiJson, Wire } from '@circuit-forge/eda-core';

import type { EditResult } from '../document/edits';
import { connectPins, splitNet } from '../document/nets';
import { isDrawnOnSheet, isPlaceablePart } from '../tree/object-tree';

import { bodiesOf, groundGlyphs, netsOf, placeParts, railGlyphs, type PlacedPart } from './layout';
import { orientSymbol } from './orient';
import { junctionsAt, routeSheet, segmentsOfWire, type Junction, type Point } from './route';
import { PIN_GRID, symbolFor, type SymbolPin } from './symbols';

/** A terminal where it sits on the sheet. */
export interface SheetPin {
    componentId: string;
    pinId: string;
    netId: string;
    x: number;
    y: number;
    side: SymbolPin['side'];
}

/** A connection the netlist has and the drawing does not show yet, drawn as a dashed line. */
export interface Airwire {
    netId: string;
    from: Point;
    to: Point;
}

/** A refusal shaped like an edit, so it reaches the same banner every other refusal does. */
const refusing = (message: string) => (): EditResult => ({ ok: false, reason: 'empty', message });

const snap = (v: number): number => Math.round(v / PIN_GRID) * PIN_GRID;
const pointKey = (x: number, y: number): string => `${x},${y}`;

/** True once a drawing owns its wires. `wires: []` counts: an empty sheet the user owns is still owned. */
export const isOwnedDrawing = (ui: UiJson | undefined): boolean => Array.isArray(ui?.wires);

/** Every terminal of every drawn part, at its stored position. */
export function sheetPins(circuit: CircuitJson, positions: Record<string, Position> | undefined): SheetPin[] {
    const out: SheetPin[] = [];
    for (const c of circuit.components ?? []) {
        const at = positions?.[c.id];
        if (!at || !isDrawnOnSheet(c)) continue;
        const symbol = orientSymbol(symbolFor(c), at);
        for (const pin of c.pins) {
            const sp = symbol.pins.find((q) => q.pinId === pin.pinId);
            if (sp)
                out.push({
                    componentId: c.id,
                    pinId: pin.pinId,
                    netId: pin.netId,
                    x: at.x + sp.x,
                    y: at.y + sp.y,
                    side: sp.side,
                });
        }
    }
    return out;
}

/** A drawn part's stored position, carrying the turn a marker was hung with. */
function positionOf(p: PlacedPart, stored: Position | undefined): Position {
    const turn = stored?.rotation ?? p.turn;
    return { ...stored, x: p.x, y: p.y, ...(turn && turn !== '0' ? { rotation: turn } : {}) };
}

function nextWireIds(wires: readonly Wire[], count: number): string[] {
    const taken = new Set(wires.map((w) => w.id));
    const out: string[] = [];
    for (let i = 1; out.length < count; i++) if (!taken.has(`w${i}`)) out.push(`w${i}`);
    return out;
}

/**
 * Draw a design that has no drawing yet, ONCE, and hand it over.
 *
 * AI and template designs arrive without wires. They are placed and routed here a single time; from then on
 * every position and every wire is stored, and nothing recomputes them. An owned drawing is returned as is.
 */
export function freezeDrawing(circuit: CircuitJson, ui: UiJson): UiJson {
    if (isOwnedDrawing(ui)) return ui;
    const placed = placeParts(circuit, ui.positions);
    const glyphs = groundGlyphs(circuit, placed);
    const rails = railGlyphs(circuit, placed);
    const routed = routeSheet(netsOf(circuit, placed), bodiesOf([...placed, ...glyphs, ...rails]));

    const positions: Record<string, Position> = {};
    for (const p of placed) positions[p.id] = positionOf(p, ui.positions?.[p.id]);

    const byPoint = new Map<string, SheetPin[]>();
    for (const pin of sheetPins(circuit, positions)) {
        const k = pointKey(pin.x, pin.y);
        byPoint.set(k, [...(byPoint.get(k) ?? []), pin]);
    }
    const endAt = (pt: Point, netId: string): PinRef | null => {
        const pin = (byPoint.get(pointKey(pt[0], pt[1])) ?? []).find((q) => q.netId === netId);
        return pin ? { componentId: pin.componentId, pinId: pin.pinId } : null;
    };

    const ids = nextWireIds([], routed.wires.length);
    const wires: Wire[] = routed.wires.map((w, i) => ({
        id: ids[i]!,
        netId: w.netId,
        points: w.points.map(([x, y]) => ({ x, y })),
        from: endAt(w.points[0]!, w.netId),
        to: endAt(w.points[w.points.length - 1]!, w.netId),
    }));
    return { ...ui, schemaVersion: 1, positions, wires };
}

// ---------------------------------------------------------------- geometry of stored wires

type XY = { x: number; y: number };

const pinKey = (ref: PinRef): string => JSON.stringify([ref.componentId, ref.pinId]);

function pinNets(circuit: CircuitJson): Map<string, string> {
    const out = new Map<string, string>();
    for (const c of circuit.components ?? [])
        for (const p of c.pins) out.set(pinKey({ componentId: c.id, pinId: p.pinId }), p.netId);
    return out;
}

/** Does this polyline pass through (or end on) the point? Exact integer arithmetic, no tolerance. */
export function wireTouches(points: readonly XY[], x: number, y: number): boolean {
    if (points.length === 1) return points[0]!.x === x && points[0]!.y === y;
    for (let i = 1; i < points.length; i++) {
        const [a, b] = [points[i - 1]!, points[i]!];
        if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) !== 0) continue;
        if (x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x) && y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y))
            return true;
    }
    return false;
}

const endsOf = (w: Wire): XY[] => (w.points.length ? [w.points[0]!, w.points[w.points.length - 1]!] : []);

/** Two wires of one net are one conductor when an end of either lies on the other: a joint or a T. */
const touching = (a: Wire, b: Wire): boolean =>
    endsOf(a).some((p) => wireTouches(b.points, p.x, p.y)) || endsOf(b).some((p) => wireTouches(a.points, p.x, p.y));

/** Drop repeated points and the middle of straight runs, so a wire is as few segments as it looks. */
export function tidyPoints(points: readonly XY[]): XY[] {
    const out: XY[] = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (last && last.x === p.x && last.y === p.y) continue;
        const prev = out[out.length - 2];
        if (prev && last) {
            const straight = (last.x - prev.x) * (p.y - last.y) - (last.y - prev.y) * (p.x - last.x) === 0;
            const forward = (last.x - prev.x) * (p.x - last.x) + (last.y - prev.y) * (p.y - last.y) > 0;
            if (straight && forward) out.pop();
        }
        out.push({ x: p.x, y: p.y });
    }
    return out;
}

/** Wires of one net that touch — one drawn conductor each — as lists of indexes into `wires`. */
function groupsOf(wires: readonly Wire[]): number[][] {
    const parent = wires.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (let i = 0; i < wires.length; i++)
        for (let k = i + 1; k < wires.length; k++)
            if (wires[i]!.netId === wires[k]!.netId && touching(wires[i]!, wires[k]!)) parent[find(i)] = find(k);
    const groups = new Map<number, number[]>();
    wires.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
    return [...groups.values()];
}

/**
 * Bring the drawing back in line with the netlist after ANY edit, without moving anything that exists.
 *
 * A wire on a part that is gone goes with it. A conductor takes the net its terminals are on, so a merge
 * relabels it; a wire still ending on a terminal that is now on ANOTHER net is dropped, because it would
 * state a connection the netlist no longer has. Parts with no position get a free spot; nothing else moves.
 */
export function syncDrawing(circuit: CircuitJson, ui: UiJson): UiJson {
    if (!isOwnedDrawing(ui)) return ui;
    const netOf = pinNets(circuit);
    const nets = new Set((circuit.nets ?? []).map((n) => n.id));
    const before = ui.wires!;
    const alive = before.map((w) => [w.from, w.to].every((end) => !end || netOf.has(pinKey(end))));
    const next: Array<Wire | null> = before.map((w, i) => (alive[i] ? w : null));

    for (const group of groupsOf(before.map((w, i) => (alive[i] ? w : { ...w, netId: '\u0000dead' })))) {
        if (!alive[group[0]!]) continue;
        const was = before[group[0]!]!.netId;
        const tally = new Map<string, number>();
        for (const i of group)
            for (const end of [before[i]!.from, before[i]!.to])
                if (end) tally.set(netOf.get(pinKey(end))!, (tally.get(netOf.get(pinKey(end))!) ?? 0) + 1);
        let net = was;
        if (tally.size > 0) {
            const most = Math.max(...tally.values());
            const tied = [...tally].filter(([, n]) => n === most).map(([id]) => id);
            net = tied.includes(was) ? was : tied.sort()[0]!;
        } else if (!nets.has(was)) {
            for (const i of group) next[i] = null; // a conductor on a net that no longer exists, touching nothing
            continue;
        }
        for (const i of group) {
            const w = before[i]!;
            const foreign = [w.from, w.to].some((end) => end && netOf.get(pinKey(end)) !== net);
            next[i] = foreign ? null : w.netId === net ? w : { ...w, netId: net };
        }
    }

    const wires = next.filter((w): w is Wire => w !== null);
    const same = wires.length === before.length && wires.every((w, i) => w === before[i]);
    return placeNewParts(circuit, same ? ui : { ...ui, wires });
}

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

function boxAt(c: Parameters<typeof symbolFor>[0], at: Position): Bounds {
    const b = orientSymbol(symbolFor(c), at).bounds;
    return { minX: at.x + b.minX, minY: at.y + b.minY, maxX: at.x + b.maxX, maxY: at.y + b.maxY };
}

/** Grid offsets in rings around the origin, nearest first, so a search tries close spots before far ones. */
function ringOffsets(maxRing: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let r = 1; r <= maxRing; r++)
        for (let j = -r; j <= r; j++)
            for (let i = -r; i <= r; i++) if (Math.max(Math.abs(i), Math.abs(j)) === r) out.push([i, j]);
    return out.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]) || q[0] - p[0] || p[1] - q[1]);
}
const RINGS = ringOffsets(40);

/**
 * A free spot for every drawn part that has no position yet — beside what it is wired to, never on top.
 *
 * The parts already placed are not touched. Before, adding one resistor re-arranged the whole sheet.
 */
export function placeNewParts(circuit: CircuitJson, ui: UiJson): UiJson {
    const parts = (circuit.components ?? []).filter((c) => isDrawnOnSheet(c));
    const missing = parts.filter((c) => !ui.positions?.[c.id]);
    if (missing.length === 0) return ui;

    const positions: Record<string, Position> = { ...ui.positions };
    const boxes = parts.filter((c) => positions[c.id]).map((c) => boxAt(c, positions[c.id]!));
    const rails = new Set((circuit.nets ?? []).filter((n) => n.isGround || n.isPower).map((n) => n.id));
    const step = 2 * PIN_GRID;
    const free = (b: Bounds): boolean =>
        boxes.every(
            (o) =>
                b.maxX + PIN_GRID <= o.minX ||
                b.minX - PIN_GRID >= o.maxX ||
                b.maxY + PIN_GRID <= o.minY ||
                b.minY - PIN_GRID >= o.maxY,
        );

    for (const c of missing) {
        const mine = new Set(c.pins.map((p) => p.netId).filter((n) => !rails.has(n) || !isPlaceablePart(c)));
        const neighbour = parts.find((o) => o.id !== c.id && positions[o.id] && o.pins.some((p) => mine.has(p.netId)));
        const own = symbolFor(c).bounds;
        const anchor: Position = neighbour
            ? { x: positions[neighbour.id]!.x, y: positions[neighbour.id]!.y }
            : boxes.length === 0
              ? { x: 0, y: 0 }
              : {
                    x: snap(Math.max(...boxes.map((b) => b.maxX)) + 4 * PIN_GRID - own.minX),
                    y: snap(Math.min(...boxes.map((b) => b.minY)) - own.minY),
                };
        let spot: Position = anchor;
        if (neighbour || !free(boxAt(c, anchor))) {
            const found = RINGS.map(([i, j]) => ({ x: anchor.x + i * step, y: anchor.y + j * step })).find((at) =>
                free(boxAt(c, at)),
            );
            // Past forty rings the sheet is crowded beyond reason; the right edge is always free.
            spot = found ?? { x: snap(Math.max(...boxes.map((b) => b.maxX)) + 4 * PIN_GRID - own.minX), y: anchor.y };
        }
        positions[c.id] = spot;
        boxes.push(boxAt(c, spot));
    }
    return { ...ui, schemaVersion: 1, positions };
}

// ---------------------------------------------------------------- moving parts

/** Move one end of a wire, letting the neighbouring bend absorb it so every segment stays at right angles. */
function moveEnd(points: readonly XY[], head: boolean, to: XY): XY[] {
    const out = points.map((p) => ({ x: p.x, y: p.y }));
    if (out.length < 2) return [to];
    const e = head ? 0 : out.length - 1;
    const n = head ? 1 : out.length - 2;
    const [was, near] = [out[e]!, out[n]!];
    const horizontal = was.y === near.y;
    const vertical = was.x === near.x && !horizontal;
    out[e] = { x: to.x, y: to.y };
    if (!horizontal && !vertical) return out; // a diagonal has no free coordinate: it moves as it is
    if (out.length === 2) {
        if (horizontal ? to.y === near.y : to.x === near.x) return out;
        const corner = horizontal ? { x: near.x, y: to.y } : { x: to.x, y: near.y };
        return [out[0]!, corner, out[1]!];
    }
    out[n] = horizontal ? { x: near.x, y: to.y } : { x: to.x, y: near.y };
    return out;
}

/**
 * New positions, with every wire end attached to a moved terminal following it.
 *
 * THE SAME FUNCTION previews a drag and commits it, so what is seen while dragging is what is stored on
 * release. A wire whose two ends move by the same amount travels whole; nothing else on the sheet changes.
 */
export function withPositions(circuit: CircuitJson, ui: UiJson, positions: Record<string, Position>): UiJson {
    if (!isOwnedDrawing(ui)) return { ...ui, schemaVersion: 1, positions };
    const ids = new Set(Object.keys(positions).filter((id) => positions[id] !== ui.positions?.[id]));
    if (ids.size === 0) return { ...ui, positions };
    const subset: CircuitJson = { ...circuit, components: (circuit.components ?? []).filter((p) => ids.has(p.id)) };
    const before = new Map(sheetPins(subset, ui.positions).map((p) => [pinKey(p), p]));
    const after = new Map(sheetPins(subset, positions).map((p) => [pinKey(p), p]));
    const delta = (end: PinRef | null | undefined): { from: XY; to: XY } | null => {
        if (!end) return null;
        const [a, b] = [before.get(pinKey(end)), after.get(pinKey(end))];
        return a && b && (a.x !== b.x || a.y !== b.y) ? { from: a, to: b } : null;
    };

    let touched = false;
    const wires = ui.wires!.map((w) => {
        const [h, t] = [delta(w.from), delta(w.to)];
        if (!h && !t) return w;
        touched = true;
        if (h && t && h.to.x - h.from.x === t.to.x - t.from.x && h.to.y - h.from.y === t.to.y - t.from.y) {
            const [dx, dy] = [h.to.x - h.from.x, h.to.y - h.from.y];
            return { ...w, points: w.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
        }
        let points = w.points;
        if (h) points = moveEnd(points, true, h.to);
        if (t) points = moveEnd(points, false, t.to);
        return { ...w, points: tidyPoints(points) };
    });
    return { ...ui, positions, ...(touched ? { wires } : {}) };
}

// ---------------------------------------------------------------- what is not drawn yet

/**
 * Connections the netlist has that no drawn wire shows — the dashed lines an AI edit leaves behind.
 *
 * Ground and supply rails are excluded: they are drawn as a symbol on every pin, never wired.
 */
export function airwires(circuit: CircuitJson, ui: UiJson): Airwire[] {
    if (!isOwnedDrawing(ui)) return [];
    const rails = railNets(circuit);
    const pins = sheetPins(circuit, ui.positions).filter((p) => !rails.has(p.netId));
    const find = drawnIslands(pins, ui.wires!);

    const out: Airwire[] = [];
    const byNet = new Map<string, number[]>();
    pins.forEach((p, i) => byNet.set(p.netId, [...(byNet.get(p.netId) ?? []), i]));
    for (const [netId, members] of byNet) {
        const islands = new Map<number, number[]>();
        for (const i of members) islands.set(find(i), [...(islands.get(find(i)) ?? []), i]);
        if (islands.size < 2) continue;
        // Shortest line from what is connected so far to a new island, until the net is one piece.
        const rest = [...islands.values()];
        const joined = rest.shift()!;
        while (rest.length > 0) {
            let best = { d: Infinity, g: 0, a: 0, b: 0 };
            for (const a of joined)
                rest.forEach((g, gi) => {
                    for (const b of g) {
                        const d = Math.abs(pins[a]!.x - pins[b]!.x) + Math.abs(pins[a]!.y - pins[b]!.y);
                        if (d < best.d) best = { d, g: gi, a, b };
                    }
                });
            out.push({ netId, from: [pins[best.a]!.x, pins[best.a]!.y], to: [pins[best.b]!.x, pins[best.b]!.y] });
            joined.push(...rest.splice(best.g, 1)[0]!);
        }
    }
    return out;
}

const railNets = (circuit: CircuitJson): Set<string> =>
    new Set((circuit.nets ?? []).filter((n) => n.isGround || n.isPower).map((n) => n.id));

/**
 * Which terminals the DRAWING joins: by a conductor of their own net, or by sitting on the same point.
 * Returns a find() over indexes into `pins`.
 */
function drawnIslands(pins: readonly SheetPin[], wires: readonly Wire[]): (i: number) => number {
    const index = new Map(pins.map((p, i) => [pinKey(p), i]));
    const parent = pins.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    const join = (a: number | undefined, b: number | undefined): void => {
        if (a !== undefined && b !== undefined) parent[find(a)] = find(b);
    };

    // Pins on one drawn conductor are joined — recorded ends, and any pin of the net a wire passes over.
    for (const group of groupsOf(wires)) {
        const net = wires[group[0]!]!.netId;
        const reached = pins
            .map((p, i) => ({ p, i }))
            .filter(({ p }) => p.netId === net && group.some((k) => wireTouches(wires[k]!.points, p.x, p.y)))
            .map(({ i }) => i);
        for (const k of group)
            for (const end of [wires[k]!.from, wires[k]!.to]) if (end) reached.push(index.get(pinKey(end))!);
        const known = reached.filter((i) => i !== undefined && pins[i]!.netId === net);
        for (let k = 1; k < known.length; k++) join(known[0], known[k]);
    }
    // Two terminals of one net on the same point are already joined.
    const at = new Map<string, number>();
    pins.forEach((p, i) => {
        const k = `${p.netId}@${p.x},${p.y}`;
        if (at.has(k)) join(at.get(k), i);
        else at.set(k, i);
    });
    return find;
}

// ---------------------------------------------------------------- drawing and deleting wires

/** What a wire gesture commits: kernel edits and the drawing change, as ONE revision. */
export interface WirePlan {
    label: string;
    edits: Array<(circuit: CircuitJson) => EditResult>;
    drawing: (ui: UiJson, created: readonly string[], circuit: CircuitJson) => UiJson;
}

/** A stored wire's address: its id, or its index for a drawing written before wires had ids. */
export const wireKey = (w: Wire, i: number): string => w.id ?? `#${i}`;

const keepDrawing = (ui: UiJson): UiJson => ui;

/** A drawn wire, as the canvas reports it: the clicked corners and the terminal under each end, if any. */
export interface WireDraft {
    points: XY[];
    from: PinRef | null;
    to: PinRef | null;
}

/**
 * Draw a wire, KiCad style: the line stays exactly where it was drawn and the netlist follows it.
 *
 * Each end lands on a terminal, on another wire (a T, joining that wire's net) or on nothing. Every net the
 * ends touch becomes one through `connectPins`, so its refusals (a ground-to-rail short) and its merge note
 * still apply.
 */
export function planWire(circuit: CircuitJson, ui: UiJson, draft: WireDraft): WirePlan {
    const label = 'Draw wire';
    const fail = (message: string): WirePlan => ({ label, edits: [refusing(message)], drawing: keepDrawing });
    // EXACTLY a PinRef. A caller may hand over a richer object (a SheetPin carries x, y, side, net), and the
    // server's strict schema refuses every unknown key — measured against the live API, the whole save 400'd.
    const ref = (p: PinRef | null): PinRef | null => (p ? { componentId: p.componentId, pinId: p.pinId } : null);
    draft = { points: draft.points, from: ref(draft.from), to: ref(draft.to) };
    const points = tidyPoints(draft.points);
    if (points.length < 2) return fail('A wire needs two different points.');
    for (let i = 1; i < points.length; i++)
        if (points[i]!.x !== points[i - 1]!.x && points[i]!.y !== points[i - 1]!.y)
            return fail('A wire runs at right angles.');

    const owned = freezeDrawing(circuit, ui);
    const pins = new Map(sheetPins(circuit, owned.positions).map((p) => [pinKey(p), p]));
    const reps = new Map<string, PinRef>(); // one terminal per net the wire touches
    const netsHit = new Set<string>();
    const ends = [
        { at: points[0]!, pin: draft.from },
        { at: points[points.length - 1]!, pin: draft.to },
    ];
    for (const end of ends) {
        if (end.pin) {
            const p = pins.get(pinKey(end.pin));
            if (!p) return fail('That terminal is not on the sheet any more.');
            if (p.x !== end.at.x || p.y !== end.at.y) return fail('The wire does not end on that terminal.');
            netsHit.add(p.netId);
            if (!reps.has(p.netId)) reps.set(p.netId, end.pin);
            continue;
        }
        const under = [
            ...new Set(owned.wires!.filter((w) => wireTouches(w.points, end.at.x, end.at.y)).map((w) => w.netId)),
        ];
        if (under.length > 1) return fail('Two nets cross here. End the wire on one of them.');
        if (under.length === 0) continue;
        netsHit.add(under[0]!);
        const pin = [...pins.values()].find((p) => p.netId === under[0]);
        if (pin && !reps.has(pin.netId)) reps.set(pin.netId, { componentId: pin.componentId, pinId: pin.pinId });
    }
    if (netsHit.size === 0) return fail('A wire has to start or end on a terminal or on another wire.');

    const joined = [...reps.values()];
    const edits = joined.slice(1).map((r) => (c: CircuitJson) => connectPins(c, joined[0]!, r));
    const drawing = (current: UiJson, _created: readonly string[], after: CircuitJson): UiJson => {
        const base = freezeDrawing(circuit, current);
        const final = joined.length ? pinNets(after).get(pinKey(joined[0]!))! : [...netsHit][0]!;
        const relabelled = base.wires!.map((w) =>
            netsHit.has(w.netId) && w.netId !== final ? { ...w, netId: final } : w,
        );
        const [id] = nextWireIds(relabelled, 1);
        return { ...base, wires: [...relabelled, { id: id!, netId: final, points, from: draft.from, to: draft.to }] };
    };
    return { label, edits, drawing };
}

/**
 * Delete wires, and with them the connections only they made.
 *
 * Deleting the one wire between two terminals parts them, as in every editor. Connections that were never
 * drawn (an AI's, shown dashed) are NOT split: only what the removed wire was holding together comes apart.
 * The biggest piece keeps the net's name; the others get new nets. Ground and rails are never split here —
 * their symbol is what connects them.
 */
export function planWireDeletion(circuit: CircuitJson, ui: UiJson, keys: readonly string[]): WirePlan {
    const label = keys.length === 1 ? 'Delete wire' : `Delete ${keys.length} wires`;
    const before = ui.wires ?? [];
    const doomed = new Set(keys);
    const gone = (w: Wire, i: number): boolean => doomed.has(wireKey(w, i));
    if (!before.some(gone)) return { label, edits: [], drawing: keepDrawing };
    const after = before.filter((w, i) => !gone(w, i));

    const rails = railNets(circuit);
    const affected = new Set(before.filter((w, i) => gone(w, i) && !rails.has(w.netId)).map((w) => w.netId));
    const pins = sheetPins(circuit, ui.positions).filter((p) => affected.has(p.netId));
    const [was, now] = [drawnIslands(pins, before), drawnIslands(pins, after)];

    const splits: PinRef[][] = [];
    const islands = new Map<number, number[]>();
    pins.forEach((_, i) => islands.set(was(i), [...(islands.get(was(i)) ?? []), i]));
    for (const members of islands.values()) {
        const pieces = new Map<number, number[]>();
        for (const i of members) pieces.set(now(i), [...(pieces.get(now(i)) ?? []), i]);
        if (pieces.size < 2) continue;
        const ordered = [...pieces.values()].sort((a, b) => b.length - a.length || a[0]! - b[0]!);
        for (const piece of ordered.slice(1))
            splits.push(piece.map((i) => ({ componentId: pins[i]!.componentId, pinId: pins[i]!.pinId })));
    }

    const edits = splits.map((take) => (c: CircuitJson): EditResult => {
        const net = pinNets(c).get(pinKey(take[0]!));
        return net ? splitNet(c, net, take) : refusing('A terminal on that wire is gone.')();
    });
    const drawing = (current: UiJson): UiJson => ({
        ...current,
        wires: (current.wires ?? []).filter((w, i) => !gone(w, i)),
    });
    return { label, edits, drawing };
}

/**
 * Where the drawing and the netlist disagree. Empty means in step — the property every test asserts.
 *
 * A wire must name a net that exists, end only on terminals of that net, and its two recorded ends must sit
 * on those terminals.
 */
export function drawingProblems(circuit: CircuitJson, ui: UiJson): string[] {
    if (!isOwnedDrawing(ui)) return [];
    const out: string[] = [];
    const nets = new Set((circuit.nets ?? []).map((n) => n.id));
    const pins = new Map(sheetPins(circuit, ui.positions).map((p) => [pinKey(p), p]));
    const wires = ui.wires!;
    wires.forEach((w, i) => {
        const name = wireKey(w, i);
        if (!nets.has(w.netId)) out.push(`${name}: net ${w.netId} does not exist`);
        for (const [end, at] of [
            [w.from, w.points[0]],
            [w.to, w.points[w.points.length - 1]],
        ] as const) {
            if (!end) continue;
            const p = pins.get(pinKey(end));
            if (!p) out.push(`${name}: ends on ${end.componentId}.${end.pinId}, which is not on the sheet`);
            else if (p.netId !== w.netId)
                out.push(`${name}: ends on ${end.componentId}.${end.pinId} of net ${p.netId}`);
            else if (!at || at.x !== p.x || at.y !== p.y)
                out.push(`${name}: end is not on ${end.componentId}.${end.pinId}`);
        }
    });
    return out;
}

/**
 * Wire ends that sit on ANOTHER net's wire — they read as a joint that the netlist does not have.
 *
 * Not an inconsistency (connectivity is declared, not inferred), and a user can make one by dragging. It is
 * a drawing that misleads, so the canvas marks these points rather than silently merging two nets.
 */
export function misleadingJoints(ui: UiJson): Array<{ x: number; y: number }> {
    const wires = ui.wires ?? [];
    const out = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < wires.length; i++)
        for (const p of endsOf(wires[i]!))
            for (let k = 0; k < wires.length; k++)
                if (k !== i && wires[k]!.netId !== wires[i]!.netId && wireTouches(wires[k]!.points, p.x, p.y))
                    out.set(pointKey(p.x, p.y), { x: p.x, y: p.y });
    return [...out.values()];
}

/** Where stored wires need a dot: three or more conductors of one net meeting, counting a pin's own lead. */
export function drawnJunctions(circuit: CircuitJson, ui: UiJson): Junction[] {
    if (!isOwnedDrawing(ui)) return [];
    const pins = sheetPins(circuit, ui.positions);
    const byNet = new Map<string, Point[][]>();
    for (const w of ui.wires!)
        byNet.set(w.netId, [...(byNet.get(w.netId) ?? []), w.points.map((p): Point => [p.x, p.y])]);
    return [...byNet].flatMap(([netId, lines]) =>
        junctionsAt(
            lines.flatMap((pts) => segmentsOfWire(pts)),
            netId,
            (x, y) => pins.filter((p) => p.netId === netId && p.x === x && p.y === y).map((p) => p.side),
        ),
    );
}
