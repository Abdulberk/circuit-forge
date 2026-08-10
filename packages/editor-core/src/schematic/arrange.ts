/**
 * Where the parts GO — which is what makes a schematic readable, and it is not the router's doing.
 *
 * The wires on a sheet can only be as short as the placement allows. Ours were placed in a square grid in
 * whatever order the components array happened to be in: `ceil(sqrt(n))` columns, filled by index, with the
 * netlist never consulted. On an eight-part ladder that put two parts of the SAME net 640 units apart at
 * opposite corners, and the router — correctly, honestly, at right angles — drew the long way round. The
 * drawing looked like a maze because it was one.
 *
 * WHAT THE FIELD ACTUALLY DOES. Real EDA tools do not auto-route schematics at all: in KiCad and Altium a
 * person draws them, so there is no industry autorouter to copy. Automated schematic drawing is a GRAPH
 * DRAWING problem, and the tools that do it — netlistsvg, d3-hwschematic — both reach for ELK's layered
 * algorithm: assign nodes to layers along the signal's direction, order within each layer to cut crossings,
 * then route orthogonally. tscircuit takes the other road, matching the netlist against a library of
 * hand-made templates. Templates give textbook-perfect results for circuits somebody has already drawn and
 * nothing for the rest; layering gives a decent answer for everything. This is the layered one.
 *
 * THE THREE STEPS, adapted to a schematic rather than a block diagram:
 *
 *  1. COLUMNS ARE SIGNAL FLOW. A schematic reads left to right, source to load, and that is a convention
 *     older than any of the tools. Sources are column 0 and everything else takes the column after the
 *     nearest thing feeding it.
 *  2. ROWS ARE FOR NOT CROSSING. Within a column, parts are ordered by the average row of what they connect
 *     to in the column before — the barycentre heuristic, swept until it settles. Crossings are what a
 *     reader has to untangle, and they cost more than length.
 *  3. RAILS ARE NOT EDGES. Ground and the supply rails are MARKED at each terminal, not wired, so treating
 *     them as connections would make every part adjacent to every other and the layering meaningless. They
 *     are the reason a schematic can be read as a flow at all.
 *
 * DETERMINISTIC, like everything else here: every tie is broken by id, so the same netlist is the same sheet
 * and a test can name the result.
 */

import { digitalPinRole, type CircuitJson, type Component } from '@circuit-forge/eda-core';

import { isPlaceablePart } from '../tree/object-tree';

/** Where a part sits in the reading order: which column, and which row within it. */
export interface Slot {
    column: number;
    row: number;
}

/** Types that START a signal rather than passing one along. They anchor the left edge. */
const SOURCES = new Set(['voltage_source', 'current_source', 'bsource']);

/**
 * Whether a pin DRIVES its net rather than reading it — the only place a schematic states a direction.
 *
 * A resistor has no such pin: current goes either way and no arrangement can know which. A logic gate does,
 * and so does a source, and that is enough to give a digital design its real depth. `digitalPinRole` is the
 * kernel's own answer for the gates and is asked rather than restated — a second table of which pin is an
 * output would be a second thing to keep in step with every part type ever added.
 */
const drivesTheNet = (type: Component['type'], pinId: string): boolean =>
    digitalPinRole(type, pinId) === 'source' || (SOURCES.has(type) && pinId === '+');

/**
 * The nets that JOIN parts, which is not all of them.
 *
 * A rail reaches half the design; counting it as a connection would put half the design in column 1 and say
 * nothing about how the circuit is read. They are drawn as marks at each terminal for exactly this reason.
 */
const joiningNets = (circuit: CircuitJson): Set<string> => {
    const rails = new Set((circuit.nets ?? []).filter((n) => n.isGround || n.isPower).map((n) => n.id));
    return new Set((circuit.nets ?? []).map((n) => n.id).filter((id) => !rails.has(id)));
};

/**
 * Lay the parts out in reading order.
 *
 * Returns a slot per placeable part. Markers are not here: they belong against the terminal they annotate,
 * which is a different question answered elsewhere.
 */
