'use client';

/**
 * The first surface in this product that DRAWS the design.
 *
 * Everything until now addressed the circuit as a list: a tree of names, a panel of fields. That is enough
 * to change a value and not enough to understand a circuit — an engineer reads topology by looking at it,
 * and a user who adds a MOSFET and sees a new row in a tree has no way to tell whether the thing they built
 * is the thing they meant.
 *
 * NOTHING HERE INVENTS GEOMETRY. `symbolFor` in editor-core has produced strokes, pin positions and label
 * anchors all along and no screen ever called it; this is that library reaching a canvas. A renderer that
 * drew its own resistor would be a second authority about what a resistor looks like, and the one place the
 * two disagreed would be the part nobody could find.
 *
 * NOR DOES IT DECIDE WHERE ANYTHING GOES. Placement and routing both live in the kernel: `placeParts` says
 * where each symbol sits, `routeSheet` says where every wire runs and where a junction needs a dot. Those
 * are claims about the NETLIST — which terminals are one node, and what a drawing is allowed to state — and
 * they belong where the netlist rules live, not in the part of the product that gets rewritten for the next
 * renderer. This file turns them into SVG and handles the pointer. That is the whole of its job.
 *
 * WHAT IT DELIBERATELY IS NOT, so nobody reads more into it than it says:
 *
 *   • It shows the SCHEMATIC, not the board. Board geometry is a different document with its own frame, and
 *     conflating the two is the confusion this codebase already documents in `UiJson.positions`.
 *   • It does not re-route while a part is being dragged. Routing a whole sheet takes tens of milliseconds
 *     and a gesture is sixty frames a second, so during a drag the wires that touch the moved part are
 *     RUBBER-BANDED — the end that moved follows the pointer and the rest stays put — and the sheet is
 *     routed properly once, on drop. They used to stay where they were for the whole gesture, so a part
 *     could be dragged clear across the sheet while its wires pointed at where it had been.
 */
import { nextTurn, rotationField, toDegrees, type CircuitJson, type UiJson } from '@circuit-forge/eda-core';
import {
    buildObjectTree,
    PIN_GRID,
    placeParts,
    bodiesOf,
    netsOf,
    routeSheet,
    type PlacedPart,
    type TreeNode,
} from '@circuit-forge/editor-core';
import { useEffect, useMemo, useRef, useState } from 'react';

import { isTextEntry } from '../lib/useUndoShortcuts';

/** Clear sheet around the drawing, so nothing is drawn hard against the edge of the view. */
const VIEW_MARGIN = 24;

/** Snap a sheet coordinate onto the pin lattice, so a dropped part lands where a wire can reach it. */
const snapToGrid = (v: number): number => Math.round(v / PIN_GRID) * PIN_GRID;

type Placed = PlacedPart;

