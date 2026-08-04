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
 * WHAT IT DELIBERATELY IS NOT, so nobody reads more into it than it says:
 *
 *   • It is not a schematic ROUTER. Wires are drawn straight from pin to pin, as a star from the first pin
 *     on each net. A real schematic routes orthogonally, breaks crossings and places junction dots, and
 *     pretending to do that badly would be worse than doing it plainly: a user would read a crossing as a
 *     connection. Straight lines are unambiguous about being a topology view.
 *   • Positions come from `ui.positions` when the document carries them, and from a deterministic grid when
 *     it does not — which is the ordinary case for a design a machine wrote and nobody has arranged. The
 *     grid is derived by scanning, never randomised, so the same document draws the same way on every render
 *     and in every test. What it is NOT yet is a placement the user can change: nothing here drags. That is
 *     the next slice; this one is about the arrangement surviving once something does write it.
 *   • It shows the SCHEMATIC, not the board. Board geometry is a different document with its own frame, and
 *     conflating the two is the confusion this codebase already documents in `UiJson.positions`.
 */
import type { CircuitJson, Position, UiJson } from '@circuit-forge/eda-core';
import { buildObjectTree, isPlaceablePart, symbolFor, type TreeNode } from '@circuit-forge/editor-core';
import { useMemo } from 'react';

/** Room around a symbol before the next one starts, in the same units `symbolFor` uses. */
const CELL_PAD = 44;
const MARGIN = 24;

interface Placed {
    id: string;
    designator: string;
    x: number;
    y: number;
    symbol: ReturnType<typeof symbolFor>;
}

/**
 * Where each part sits.
 *
 * A stored position wins; otherwise a grid, ordered by the component array, with the cell sized to the
 * LARGEST symbol so nothing overlaps whatever mix of parts a design happens to contain. Deterministic by
 * construction: no clock, no randomness, no dependence on render order.
 */
function layOut(circuit: CircuitJson, positions: Record<string, Position> | undefined): Placed[] {
    const parts = (circuit.components ?? []).filter((c) => isPlaceablePart(c));
    const symbols = parts.map((c) => symbolFor(c));
    const cellW = Math.max(CELL_PAD, ...symbols.map((s) => s.width)) + CELL_PAD;
    const cellH = Math.max(CELL_PAD, ...symbols.map((s) => s.height)) + CELL_PAD;
    const cols = Math.max(1, Math.ceil(Math.sqrt(parts.length)));

    return parts.map((c, i) => {
        const stored = positions?.[c.id];
        return {
            id: c.id,
            designator: c.designator,
            x: stored?.x ?? MARGIN + (i % cols) * cellW + cellW / 2,
            y: stored?.y ?? MARGIN + Math.floor(i / cols) * cellH + cellH / 2,
            symbol: symbols[i]!,
        };
    });
}

/** Absolute position of one pin, so a wire can start there. */
function pinAt(p: Placed, pinId: string): { x: number; y: number } | null {
    const pin = p.symbol.pins.find((s) => s.pinId === pinId);
    return pin ? { x: p.x + pin.x, y: p.y + pin.y } : null;
}

export function SchematicCanvas({
    circuit,
    ui,
    selectedPath,
    onSelect,
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
}) {
    const { placed, wires, extent, byPath } = useMemo(() => {
        const placed = layOut(circuit, ui?.positions);
        const byId = new Map(placed.map((p) => [p.id, p]));

        /**
         * One segment per connection, drawn as a star from the first pin on the net.
         *
         * A star rather than a chain because a chain implies an ORDER the netlist does not have: a net is a
         * set of pins that are all one node, and drawing A–B–C would suggest current flows through B to
         * reach C. Both are simplifications; only one of them is misleading.
         *
         * Nets with a single pin are skipped and that is the point of them being visible as bare pins: an
         * unconnected pin is exactly what a one-pin net means, and ERC reports it in those words.
         */
        const wires: Array<{ key: string; net: string; x1: number; y1: number; x2: number; y2: number }> = [];
        for (const net of circuit.nets ?? []) {
            const ends: Array<{ x: number; y: number; label: string }> = [];
            for (const c of circuit.components ?? []) {
                const p = byId.get(c.id);
                if (!p) continue; // a net marker, not a drawn part
                for (const pin of c.pins) {
                    if (pin.netId !== net.id) continue;
                    const at = pinAt(p, pin.pinId);
                    if (at) ends.push({ ...at, label: `${c.id}.${pin.pinId}` });
                }
            }
            const [hub, ...rest] = ends;
            if (!hub) continue;
            for (const e of rest) {
                wires.push({ key: `${net.id}:${e.label}`, net: net.name, x1: hub.x, y1: hub.y, x2: e.x, y2: e.y });
            }
        }

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
            x: minX - MARGIN,
            y: minY - MARGIN,
            w: Math.max(200, Math.max(...xs) - minX + MARGIN * 2),
            h: Math.max(160, Math.max(...ys) - minY + MARGIN * 2),
        };

        // The tree is the selection authority; the canvas resolves through it rather than minting its own
        // node shape, so clicking a symbol and clicking its row select the identical object.
        const byPath = buildObjectTree(circuit).byPath;
        return { placed, wires, extent, byPath };
    }, [circuit, ui?.positions]);

    if (placed.length === 0) return <p className="empty">Nothing to draw yet — this design has no placeable parts.</p>;

    return (
        <svg
            role="img"
            aria-label="Schematic"
            viewBox={`${extent.x} ${extent.y} ${extent.w} ${extent.h}`}
            style={{ width: '100%', height: '100%' }}
        >
            {wires.map((w) => (
                <line
                    key={w.key}
                    x1={w.x1}
                    y1={w.y1}
                    x2={w.x2}
                    y2={w.y2}
                    stroke="var(--text-faint)"
                    strokeWidth={1}
                    data-net={w.net}
                />
            ))}

            {placed.map((p) => {
                const path = `root/components/${p.id}`;
                const isSelected = selectedPath === path;
                return (
                    <g
                        key={p.id}
                        data-testid={`symbol-${p.id}`}
                        transform={`translate(${p.x} ${p.y})`}
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