export function arrangeBySignalFlow(circuit: CircuitJson): Map<string, Slot> {
    const parts = (circuit.components ?? []).filter((c) => isPlaceablePart(c));
    if (parts.length === 0) return new Map();

    const joining = joiningNets(circuit);
    const netsOf = (c: Component) => c.pins.map((p) => p.netId).filter((id) => joining.has(id));

    // Who touches what, by net. Built once — the alternative is comparing every part against every other,
    // which is quadratic in the size of the sheet for an answer that is a grouping.
    const onNet = new Map<string, string[]>();
    for (const c of parts)
        for (const netId of new Set(netsOf(c))) onNet.set(netId, [...(onNet.get(netId) ?? []), c.id]);

    const neighbours = new Map<string, Set<string>>(parts.map((c) => [c.id, new Set<string>()]));
    for (const ids of onNet.values()) for (const a of ids) for (const b of ids) if (a !== b) neighbours.get(a)!.add(b);

    // ---- 1. Columns: how far along the signal a part sits ------------------------------------------
    //
    // Two rules, and the answer is whichever says the part is FURTHER along. Neither is enough alone, which
    // was measured on this product's own templates rather than argued:
    //
    //  - NEARNESS TO A SOURCE, breadth-first. It is all there is for an analogue circuit, where no pin
    //    states a direction, and it reads a divider or a filter correctly.
    //  - LONGEST PATH along the pins that DO state one. Breadth-first alone collapsed an 8-bit ALU — 135
    //    gates with a real carry chain — into FOUR columns with fifty-nine parts stacked in one of them,
    //    because its eighteen supplies touch everything and so everything looked one step from a source.
    //    Longest path puts a gate after ALL of its inputs, which is what depth means: 23 columns, widest 24.
    //
    // Taken alone, longest path is worse than useless on an analogue sheet — a resistor has no output pin,
    // so nothing has a predecessor and the whole design lands in column 0 (measured: the power amp went from
    // five columns to two). The maximum of the two is never worse than either on any template here, and on
    // the DDS it is better than both.
    const column = new Map<string, number>();
    const seeds = parts
        .filter((c) => SOURCES.has(c.type))
        .map((c) => c.id)
        .sort();
    const queue: string[] = [];
    /** Parts the sources never reach — each one the head of its own little graph. */
    const islands = new Set<string>();
    const start = (id: string) => {
        column.set(id, 0);
        queue.push(id);
    };
    seeds.forEach(start);

    // A circuit with no source at all — a fragment, a sub-sheet — still reads left to right from SOMEWHERE.
    // The most-connected part is the least arbitrary choice, and the id breaks the tie.
    if (queue.length === 0) {
        const busiest = [...parts].sort(
            (a, b) => neighbours.get(b.id)!.size - neighbours.get(a.id)!.size || a.id.localeCompare(b.id),
        )[0]!;
        start(busiest.id);
    }

    while (queue.length > 0) {
        const id = queue.shift()!;
        const next = column.get(id)! + 1;
        for (const other of [...neighbours.get(id)!].sort()) {
            if (column.has(other)) continue;
            column.set(other, next);
            queue.push(other);
        }
        // Everything reachable from this seed is placed; anything left is a separate island and starts its
        // own walk. Islands are POSITIONED afterwards, together, rather than each one taking a column of its
        // own — see below.
        if (queue.length === 0) {
            const stranded = parts.filter((c) => !column.has(c.id)).sort((a, b) => a.id.localeCompare(b.id))[0];
            if (stranded) {
                islands.add(stranded.id);
                column.set(stranded.id, 0);
                queue.push(stranded.id);
            }
        }
    }

    // ---- 1b. And how deep the DIRECTED pins say it is ----------------------------------------------
    //
    // A part comes after everything feeding it, which is what depth means. Cycles are real — a flip-flop
    // feeding back into its own logic is an ordinary circuit, not an error — so a node already being visited
    // reports zero and the walk unwinds rather than recurring forever.
    const drivenBy = new Map<string, string[]>();
    for (const c of parts)
        for (const pin of c.pins)
            if (joining.has(pin.netId) && drivesTheNet(c.type, pin.pinId))
                drivenBy.set(pin.netId, [...(drivenBy.get(pin.netId) ?? []), c.id]);

    const feeders = new Map<string, Set<string>>(parts.map((c) => [c.id, new Set<string>()]));
    for (const c of parts)
        for (const pin of c.pins) {
            if (!joining.has(pin.netId) || drivesTheNet(c.type, pin.pinId)) continue;
            for (const source of drivenBy.get(pin.netId) ?? []) if (source !== c.id) feeders.get(c.id)!.add(source);
        }

    const flowDepth = new Map<string, number>();
    const walking = new Set<string>();
    const depthOf = (id: string): number => {
        const known = flowDepth.get(id);
        if (known !== undefined) return known;
        if (walking.has(id)) return 0;
        walking.add(id);
        let deepest = 0;
        for (const f of feeders.get(id) ?? []) deepest = Math.max(deepest, depthOf(f) + 1);
        walking.delete(id);
        flowDepth.set(id, deepest);
        return deepest;
    };
    for (const c of parts) depthOf(c.id);

    // WHICHEVER SAYS FURTHER ALONG. Never worse than either rule alone on any of this product's templates,
    // and better than both on one of them.
    for (const c of parts) column.set(c.id, Math.max(column.get(c.id) ?? 0, flowDepth.get(c.id) ?? 0));

    // ---- 2. Rows: order within each column so the wires between columns cross as little as possible ----
    const columns: string[][] = [];
    for (const [id, col] of [...column].sort((a, b) => a[0].localeCompare(b[0]))) {
        (columns[col] ??= []).push(id);
    }
    for (let i = 0; i < columns.length; i++) columns[i] ??= [];

    const rowOf = new Map<string, number>();
    for (const col of columns) col.forEach((id, i) => rowOf.set(id, i));

    /**
     * The barycentre heuristic: put each part opposite the average of what it connects to on the side being
     * swept from. Four passes, alternating direction — it settles quickly on graphs this size, and running
     * it to a fixed point buys nothing a reader would notice.
     */
    const sweep = (from: 'left' | 'right') => {
        const order = from === 'left' ? [...columns.keys()] : [...columns.keys()].reverse();
        for (const ci of order) {
            const against = from === 'left' ? columns[ci - 1] : columns[ci + 1];
            if (!against || against.length === 0) continue;
            const rank = new Map(against.map((id, i) => [id, i]));
            const centre = (id: string) => {
                const seen = [...neighbours.get(id)!]
                    .map((n) => rank.get(n))
                    .filter((r): r is number => r !== undefined);
                // A part with nothing on that side keeps its place rather than being dragged to the top: it
                // has no opinion, and giving it one moves parts that do have one.
                return seen.length === 0 ? rowOf.get(id)! : seen.reduce((s, r) => s + r, 0) / seen.length;
            };
            columns[ci] = [...columns[ci]!].sort((a, b) => centre(a) - centre(b) || a.localeCompare(b));
            columns[ci]!.forEach((id, i) => rowOf.set(id, i));
        }
    };
    for (let pass = 0; pass < 2; pass++) {
        sweep('left');
        sweep('right');
    }

    // ---- 3. The answer ------------------------------------------------------------------------------
    const slots = new Map<string, Slot>();
    columns.forEach((col, ci) => col.forEach((id, ri) => slots.set(id, { column: ci, row: ri })));

    /**
     * The unwired parts, gathered into a BLOCK below the circuit instead of a ribbon beside it.
     *
     * A part dragged out of the palette is an island by construction — `addComponent` gives every pin its own
     * private net — so this is the ordinary state of a sheet somebody is building, not a corner case. Each
     * island used to take a column of its own with a blank one after it: measured, a thirteen-part template
     * went from 480 units wide to 3040 after eight palette adds, and a bank of twenty-six decoupling caps
     * arranged as fifty columns by one row. The sheet ran off the side of the screen and the part the user
     * had just added was the furthest thing from what they were looking at.
     *
     * Below rather than beside, because the connected design is what a reader reads and it stays where it
     * was; and in as square a block as the count allows, so the sheet grows in both directions rather than
     * one. They keep their own relative arrangement — two unwired parts that ARE joined to each other stay
     * adjacent, because an island is a little graph, not necessarily one part.
     */
    // WIRED TO NOTHING AT ALL — not merely "the sources never reached it".
    //
    // The first version of this rule used reachability, and it swallowed whole circuits: a two-stage
    // amplifier whose supply touches only the rails has NO signal-net neighbour for its source, so every
    // other part counted as an island and the arrangement collapsed into one column. A sub-graph that is
    // wired but unreached is still a circuit and still reads left to right; what has no neighbour at all is
    // a part somebody has just dragged out of the palette.
    const strayIds = parts.map((c) => c.id).filter((id) => (neighbours.get(id)?.size ?? 0) === 0);
    const stray = new Set(strayIds);
    if (strayIds.length > 0) {
        const connected = columns.map((col) => col.filter((id) => !stray.has(id)));
        const below = connected.length === 0 ? 0 : Math.max(0, ...connected.map((c) => c.length));
        const across = Math.max(1, Math.ceil(Math.sqrt(strayIds.length)));
        strayIds.forEach((id, i) => slots.set(id, { column: i % across, row: below + 1 + Math.floor(i / across) }));
    }
    // Every placeable part has a slot. A part that fell through would be drawn at the origin, on top of
    // whatever else is there, which is worse than any arrangement.
    for (const c of parts) if (!slots.has(c.id)) slots.set(c.id, { column: columns.length, row: 0 });
    return slots;
}