export function SchematicCanvas({
    circuit,
    ui,
    selectedPath,
    onSelect,
    onArrange,
}: {
    circuit: CircuitJson;
    /**
     * The drawing, as the document carries it — not a hand-written subset of it.
     *
     * A structural type naming just `positions` reads as a narrow dependency and behaves as a second
     * definition of what a drawing is: the day `Position` grows a field this component needs, it type-checks
     * against a shape that no longer matches the one being stored.
     */
    ui?: UiJson;
    selectedPath?: string | null;
    onSelect?: (node: TreeNode | null) => void;
    /**
     * Commit a new drawing as ONE revision. Omitted makes the canvas read-only, which is what every test
     * that is not about dragging wants.
     */
    onArrange?: (label: string, next: UiJson) => void;
}) {
    const svgRef = useRef<SVGSVGElement | null>(null);
    /**
     * The gesture in flight, and it lives HERE rather than in the document — measured, not preferred.
     *
     * Routing sixty pointer-moves through `commitUi` does not merely mint sixty revisions. The history is
     * bounded at fifty, so a single drag EVICTS EVERY EARLIER REVISION: Ctrl+Z then walks the symbol back
     * one pixel at a time for fifty presses and the edit you actually wanted to undo is gone for good. And
     * each call resets the local-persist timer as well as the save timer, so nothing is written to the
     * device for as long as the mouse is down — which is exactly the window in which a crash costs most.
     *
     * So the document is untouched for the whole gesture. `origin` is captured from what is currently ON
     * SCREEN, which for an un-arranged design is the computed fallback rather than a stored position — the
     * only way a first drag has a number to add a delta to.
     */
    const [drag, setDrag] = useState<{
        pointerId: number;
        ids: readonly string[];
        origin: Record<string, { x: number; y: number }>;
        /** Where the pointer went DOWN, in client pixels — the delta is measured from here, every frame. */
        from: { x: number; y: number };
        dx: number;
        dy: number;
        moved: boolean;
    } | null>(null);

    const { placed, routed, extent, byPath } = useMemo(() => {
        const placed = placeParts(circuit, ui?.positions);

        /**
         * The wires, ROUTED IN THE KERNEL rather than drawn here.
         *
         * This file used to lay them out itself, as straight lines from the first terminal on each net to
         * every other. That is honest and unreadable: a real schematic runs at right angles, and turning
         * diagonals into right angles introduces a hazard diagonals do not have — two axis-aligned wires
         * along the same line are indistinguishable from one wire, and a wire crossing a terminal is
         * indistinguishable from a wire connected to it. Getting that right is a claim about the NETLIST,
         * so it belongs where the netlist rules live, not in the part of the product that will be rewritten
         * for the next renderer.
         *
         * Nets with a single terminal are drawn as nothing, and that is the correct depiction: the bare pin
         * IS the symbol for an unconnected terminal, and ERC reports it in those words.
         */
        const routed = routeSheet(netsOf(circuit, placed), bodiesOf(placed));

        // HALF the extent on each side of the centre, because `width`/`height` are FULL extents — the size
        // of the whole symbol, scanned from its own strokes and pins. This file used to read them both
        // ways, 73 lines apart: as a full extent when sizing a grid cell above, and as a half extent here,
        // which inflated the sheet by a factor of two in each axis and drew everything at half size inside
        // a viewBox with dead margin on two sides. The library's docstring said half while every producer
        // returned full, so both readings had something to point at. There is one meaning now.
        const xs = placed.flatMap((p) => [p.x - p.symbol.width / 2, p.x + p.symbol.width / 2]);
        const ys = placed.flatMap((p) => [p.y - p.symbol.height / 2, p.y + p.symbol.height / 2]);
        // From the true MINIMUM, not from zero. A part dragged to a negative coordinate — which stored
        // positions make ordinary — sat outside a viewBox anchored at the origin and was simply not on
        // screen, with nothing to indicate the sheet had been cropped.
        const minX = Math.min(...xs, 0);
        const minY = Math.min(...ys, 0);
        const extent = {
            x: minX - VIEW_MARGIN,
            y: minY - VIEW_MARGIN,
            w: Math.max(200, Math.max(...xs) - minX + VIEW_MARGIN * 2),
            h: Math.max(160, Math.max(...ys) - minY + VIEW_MARGIN * 2),
        };

        // The tree is the selection authority; the canvas resolves through it rather than minting its own
        // node shape, so clicking a symbol and clicking its row select the identical object.
        const byPath = buildObjectTree(circuit).byPath;
        return { placed, routed, extent, byPath };
    }, [circuit, ui?.positions]);

    /**
     * Screen pixels to sheet units.
     *
     * The viewBox scales, so a pointer delta in pixels is not a delta in sheet units. Computed from the
     * viewBox and the element's own box rather than from `getScreenCTM`, which is exact for the uniform
     * scaling `preserveAspectRatio` defaults to and — unlike the CTM — actually exists under jsdom, so the
     * drag can be tested at all rather than only demonstrated.
     */
    const toSheet = (px: number, py: number): [number, number] => {
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return [px, py];
        const scale = Math.max(extent.w / rect.width, extent.h / rect.height);
        return [px * scale, py * scale];
    };

    /**
     * `R` turns the selected part — the convention every schematic editor shares.
     *
     * IT LIVES HERE because this is the only place that knows where a part actually IS. `Position` requires
     * x and y, so a rotation cannot be written without them, and a part nobody has arranged has no stored
     * position — only the fallback this component computes. A hook outside the canvas would have to
     * re-derive that layout, which is the second-authority defect this codebase keeps paying for.
     *
     * ONE PRESS IS ONE REVISION, and the fourth press mints nothing: `rotationField` omits a zero rotation,
     * so the drawing after four turns is structurally equal to the one before the first, and the commit
     * kernel compares by value and declines it. Writing `rotation: '0'` explicitly would leave a revision
     * and a save behind for a part that visibly did not move.
     */
    useEffect(() => {
        if (!onArrange || !selectedPath) return;
        const id = selectedPath.split('/').pop();
        const part = placed.find((p) => p.id === id);
        if (!part) return; // the selection is a net, a pin, or something with no orientation

        const onKeyDown = (event: KeyboardEvent) => {
            // No modifiers: Ctrl+R is reload, Alt+R belongs to the browser's menus. A bare letter is the
            // convention, and taking the chorded versions would break something the user expects.
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key.toLowerCase() !== 'r') return;
            // The SAME guard the undo shortcut uses, imported rather than restated. `R` is a letter: without
            // it, typing a resistance of `4R7` in the Inspector would turn the part behind the panel.
            if (isTextEntry(event.target)) return;

            event.preventDefault();
            const at = ui?.positions?.[part.id];
            const turn = nextTurn(toDegrees(at?.rotation));
            // The rotation key is REPLACED, never merged past: `rotationField` returns `{}` at zero, and
            // spreading that over an existing `rotation: '270'` would leave the old value in place, so the
            // part would turn three times and then stick.
            const { rotation: _dropped, x: _x, y: _y, ...rest } = at ?? { x: part.x, y: part.y };
            onArrange(`Rotate ${part.designator}`, {
                ...ui,
                schemaVersion: 1,
                positions: {
                    ...ui?.positions,
                    // x and y come from where the part is ON SCREEN, which for an un-arranged design is the
                    // computed fallback. The schema requires them, so turning a part necessarily places it —
                    // exactly as dragging one does.
                    [part.id]: { x: part.x, y: part.y, ...rest, ...rotationField(turn) },
                },
            });
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [onArrange, selectedPath, placed, ui]);

    /**
     * Where a part is RIGHT NOW, which during a gesture is not where the document says.
     *
     * The offset is added at render time and nowhere else, so the drawing on screen and the drawing in the
     * document are the same object until the pointer comes up. Nothing to reconcile, and nothing to undo if
     * the gesture is cancelled — a cancelled drag is simply a piece of state that stopped existing.
     */
    const dragged = (p: Placed): { x: number; y: number } =>
        drag?.ids.includes(p.id) ? { x: p.x + drag.dx, y: p.y + drag.dy } : { x: p.x, y: p.y };

    const beginDrag = (e: React.PointerEvent, id: string) => {
        // Any button that is NOT a secondary one. Written as `> 0` rather than `!== 0` because a pointer
        // event that carries no `button` at all — a synthetic one, or a touch — is a primary press, and
        // `!== 0` silently refuses it. That is not a test artefact: it is the same class of guard that
        // refuses a real touch on a tablet, where nothing would report why dragging simply did not work.
        if (!onArrange || (e.button ?? 0) > 0) return;
        e.stopPropagation();
        (e.target as Element).setPointerCapture?.(e.pointerId);
        // Only the part under the pointer. Group drag arrives with multi-select; until then, moving one part
        // must not move anything else — and a selection the user cannot see is not a selection.
        const start = placed.find((p) => p.id === id);
        if (!start) return;
        setDrag({
            pointerId: e.pointerId,
            ids: [id],
            origin: { [id]: { x: start.x, y: start.y } },
            from: { x: e.clientX, y: e.clientY },
            dx: 0,
            dy: 0,
            moved: false,
        });
    };

    const moveDrag = (e: React.PointerEvent) => {
        // From the point the gesture STARTED, not by accumulating per-frame deltas.  is the
        // obvious alternative and the wrong one: it reports raw device movement, ignores pointer capture,
        // is inconsistent between browsers, and is absent entirely from a synthetic event — so a drag built
        // on it works in one browser, drifts in another, and cannot be tested at all. Measuring from the
        // origin also makes the gesture self-correcting: a dropped frame costs nothing, because the next
        // one recomputes the whole offset rather than adding to a total that has already lost something.
        const { clientX, clientY } = e;
        setDrag((g) => {
            if (!g || g.pointerId !== e.pointerId) return g;
            const [dx, dy] = toSheet(clientX - g.from.x, clientY - g.from.y);
            return { ...g, dx, dy, moved: g.moved || dx !== 0 || dy !== 0 };
        });
    };

    const endDrag = (e: React.PointerEvent) => {
        const g = drag;
        setDrag(null);
        if (!g || g.pointerId !== e.pointerId || !onArrange) return;
        // A plain CLICK must not write geometry. Selecting a part in a design nobody has arranged would
        // otherwise materialise its fallback position — and that position is not neutral: `pcb-core`'s
        // adapter seeds board placement from `positions` as soon as EVERY part has one, so a click could
        // silently re-lay-out the board.
        if (!g.moved) return;

        const positions = { ...(ui?.positions ?? {}) };
        for (const id of g.ids) {
            const from = g.origin[id]!;
            positions[id] = {
                ...positions[id],
                x: snapToGrid(from.x + g.dx),
                y: snapToGrid(from.y + g.dy),
            };
        }
        // ONE revision, and the kernel decides whether it is one at all: `commitUi` compares by value, so a
        // drag that ends where it started commits nothing. The comparison lives in one place on purpose — a
        // second "did it change" test here would be the second authority this codebase keeps paying for.
        const label =
            g.ids.length === 1
                ? `Move ${placed.find((p) => p.id === g.ids[0])?.designator ?? 'part'}`
                : `Move ${g.ids.length} parts`;
        onArrange(label, { ...ui, schemaVersion: 1, positions });
    };

    // Which wires the router says are not to be trusted. Built once per drawing rather than searched per
    // wire, because 'is this key in a list' inside a render loop is how a linear cost becomes a quadratic one.
    const untrustworthy = new Set(routed.fellBack.filter((f) => f.reason === 'no-legible-route').map((f) => f.key));

    /**
     * A wire's points as they should be drawn RIGHT NOW, which during a gesture is not where the document
     * says.
     *
     * Only the ends matter. A wire ends on a terminal, so an end sitting on a terminal of the part being
     * dragged follows the pointer while everything else holds still — the wire stretches from where it is
     * anchored to where the pin now is. That is the ordinary rubber band every editor uses, and it is the
     * honest thing to draw: the drawing is mid-gesture, and it says so by not being at right angles.
     *
     * Re-routing instead would be correct and unusable: a sheet takes tens of milliseconds to route and a
     * drag is sixty frames a second. Before this the wires did not move at all, so a part could be dragged
     * clear across the sheet with its wires still pointing at where it used to be.
     */
    const rubberBand = (points: readonly (readonly [number, number])[]): Array<readonly [number, number]> => {
        if (!drag?.moved) return [...points];
        const moved = new Set(
            placed
                .filter((p) => drag.ids.includes(p.id))
                .flatMap((p) => p.symbol.pins.map((s) => `${p.x + s.x},${p.y + s.y}`)),
        );
        return points.map((q, i) =>
            (i === 0 || i === points.length - 1) && moved.has(`${q[0]},${q[1]}`)
                ? ([q[0] + drag.dx, q[1] + drag.dy] as const)
                : q,
        );
    };

    if (placed.length === 0) return <p className="empty">Nothing to draw yet — this design has no placeable parts.</p>;

    return (
        <svg
            ref={svgRef}
            role="img"
            aria-label="Schematic"
            viewBox={`${extent.x} ${extent.y} ${extent.w} ${extent.h}`}
            style={{ width: '100%', height: '100%', touchAction: 'none' }}
            onPointerMove={drag ? moveDrag : undefined}
            onPointerUp={drag ? endDrag : undefined}
            onPointerCancel={drag ? endDrag : undefined}
        >
            {routed.wires.map((w) => {
                // THE ROUTER'S OWN WARNING, ON THE SCREEN. `fellBack` distinguishes a wire that is merely a
                // diagonal because the sheet is crowded from one the module says states something FALSE —
                // and it called that report "the only reason this case is not a silent bug". It was not read
                // by anything: both came out as an identical grey diagonal, so on screen the report did not
                // exist and the promise was empty. An untrustworthy wire is now drawn as one: dashed, in the
                // warning colour, and titled with the reason.
                const lies = untrustworthy.has(w.key);
                return (
                    <polyline
                        key={w.key}
                        points={rubberBand(w.points)
                            .map(([x, y]) => `${x},${y}`)
                            .join(' ')}
                        fill="none"
                        stroke={lies ? 'var(--warn)' : 'var(--text-faint)'}
                        strokeWidth={1}
                        strokeDasharray={lies ? '4 3' : undefined}
                        data-net={w.netName}
                        // Stated so a reader can tell the difference. A diagonal here is not a style: it is
                        // the router saying it could not draw this wire at right angles without the drawing
                        // claiming something the netlist does not.
                        data-shape={w.shape}
                        data-trust={lies ? 'unverified' : undefined}
                    >
                        {lies && (
                            <title>
                                {w.netName}: no line between these terminals shows only what the netlist says — move a
                                part to fix it
                            </title>
                        )}
                    </polyline>
                );
            })}

            {/* THE DOTS, which are not decoration. A dot means these wires are one node; its absence means
                they merely cross. Without them a branch and a crossing look identical, and a reader has to
                guess which circuit they are looking at. */}
            {routed.junctions.map((j) => (
                <circle
                    key={`${j.netId}@${j.x},${j.y}`}
                    data-testid="junction"
                    cx={j.x}
                    cy={j.y}
                    r={2}
                    fill="var(--text-faint)"
                />
            ))}

            {placed.map((p) => {
                const path = `root/components/${p.id}`;
                const isSelected = selectedPath === path;
                return (
                    <g
                        key={p.id}
                        data-testid={`symbol-${p.id}`}
                        transform={`translate(${dragged(p).x} ${dragged(p).y})`}
                        onPointerDown={(e) => beginDrag(e, p.id)}
                        onClick={() => onSelect?.(byPath.get(path) ?? null)}
                        style={{ cursor: 'pointer' }}
                    >
                        {/* A CLOSED shape is drawn with <polygon>, an open one with <polyline>, and the
                            difference is not cosmetic. <polyline> auto-closes for FILLING but never STROKES
                            the closing edge, so every closed body in the library was rendered missing one
                            side: the derived box — which is 26 of the 32 component types — drew open on the
                            left with its pin stubs hanging in space, the resistor drew as a bracket, the
                            diode lost its triangle entirely, and the voltage source's circle had a notch
                            bitten out of it. Nothing failed; the sheet just quietly showed a different
                            circuit than the one it had.

                            The fill made it worse rather than covering it. `var(--surface-2)` is used here
                            and DEFINED NOWHERE — the palette in globals.css names its surfaces `--panel`
                            and `--panel-raised` — so it fell through to `transparent` and the missing edges
                            had nothing behind them. A fallback that silently succeeds is how a typo in a
                            colour name survives review: it renders, so it looks intentional. */}
                        {p.symbol.strokes.map((s, i) => {
                            const shape = {
                                key: i,
                                points: s.points.map(([x, y]) => `${x},${y}`).join(' '),
                                stroke: isSelected ? 'var(--accent, #d99a5c)' : 'var(--text, #ccc)',
                                strokeWidth: isSelected ? 2 : 1.4,
                            };
                            return s.closed ? (
                                <polygon {...shape} fill="var(--panel-raised, #222)" />
                            ) : (
                                <polyline {...shape} fill="none" />
                            );
                        })}
                        {p.symbol.pins.map((pin) => (
                            <circle key={pin.pinId} cx={pin.x} cy={pin.y} r={2} fill="var(--text-faint, #888)" />
                        ))}
                        <text
                            x={p.symbol.labelAnchor.x}
                            y={p.symbol.labelAnchor.y}
                            fontSize={10}
                            textAnchor="middle"
                            fill={isSelected ? 'var(--accent, #d99a5c)' : 'var(--text-faint, #888)'}
                        >
                            {p.designator}
                        </text>
                    </g>
                );
            })}
        </svg>
    );
}
