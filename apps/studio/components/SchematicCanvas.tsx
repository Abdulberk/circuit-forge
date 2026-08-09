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
import {
    nextTurn,
    rotationField,
    toDegrees,
    type CircuitJson,
    type UiJson,
    type ErcIssue,
} from '@circuit-forge/eda-core';
import {
    buildObjectTree,
    PIN_GRID,
    placeParts,
    bodiesOf,
    groundGlyphs,
    railGlyphs,
    netsOf,
    routeSheet,
    type PlacedPart,
    type SelectMode,
    type TreeNode,
    componentPath,
    pathKey,
    pinPath,
    stretchWire,
    type Point,
    partsTouching,
    boxBetween,
} from '@circuit-forge/editor-core';
import { useEffect, useMemo, useRef, useState } from 'react';

import { isTextEntry } from '../lib/useUndoShortcuts';

/** A stable empty list, so a canvas with no selection does not rebuild its set on every render. */
const EMPTY: readonly string[] = [];
/** A stable empty list, so a sheet with nothing wrong does not rebuild its index on every render. */
const NO_PROBLEMS: readonly ErcIssue[] = [];

/** Clear sheet around the drawing, so nothing is drawn hard against the edge of the view. */
const VIEW_MARGIN = 24;

/** Snap a sheet coordinate onto the pin lattice, so a dropped part lands where a wire can reach it. */
const snapToGrid = (v: number): number => Math.round(v / PIN_GRID) * PIN_GRID;

type Placed = PlacedPart;

export function SchematicCanvas({
    circuit,
    ui,
    selectedPaths = EMPTY,
    problems = NO_PROBLEMS,
    onContextMenu,
    onSelect,
    onArrange,
    onConnect,
    onDisconnect,
    onSplit,
    onDelete,
    onDuplicate,
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
    /** Every selected object, by path. A list because an editor needs one; ordered, primary last. */
    selectedPaths?: readonly string[];
    /**
     * A click, reported rather than interpreted.
     *
     * The mode says what the gesture MEANT — replace, toggle, add — and what that does is decided in one
     * place above, so the canvas and the tree cannot drift about what a modified click does.
     */
    onSelect?: (what: TreeNode | readonly TreeNode[] | null, mode?: SelectMode) => void;
    /**
     * Take the named terminals off their net, ONTO ONE NEW NET TOGETHER.
     *
     * Not the same as disconnecting each of them, which is what Delete does and leaves every terminal alone
     * on a net of its own. The distinction is the whole point of the verb.
     */
    onSplit?: (pins: ReadonlyArray<{ componentId: string; pinId: string }>) => void;
    /**
     * Commit a new drawing as ONE revision. Omitted makes the canvas read-only, which is what every test
     * that is not about dragging wants.
     */
    onArrange?: (label: string, next: UiJson) => void;
    /**
     * Join two terminals. Omitted makes the canvas read-only about topology, which is what every test that
     * is not about wiring wants — and what a viewer of somebody else's design should get.
     */
    onConnect?: (from: { componentId: string; pinId: string }, to: { componentId: string; pinId: string }) => void;
    /**
     * Take a terminal off its net. Omitted leaves the sheet unable to UNDO a connection by gesture, which is
     * how it was: you could join two terminals by dragging and could only part them through a side panel.
     */
    onDisconnect?: (pin: { componentId: string; pinId: string }) => void;
    /**
     * Remove parts from the design — ALL of them, as one action.
     *
     * A list rather than one id, because deleting five parts one call at a time would be five undo steps for
     * one gesture, and every intermediate document is one nobody asked for.
     */
    onDelete?: (componentIds: readonly string[]) => void;
    /**
     * Copy the selected parts. Omitted leaves the canvas unable to, which a viewer should be.
     *
     * The canvas says WHICH parts; what a copy means — what wiring travels with it, what is dropped, what is
     * shared — is the kernel's answer, because those are claims about the netlist.
     */
    onDuplicate?: (componentIds: readonly string[]) => void;
    /**
     * What the electrical rule check found, marked ON the drawing.
     *
     * ERC has been in the kernel since long before there was a canvas, and nothing in this app has ever
     * shown it: a design with no ground, a floating node, two parts sharing a designator — all reported, all
     * invisible. A list in a panel is better than nothing and still asks the reader to find the part it
     * names; the point of having a drawing is that a problem can be shown where it IS.
     *
     * THE KERNEL'S OWN TYPE, not a structural copy of it. The copy that used to be here had no `related`
     * field, so a canvas reading it could not learn WHICH KIND an id names and had to guess by looking it
     * up among the parts — which marks the wrong object the first time a document holds one string as both
     * a part id and a net id.
     */
    problems?: readonly ErcIssue[];
    /**
     * A right-click, reported with WHAT was under it and WHERE on the screen.
     *
     * The canvas does not decide what a menu contains — that is a question about which verbs exist and which
     * of them apply, and the answer lives with the verbs. This says only that somebody asked.
     */
    onContextMenu?: (at: { x: number; y: number }, node: TreeNode | null) => void;
}) {
    const svgRef = useRef<SVGSVGElement | null>(null);
    // Asked many times per render — by every symbol, every terminal and every key handler — so it is a set
    // rather than a scan. `chosen` is the primary: the one the single-object verbs act on.
    const selection = useMemo(() => new Set(selectedPaths), [selectedPaths]);
    /**
     * Which objects an issue names, and how badly, by id.
     *
     * An error outranks a warning on the same object: a part that is both duplicated and out of the E-series
     * should read as the more serious of the two, and a reader should not have to know which mark won.
     */
    const flagged = useMemo(() => {
        // KEYED BY KIND AND ID, not by id alone. Both are just strings and nothing stops one document
        // holding the same one as a part and as a net — measured on a sheet whose spare net was called
        // `r1`, where three remarks about the NET put a mark on the RESISTOR, and a user opening R1 to see
        // what was wrong found nothing wrong with it. The kernel now says which kind each id names; where an
        // older issue does not, the id is taken to mean both, which is the guess this used to make always.
        const worst = new Map<string, 'error' | 'warning'>();
        const mark = (kind: 'component' | 'net', id: string, level: 'error' | 'warning') => {
            const at = `${kind}:${id}`;
            if (level === 'error' || !worst.has(at)) worst.set(at, level);
        };
        for (const issue of problems) {
            // ADVISORY REMARKS ARE NOT MARKED ON THE DRAWING. Reading "anything that is not an error" as a
            // warning was already fixed in the list beside the sheet and not here, so the two surfaces
            // answered the same question differently — and this is the surface that matters more, because a
            // mark on a symbol is a claim about that part. A half-wired sheet is full of advisory remarks:
            // every net nobody has got to yet is one. Marked, they ring parts and turn wires amber during
            // ordinary work, and a mark that is always on says nothing when it matters.
            //
            // They are not hidden — the list names every one of them, counted as notes. The drawing is for
            // the things worth interrupting somebody about.
            if (issue.severity !== 'error' && issue.severity !== 'warning') continue;
            const level = issue.severity;
            if (issue.related) {
                for (const subject of issue.related) mark(subject.kind, subject.id, level);
            } else {
                for (const id of issue.relatedIds) {
                    mark('component', id, level);
                    mark('net', id, level);
                }
            }
        }
        return worst;
    }, [problems]);

    /** Whether a part carries a mark, and how badly. */
    const partProblem = (id: string) => flagged.get(`component:${id}`);
    /** Whether a net's wires carry one. */
    const netProblem = (id: string) => flagged.get(`net:${id}`);
    const chosen = selectedPaths[selectedPaths.length - 1] ?? null;
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
        /**
         * Where the pointer went down, ON THE SHEET.
         *
         * Not in client pixels, and that is the whole of a defect worth naming. A pixel origin has to be
         * converted through the CURRENT mapping on every move — so zooming or pressing F mid-drag rescaled a
         * distance the hand had already travelled, and the part jumped out from under the pointer by the
         * zoom factor. Measured: twelve wheel notches during a drag moved a stationary part seven and a half
         * grid steps, and that position is what the release committed. A sheet origin cannot drift, because
         * both ends of the subtraction are in the same frame however the view moves underneath them.
         */
        from: { x: number; y: number };
        dx: number;
        dy: number;
        moved: boolean;
    } | null>(null);

    const { placed, glyphs, rails, routed, extent, byPath } = useMemo(() => {
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
        // THE REFERENCE IS MARKED, NOT WIRED. A ground symbol on each pin that reaches the reference is what
        // every schematic does, and the measurement says why: ground was between a third and a half of all
        // the wire on the sheet, crossing everything else. Drawn this way the twenty-part circuit's wire
        // drops from 12,820 units to 5,980, and no wire becomes illegible in the process.
        //
        // The glyphs are obstacles like any other symbol, so wires go round them rather than through.
        const glyphs = groundGlyphs(circuit, placed);
        // A SUPPLY RAIL, marked the same way and for the same reason — it is the second-largest net in most
        // designs and it crosses everything on its way to each consumer. With its NAME, because every ground
        // symbol means one node while VCC and +3V3 are different nodes drawn with the same mark.
        const rails = railGlyphs(circuit, placed);
        const routed = routeSheet(netsOf(circuit, placed), bodiesOf([...placed, ...glyphs, ...rails]));

        // HALF the extent on each side of the centre, because `width`/`height` are FULL extents — the size
        // of the whole symbol, scanned from its own strokes and pins. This file used to read them both
        // ways, 73 lines apart: as a full extent when sizing a grid cell above, and as a half extent here,
        // which inflated the sheet by a factor of two in each axis and drew everything at half size inside
        // a viewBox with dead margin on two sides. The library's docstring said half while every producer
        // returned full, so both readings had something to point at. There is one meaning now.
        // FROM THE SYMBOL'S OWN BOUNDS, not its extent about its centre — the same correction the obstacle
        // boxes needed, and for the same reason: ground is not centred on its origin, so reconstructing the
        // box from the extent left part of the drawing outside the view.
        const drawn = [...placed, ...glyphs, ...rails];
        const xs = drawn.flatMap((p) => [p.x + p.symbol.bounds.minX, p.x + p.symbol.bounds.maxX]);
        const ys = drawn.flatMap((p) => [p.y + p.symbol.bounds.minY, p.y + p.symbol.bounds.maxY]);
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
        return { placed, glyphs, rails, routed, extent, byPath };
    }, [circuit, ui?.positions]);

    /**
     * WHAT IS ON SCREEN, which is not the same question as what is in the document.
     *
     * `null` means "show all of it", and it stays null until the user says otherwise. That is the right
     * default for a sheet a machine just wrote — you want to see the circuit, not a corner of it — and it
     * keeps working as the design grows, because a null view re-fits to whatever the drawing now covers.
     * The moment anyone zooms or pans it becomes an explicit rectangle and stays exactly where they put it;
     * an edit must not throw away the part of the sheet somebody was looking at.
     *
     * It is NOT in the document. Where a viewer is looking is not a property of the circuit — two people
     * with the same drawing open are entitled to be looking at different halves of it — and writing it
     * through the commit kernel would put a revision and a save behind every scroll wheel.
     */
    const [view, setView] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
    const box = view ?? extent;

    /**
     * The ONE place screen coordinates and sheet coordinates meet.
     *
     * Everything that has to cross that boundary — dragging a part, zooming about the pointer, panning,
     * dropping a wire on a terminal — goes through here. Two of these would drift, and the drift would show
     * up as a part landing a few units from where it was dropped, which is the kind of defect that gets
     * explained away as "snapping" for months.
     *
     * The arithmetic is the mapping SVG actually performs. `preserveAspectRatio` defaults to `meet`, so the
     * viewBox is scaled uniformly by the SMALLER of the two ratios and centred, leaving a letterbox on one
     * axis. Computed rather than read from `getScreenCTM`, which is exact but does not exist under jsdom —
     * so this way the behaviour can be tested rather than only demonstrated.
     */
    const mapping = (): { perPixel: number; left: number; top: number } | null => {
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return null;
        const pixelsPerUnit = Math.min(rect.width / box.w, rect.height / box.h);
        return {
            perPixel: 1 / pixelsPerUnit,
            left: rect.left + (rect.width - box.w * pixelsPerUnit) / 2,
            top: rect.top + (rect.height - box.h * pixelsPerUnit) / 2,
        };
    };

    /** A distance in pixels as a distance on the sheet. */
    const toSheet = (px: number, py: number): [number, number] => {
        const m = mapping();
        return m ? [px * m.perPixel, py * m.perPixel] : [px, py];
    };

    /** A point on the screen as a point on the sheet — the inverse of what the browser just drew. */
    const pointOnSheet = (clientX: number, clientY: number): [number, number] | null => {
        const m = mapping();
        return m ? [box.x + (clientX - m.left) * m.perPixel, box.y + (clientY - m.top) * m.perPixel] : null;
    };

    /**
     * How far in and how far out, derived rather than picked.
     *
     * The tightest view shows four grid steps across, which is a single symbol filling the screen — past
     * that there is nothing left to look at. The widest shows the whole drawing eight times over, which is
     * as lost as anyone needs to get. Both are stated against the sheet's own units, so they mean the same
     * thing on a two-part circuit and on a four-hundred-part one.
     */
    const zoomLimits = { tightest: PIN_GRID * 4, widest: Math.max(extent.w, extent.h) * 8 };

    /**
     * Zoom about the pointer: whatever is under the cursor stays under the cursor.
     *
     * That is the whole specification, and it is the only thing worth testing about zooming. A wheel that
     * scales the view about its CENTRE instead feels broken in a way people describe as "it runs away from
     * me" — you point at the part you want to look at and it slides off the screen.
     */
    const zoomAt = (clientX: number, clientY: number, factor: number): void => {
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return;
        // FROM THE PREVIOUS VIEW, not from the one this render was drawn with. A wheel sends several events
        // before React paints, and computing each from the rendered box made every notch in a burst start
        // from the same place — so five notches moved the view as far as one.
        setView((was) => {
            const b = was ?? extent;
            const perPixel = 1 / Math.min(rect.width / b.w, rect.height / b.h);
            const [ax, ay] = [
                b.x + (clientX - (rect.left + (rect.width - b.w / perPixel) / 2)) * perPixel,
                b.y + (clientY - (rect.top + (rect.height - b.h / perPixel) / 2)) * perPixel,
            ];
            const scale = allowedZoom(b, factor);
            return { x: ax - (ax - b.x) * scale, y: ay - (ay - b.y) * scale, w: b.w * scale, h: b.h * scale };
        });
    };

    /**
     * How much of the asked-for zoom the limits allow, and IN WHICH DIRECTION.
     *
     * Two things went wrong when this clamped the width alone. A tall sheet's HEIGHT was unbounded, so it
     * kept zooming in past the point of showing anything and out until the drawing was a fifth of a pixel
     * across. And clamping a value rather than a direction can move the view the WRONG WAY: when the drawing
     * shrinks after an edit, the current view can already be wider than the new limit, and a zoom-OUT notch
     * then snapped it back inside — zooming IN by up to eighteen times on a gesture asking for the opposite.
     *
     * So the limits are applied to the SCALE and only ever in the direction that tightens the request. A
     * zoom-in can be refused; it can never be turned into a zoom-out.
     */
    const allowedZoom = (b: { w: number; h: number }, factor: number): number => {
        if (factor < 1) {
            // Going in: neither side may end up narrower than the tightest view, and refusing means 1.
            const floor = zoomLimits.tightest / Math.min(b.w, b.h);
            return Math.max(factor, Math.min(1, floor));
        }
        // Going out: neither side may end up wider than the widest view, and refusing means 1.
        const ceiling = zoomLimits.widest / Math.max(b.w, b.h);
        return Math.min(factor, Math.max(1, ceiling));
    };

    /**
     * The wheel, attached by hand rather than through React.
     *
     * React registers `onWheel` passively, and a passive listener may not call `preventDefault` — so a page
     * that zooms on the wheel would also scroll behind the zoom. This is the one place where going around
     * the framework is the plain solution rather than a workaround.
     */
    useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return;
        const onWheel = (event: WheelEvent) => {
            // A HORIZONTAL swipe is not a zoom. A trackpad sends deltaY exactly zero for one, and taking the
            // sign of zero gave a factor of one — which changed nothing on screen and yet replaced the
            // fit-to-content view with an explicit rectangle, so the drawing silently stopped following the
            // design as it grew. Nothing to do here is nothing to do.
            if (event.deltaY === 0) return;
            event.preventDefault();
            // A tenth per notch, compounding, so the gesture feels the same however far it goes and holding
            // the wheel down never overshoots by a factor of a hundred.
            zoomAt(event.clientX, event.clientY, Math.pow(1.1, Math.sign(event.deltaY)));
        };
        svg.addEventListener('wheel', onWheel, { passive: false });
        return () => svg.removeEventListener('wheel', onWheel);
    });

    /**
     * `F` shows the whole drawing again.
     *
     * The way back. Without it a user who zooms into a corner of a four-hundred-part sheet has no way to
     * find the rest of it except by scrolling blind, and the letter is what every editor in this shape uses.
     */
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key.toLowerCase() !== 'f') return;
            if (isTextEntry(event.target)) return; // `f` is a letter, and the Inspector has text fields
            setView(null);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    /**
     * Dragging the sheet itself pans it.
     *
     * Started on the SVG rather than on a symbol, and a symbol's own pointerdown stops the event before it
     * gets here — so "drag a part" and "drag the sheet" cannot both fire from one press.
     */
    const [pan, setPan] = useState<{ pointerId: number; from: { x: number; y: number }; box: typeof extent } | null>(
        null,
    );
    /**
     * A box drawn on empty sheet, and everything whose symbol it touches.
     *
     * THE ONLY WAY TO SELECT MANY THINGS AT ONCE was shift-clicking each of them, which is the same number of
     * gestures as not having multi-select at all for anything above about four parts. Dragging a box is what
     * every editor does and what a hand reaches for first.
     *
     * Held on SHIFT because a bare drag on the sheet already pans, and panning is the more common act by a
     * long way. Touching counts rather than enclosing: a box that only takes what it fully contains makes a
     * user draw it twice, once too small and once right.
     */
    const [marquee, setMarquee] = useState<{ pointerId: number; from: [number, number]; to: [number, number] } | null>(
        null,
    );

    const beginPan = (e: React.PointerEvent): void => {
        gestured.current = false; // every fresh press starts out a click until it travels
        if ((e.button ?? 0) > 0 || drag || wire || pan || marquee) return; // one gesture at a time, first wins

        if (e.shiftKey && onSelect) {
            const at = pointOnSheet(e.clientX, e.clientY);
            if (!at) return;
            (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
            setMarquee({ pointerId: e.pointerId, from: at, to: at });
            return;
        }
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        setPan({ pointerId: e.pointerId, from: { x: e.clientX, y: e.clientY }, box });
    };
    const movePan = (e: React.PointerEvent): void => {
        const { clientX, clientY } = e;
        // Measured from where the gesture STARTED, like the part drag: a dropped frame then costs nothing,
        // because the next one recomputes the whole offset instead of adding to a total that lost something.
        gestured.current = true; // a pan is a gesture, and the click that ends it is not a click
        const [dx, dy] = toSheet(clientX - (pan?.from.x ?? 0), clientY - (pan?.from.y ?? 0));
        setPan((g) => {
            if (!g || g.pointerId !== e.pointerId) return g;
            setView({ x: g.box.x - dx, y: g.box.y - dy, w: g.box.w, h: g.box.h });
            return g;
        });
    };
    /**
     * Whether the last press turned into a gesture rather than a click.
     *
     * A browser fires `click` after a press and release on the same element HOWEVER FAR the pointer travelled
     * in between — so panning the sheet ended on the svg and the click-away handler destroyed the whole
     * selection, and dragging a part ended on that part and replaced the selection with just it. Both are the
     * opposite of what the gesture meant. A ref rather than state: it is read in the click that follows the
     * same tick, and a re-render would be a frame too late.
     */
    const gestured = useRef(false);

    const moveMarquee = (e: React.PointerEvent): void => {
        const at = pointOnSheet(e.clientX, e.clientY);
        if (!at) return;
        gestured.current = true;
        setMarquee((m) => (m && m.pointerId === e.pointerId ? { ...m, to: at } : m));
    };

    const endMarquee = (e: React.PointerEvent): void => {
        const m = marquee;
        if (!m || m.pointerId !== e.pointerId) return;
        setMarquee(null);
        if (!onSelect) return;

        const box = boxBetween(m.from, m.to);
        // A press with no travel is a shift-click on empty sheet, which means nothing — and must not clear a
        // selection the user just built.
        if (box.maxX === box.minX && box.maxY === box.minY) return;

        // THE SAME RULE the box has been showing all through the gesture. Two copies of it would be the
        // drift this codebase keeps paying for, and worse than usual here: the disagreement would be
        // invisible until somebody let go and got something other than what was highlighted.
        const caught = partsTouching(placed, box);
        // ADDED to what is already selected, because the key that starts the box is the key that extends a
        // selection everywhere else on this canvas. Replacing instead would make Shift mean two things.
        // 'add', not 'toggle': a box GATHERS. Sent as a toggle it dropped every part the box caught that was
        // already selected, so dragging over your own selection cleared it.
        //
        // ALL OF IT IN ONE REPORT. One call per caught part made the rule re-filter the whole selection once
        // per part — quadratic in what the box caught, and measured at 20ms for 1600 parts where doing it
        // once costs 0.16ms. Reporting a gesture piecemeal also means every intermediate state exists, and
        // some of them are states the user never asked for.
        onSelect(
            caught.flatMap((p) => byPath.get(componentPath(p.id)) ?? []),
            'add',
        );
    };

    const endPan = (e: React.PointerEvent): void => {
        if (pan && pan.pointerId !== e.pointerId) return; // a different pointer's release is not this one's
        setPan(null);
    };

    /**
     * DRAWING A WIRE, which is the act that makes this an editor rather than a viewer.
     *
     * Connecting two terminals was possible before this — through a dropdown in the Inspector, one pin at a
     * time. That is a form for describing a connection, not a way of making one: the gesture an engineer
     * reaches for is a line from one terminal to another, and everything about a schematic is arranged to
     * make that gesture obvious. The kernel has had `connectPins` since long before anything could call it.
     *
     * WHAT THE CANVAS DECIDES IS NOTHING. It reports two terminals; `connectPins` decides whether that is a
     * connection, a no-op, or a refusal — including the one that matters, joining a declared ground to a
     * declared rail, which is a dead short and is refused with the remedy named. A canvas that made that
     * call itself would be the second authority this codebase keeps paying for.
     */
    const [wire, setWire] = useState<{
        pointerId: number;
        from: { componentId: string; pinId: string };
        at: { x: number; y: number };
        /** The terminal under the pointer, so the drop target is visible before the pointer comes up. */
        to: { componentId: string; pinId: string } | null;
    } | null>(null);

    /**
     * How near counts as ON a terminal.
     *
     * BOUNDED AT BOTH ENDS, and both bounds are about a real failure. A terminal is drawn two units across
     * and nobody can reliably put a pointer on two units of anything, so the target is nine pixels' worth of
     * sheet — except that "nine pixels' worth" is measured from the element, and on the FIRST paint there is
     * no element yet: the fallback made it nine SHEET units, which on a four-hundred-part sheet is under two
     * pixels, and the first gesture on a freshly opened design aimed at a target five times too small.
     *
     * The upper bound is the one that matters more. Zoomed out, nine pixels can be tens of sheet units — and
     * these circles sit on top of the symbols, so they swallowed whole parts and dragging stopped working
     * entirely. Half a grid step is the most a terminal may ever claim: it cannot reach its neighbour, and it
     * cannot cover a body. Past that the answer is to zoom in, which is now possible.
     */
    const grabRadius = Math.max(2, Math.min(PIN_GRID / 2, 9 * (mapping()?.perPixel ?? PIN_GRID / 18)));

    const beginWire = (e: React.PointerEvent, componentId: string, pinId: string): void => {
        if (!onConnect || (e.button ?? 0) > 0 || drag || wire || pan) return;
        e.stopPropagation(); // not a part drag, and not a pan
        (e.target as Element).setPointerCapture?.(e.pointerId);
        const at = pointOnSheet(e.clientX, e.clientY);
        if (!at) return;
        // THE SAME QUESTION AT BOTH ENDS. The start used to be whichever circle the browser's hit-testing
        // reported and the finish used nearest-by-geometry — two rules for one gesture, which disagree
        // exactly where the circles overlap. Asking the geometry both times means a wire always starts at the
        // terminal it would have finished on.
        const from = pinUnder(e.clientX, e.clientY) ?? { componentId, pinId };
        setWire({ pointerId: e.pointerId, from, at: { x: at[0], y: at[1] }, to: null });
    };
    const moveWire = (e: React.PointerEvent): void => {
        const at = pointOnSheet(e.clientX, e.clientY);
        const over = pinUnder(e.clientX, e.clientY);
        setWire((g) => (g && g.pointerId === e.pointerId && at ? { ...g, at: { x: at[0], y: at[1] }, to: over } : g));
    };

    const endWire = (e: React.PointerEvent): void => {
        const g = wire;
        if (!g || g.pointerId !== e.pointerId) return; // somebody else's pointer: not ours to end
        setWire(null);
        if (!onConnect) return;
        // Dropped on nothing is a cancelled gesture, not a failed one. Making an unfinished wire into an
        // error message would punish the ordinary act of changing your mind halfway across the sheet.
        const target = pinUnder(e.clientX, e.clientY);
        // A CLICK IS NOT A CONNECTION. Pressing and releasing on one terminal reported it joined to itself,
        // which the kernel correctly refuses — so selecting a pin, or thinking better of a wire before moving,
        // put an error banner on screen for an action the user never took. Ending where you started is a
        // gesture that did not happen.
        if (!target || (target.componentId === g.from.componentId && target.pinId === g.from.pinId)) return;
        onConnect(g.from, target);
    };

    /**
     * Which terminal the pointer is over, asked of the GEOMETRY rather than of the DOM.
     *
     * The obvious way is to let each terminal report its own `pointerenter` — and it does not work, for a
     * reason that has nothing to do with this code: a gesture holds pointer CAPTURE, and a captured pointer
     * sends every event to the element it started on. The terminal being dragged towards never hears about
     * it. `document.elementFromPoint` asks the browser instead, which is a second mechanism with its own
     * rules and no implementation under jsdom, so that behaviour could only be demonstrated and never tested.
     *
     * The terminals are already at known places on the sheet and the pointer is already convertible to a
     * point on the sheet. Nearest-within-the-grab-radius is the same question the visible target expresses,
     * answered from the same numbers, and it behaves identically in a browser and in a test.
     */
    const pinUnder = (clientX: number, clientY: number): { componentId: string; pinId: string } | null => {
        const at = pointOnSheet(clientX, clientY);
        if (!at) return null;
        let best: { componentId: string; pinId: string } | null = null;
        let nearest = grabRadius * grabRadius;
        for (const part of placed)
            for (const s of part.symbol.pins) {
                const [dx, dy] = [part.x + s.x - at[0], part.y + s.y - at[1]];
                const d = dx * dx + dy * dy;
                if (d <= nearest) {
                    nearest = d;
                    best = { componentId: part.id, pinId: s.pinId };
                }
            }
        return best;
    };

    /**
     * `Delete` removes what is selected, and what that MEANS depends on what is selected.
     *
     * A terminal comes off its net; a part comes off the design. Both verbs already existed in the kernel
     * with tests and no way to reach them from the drawing — `disconnectPin` could only be run from a
     * dropdown in a side panel, which is a form for describing a change rather than a way of making one.
     *
     * The kernel decides what each means, as ever: a terminal that is already alone on its net is not an
     * error and not a change, and `disconnectPin` says so rather than minting a revision for nothing.
     */
    useEffect(() => {
        // NO EARLY RETURN ON AN EMPTY SELECTION. It read as an optimisation and made the guards below
        // unreachable: with nothing selected the listener was never registered, so the check for "nothing to
        // copy" was dead code and the test covering it passed because no handler ran at all. Each verb now
        // decides for itself, where a reader can see it decide.
        const onKeyDown = (event: KeyboardEvent) => {
            // COPY IS CHORDED, on purpose. Ctrl+D is what every editor uses for it, and a bare letter here
            // would collide with the turn and mirror keys a hand is already resting on.
            if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'd') {
                if (isTextEntry(event.target) || !onDuplicate) return;
                const ids = selectedPaths
                    .map((path) => byPath.get(path))
                    .filter((n): n is TreeNode => n?.ref.kind === 'component')
                    .map((n) => n.ref.id);
                if (ids.length === 0) return;
                // Ctrl+D is "bookmark this page" in a browser. Taking it is only defensible because there is
                // something selected to copy — with nothing selected the browser keeps it.
                event.preventDefault();
                onDuplicate(ids);
                return;
            }
            if (event.ctrlKey || event.metaKey || event.altKey) return;

            // W JOINS TWO SELECTED TERMINALS — the keyboard's way to do the one thing this editor exists
            // for. Wiring was pointer-only: a drag from one terminal to another, and no path to it at all
            // without a mouse. The tree is already keyboard-navigable and terminals are already selectable,
            // so the only thing missing was the verb.
            //
            // Exactly two, and only terminals. Three is ambiguous — a net is a set, so joining them is a
            // sensible thing to want, but it is not what the pointer gesture does, and two surfaces that do
            // different things under one name is the drift this codebase keeps paying for.
            if (event.key.toLowerCase() === 'w' && onConnect) {
                if (isTextEntry(event.target)) return; // `w` is a letter, and the Inspector is full of fields
                const pins = selectedPaths
                    .map((path) => byPath.get(path))
                    .filter((n): n is TreeNode => n?.ref.kind === 'pin' && !!n.ref.componentId);
                if (pins.length !== 2) return;
                event.preventDefault();
                onConnect(
                    { componentId: pins[0]!.ref.componentId!, pinId: pins[0]!.ref.id },
                    { componentId: pins[1]!.ref.componentId!, pinId: pins[1]!.ref.id },
                );
                return;
            }

            // S TAKES THE SELECTED TERMINALS OFF THEIR NET, TOGETHER — the counterpart of W, and the last
            // connectivity verb the kernel had with no way to reach it. It matters that they leave together:
            // pressing Delete on three terminals disconnects each of them, which leaves three separate
            // one-pin nets. Splitting leaves ONE new node with all three still joined to each other, which is
            // what "these three belong on their own node" means and could not be expressed at all — you had
            // to disconnect them and then wire them back up two at a time.
            //
            // The canvas decides nothing beyond WHICH terminals. Whether they are on one net, and whether
            // taking them is a split rather than a rename, is `splitNet`'s to answer — it refuses both cases
            // by name, and a second opinion here would be the drift this codebase keeps paying for.
            if (event.key.toLowerCase() === 's' && onSplit) {
                if (isTextEntry(event.target)) return; // a letter, and the Inspector is full of fields
                const pins = selectedPaths
                    .map((path) => byPath.get(path))
                    .filter((n): n is TreeNode => n?.ref.kind === 'pin' && !!n.ref.componentId);
                if (pins.length === 0) return;
                event.preventDefault();
                onSplit(pins.map((q) => ({ componentId: q.ref.componentId!, pinId: q.ref.id })));
                return;
            }

            if (event.key !== 'Delete' && event.key !== 'Backspace') return;
            // Backspace is BROWSER-BACK on some setups and a text edit everywhere else, so a field that owns
            // the keystroke keeps it — the same guard the undo shortcut uses, imported rather than restated.
            if (isTextEntry(event.target)) return;

            // ASKED OF THE TREE, not cut out of the path string. A path is a JOIN of ids, so reading ids back
            // out of it by counting separators is only right while no id contains one — and ids are ordinary
            // data: a design merged from two sub-sheets, or written by something else, can carry a slash. The
            // node already holds what its address means, in fields, which is why it has them.
            // WHAT IS SELECTED, not what happened to be clicked last. This used to branch on the kind of
            // the PRIMARY before it looked at anything else, so a selection of three parts with a net row
            // clicked most recently matched neither branch and the key did nothing at all — no deletion, no
            // refusal, no banner. The selection is what the user can see; the order they built it in is not.
            const nodes = selectedPaths.map((path) => byPath.get(path)).filter((n): n is TreeNode => !!n);
            const parts = nodes.filter((n) => n.ref.kind === 'component').map((n) => n.ref.id);
            const pins = nodes.filter((n) => n.ref.kind === 'pin' && n.ref.componentId);

            // A whole part. The kernel decides what goes with it: `deleteComponent` removes the nets THIS
            // delete emptied and leaves alone any that were already unreferenced, because sweeping those
            // would quietly remove things the user never touched and name them in a note they cannot place.
            if (parts.length > 0 && onDelete) {
                event.preventDefault();
                onDelete(parts);
                return;
            }
            // Only terminals selected: the verb is to take them off their nets. Parts win when both are
            // selected, because deleting a part takes its terminals with it and doing both would be one of
            // them twice.
            if (pins.length > 0 && onDisconnect) {
                event.preventDefault();
                for (const pin of pins) onDisconnect({ componentId: pin.ref.componentId!, pinId: pin.ref.id });
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [chosen, selectedPaths, byPath, onConnect, onDisconnect, onSplit, onDelete, onDuplicate]);

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
        if (!onArrange) return;
        // EVERY selected part, not just the primary one. The Inspector tells the user in so many words that
        // the keyboard verbs act on all of them, and this acted on one — so pressing R with five parts
        // selected turned one and left four, with nothing on screen saying why. A panel that promises and a
        // key that does not is worse than either alone.
        //
        // Resolved through the TREE rather than by cutting the path apart: a path is a join of ids, and ids
        // are ordinary data that can contain a separator.
        const parts = selectedPaths
            .map((path) => byPath.get(path))
            .filter((node) => node?.ref.kind === 'component')
            .flatMap((node) => placed.filter((p) => p.id === node!.ref.id));
        if (parts.length === 0) return; // nets, pins, or nothing with an orientation

        const onKeyDown = (event: KeyboardEvent) => {
            // No modifiers: Ctrl+R is reload, Alt+R belongs to the browser's menus. A bare letter is the
            // convention, and taking the chorded versions would break something the user expects.
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            const key = event.key.toLowerCase();
            // R turns, X and Y mirror — the letters every schematic editor uses, taken rather than invented.
            if (key !== 'r' && key !== 'x' && key !== 'y') return;
            // The SAME guard the undo shortcut uses, imported rather than restated. These are letters:
            // without it, typing a resistance of `4R7` in the Inspector would turn the part behind the panel.
            if (isTextEntry(event.target)) return;

            event.preventDefault();

            if (key === 'x' || key === 'y') {
                // MIRRORING WAS ALREADY BUILT. `Position.mirror` has been in the schema since it was written,
                // `orientSymbol` applies it, and `pcb-core` reads it — and nothing anywhere could WRITE one.
                // That is the same gap rotation had: a field, a renderer that honours it, and no key.
                //
                // Pressing the same letter again returns the part, and the field is DROPPED rather than set
                // to anything: a part mirrored twice is the part, and leaving `mirror` behind would make the
                // drawing structurally different from the one before the first press, so the commit kernel
                // would mint a revision and a save for a part that visibly did not move.
                //
                // EACH part answers for itself: one already mirrored this way is returned, one that is not
                // is mirrored. Deciding once from the primary and applying it to all would flip a part that
                // was already flipped, which is the opposite of what the key does to it alone.
                onArrange(parts.length === 1 ? `Mirror ${parts[0]!.designator}` : `Mirror ${parts.length} parts`, {
                    ...ui,
                    schemaVersion: 1,
                    positions: {
                        ...ui?.positions,
                        ...Object.fromEntries(
                            parts.map((p) => {
                                const at = ui?.positions?.[p.id];
                                const next = at?.mirror === key ? undefined : key;
                                const { mirror: _was, x: _mx, y: _my, ...keep } = at ?? { x: p.x, y: p.y };
                                return [p.id, { x: p.x, y: p.y, ...keep, ...(next ? { mirror: next } : {}) }];
                            }),
                        ),
                    },
                });
                return;
            }

            onArrange(parts.length === 1 ? `Rotate ${parts[0]!.designator}` : `Rotate ${parts.length} parts`, {
                ...ui,
                schemaVersion: 1,
                positions: {
                    ...ui?.positions,
                    ...Object.fromEntries(
                        parts.map((p) => {
                            const at = ui?.positions?.[p.id];
                            // Each from ITS OWN rotation, so a group of parts at different angles all advance
                            // a quarter rather than snapping to whatever the primary happened to be at.
                            const turn = nextTurn(toDegrees(at?.rotation));
                            // The rotation key is REPLACED, never merged past: `rotationField` returns `{}` at
                            // zero, and spreading that over an existing `rotation: '270'` would leave the old
                            // value in place, so the part would turn three times and then stick.
                            const { rotation: _dropped, x: _x, y: _y, ...rest } = at ?? { x: p.x, y: p.y };
                            // x and y come from where the part is ON SCREEN, which for an un-arranged design
                            // is the computed fallback. The schema requires them, so turning a part places it.
                            return [p.id, { x: p.x, y: p.y, ...rest, ...rotationField(turn) }];
                        }),
                    ),
                },
            });
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [onArrange, selectedPaths, byPath, placed, ui]);

    /**
     * Where a part is RIGHT NOW, which during a gesture is not where the document says.
     *
     * The offset is added at render time and nowhere else, so the drawing on screen and the drawing in the
     * document are the same object until the pointer comes up. Nothing to reconcile, and nothing to undo if
     * the gesture is cancelled — a cancelled drag is simply a piece of state that stopped existing.
     */
    const dragged = (p: Placed): { x: number; y: number } =>
        drag?.ids.includes(p.id) ? { x: p.x + drag.dx, y: p.y + drag.dy } : { x: p.x, y: p.y };

    /**
     * A ground symbol goes where its terminal goes.
     *
     * It is drawn from a memoised layout, which cannot change while a gesture is in flight — the drag lives
     * in local state on purpose, so the document is untouched until the pointer comes up. The symbols and the
     * wires already apply the offset at render time; the glyphs did not, so dragging a part left its ground
     * symbol behind on empty sheet. That is worse here than it would be anywhere else: a ground net is not
     * wired at all, so the symbol is the ONLY thing depicting that connection, and the drawing showed the
     * reference detached from the part for the whole gesture.
     */
    const draggedGlyph = (g: Placed): { x: number; y: number } => {
        const owner = g.annotates?.split('.')[0];
        return owner && drag?.ids.includes(owner) ? { x: g.x + drag.dx, y: g.y + drag.dy } : { x: g.x, y: g.y };
    };

    const beginDrag = (e: React.PointerEvent, id: string) => {
        gestured.current = false;
        // Any button that is NOT a secondary one. Written as `> 0` rather than `!== 0` because a pointer
        // event that carries no `button` at all — a synthetic one, or a touch — is a primary press, and
        // `!== 0` silently refuses it. That is not a test artefact: it is the same class of guard that
        // refuses a real touch on a tablet, where nothing would report why dragging simply did not work.
        if (!onArrange || (e.button ?? 0) > 0 || drag || wire || pan) return;
        e.stopPropagation();
        (e.target as Element).setPointerCapture?.(e.pointerId);
        // Only the part under the pointer. Group drag arrives with multi-select; until then, moving one part
        // must not move anything else — and a selection the user cannot see is not a selection.
        const start = placed.find((p) => p.id === id);
        const at = pointOnSheet(e.clientX, e.clientY);
        if (!start || !at) return;

        // THE WHOLE SELECTION MOVES, if the part under the pointer is part of it. Dragging one of five
        // selected parts and having the other four stay put is the behaviour that makes people stop
        // selecting things — and a part that is NOT selected drags alone, because grabbing something
        // outside the selection plainly means that thing.
        const group = selection.has(componentPath(id))
            ? placed.filter((q) => selection.has(componentPath(q.id)))
            : [start];

        setDrag({
            pointerId: e.pointerId,
            ids: group.map((q) => q.id),
            origin: Object.fromEntries(group.map((q) => [q.id, { x: q.x, y: q.y }])),
            from: { x: at[0], y: at[1] },
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
        const at = pointOnSheet(e.clientX, e.clientY);
        if (!at) return;
        setDrag((g) => {
            if (!g || g.pointerId !== e.pointerId) return g;
            const [dx, dy] = [at[0] - g.from.x, at[1] - g.from.y];
            if (dx !== 0 || dy !== 0) gestured.current = true;
            return { ...g, dx, dy, moved: g.moved || dx !== 0 || dy !== 0 };
        });
    };

    const endDrag = (e: React.PointerEvent) => {
        // OWNERSHIP FIRST, then clear. Clearing before the check meant a release by ANY pointer destroyed the
        // gesture another pointer was still performing — the id comparison only suppressed the commit, so two
        // fingers on a tablet produced two real drags and nothing committed, with no indication why.
        const g = drag;
        if (!g || g.pointerId !== e.pointerId) return;
        setDrag(null);
        if (!onArrange) return;
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
        // THE BEND ABSORBS THE MOVEMENT, in the kernel where it can be tested. Moving only the end point —
        // which is what this did — left the last segment at whatever angle the hand travelled, so dragging a
        // part in a circle swept its wire through three hundred and sixty degrees, and the shape then jumped
        // on release when the router ran for real. A drag that shows a picture the release will not produce
        // is worse than one that shows nothing.
        return stretchWire(points as Point[], moved, drag.dx, drag.dy);
    };

    /**
     * What the box has hold of RIGHT NOW, so the user can see it before letting go.
     *
     * Without this the gesture is the drag all over again: you cannot tell what you have until it is done,
     * and if it is wrong you undo and try once more. The box test is a linear scan and free at this size —
     * measured at 0.05ms for sixteen hundred parts, which is nothing at sixty frames a second.
     */
    const catching = new Set(
        marquee ? partsTouching(placed, boxBetween(marquee.from, marquee.to)).map((p) => p.id) : [],
    );

    if (placed.length === 0) return <p className="empty">Nothing to draw yet — this design has no placeable parts.</p>;

    return (
        <svg
            ref={svgRef}
            // NOT `role="img"`. A picture is what this was declared as, and a screen reader then announces one
            // label and stops: the parts, the terminals and every verb behind them are not there at all. It
            // is a thing you DO something to, which is what `application` means, and it takes focus so a
            // keyboard can reach it in the first place.
            role="application"
            aria-label="Schematic editor"
            aria-describedby="schematic-keys"
            tabIndex={0}
            viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
            style={{ width: '100%', height: '100%', touchAction: 'none' }}
            onPointerDown={beginPan}
            // A CLICK ON NOTHING SELECTS NOTHING. Without it a selection could only be replaced, never
            // dropped — and with several things selected and a key that acts on all of them, "how do I stop
            // this being selected" is a question a user should not have to answer with a lucky click.
            onClick={(e) => {
                // A pan ends here too, and a pan is not a click on the sheet.
                if (gestured.current) return;
                // SHIFT MEANS EXTEND, and extending by nothing is nothing. `endMarquee` already refuses a box
                // with no travel for exactly this reason — but the browser fires a click after the press and
                // release anyway, nothing travelled so `gestured` is false, and the selection the user was
                // assembling was destroyed by one shift-click that landed slightly off a part. The guard in
                // `endMarquee` was answering the pointer gesture; this is the click that follows it.
                if (e.shiftKey) return;
                if (e.target === e.currentTarget) onSelect?.(null);
            }}
            onContextMenu={(e) => {
                if (!onContextMenu) return;
                e.preventDefault();
                // WHAT IS UNDER IT, resolved through the tree like every other selection — and a right-click
                // on a part that is NOT selected selects it first, because a menu about something the user
                // cannot see they picked is a menu that acts on a surprise.
                const part = placed.find((q) => {
                    const b = q.symbol.bounds;
                    const at = pointOnSheet(e.clientX, e.clientY);
                    return (
                        at &&
                        at[0] >= q.x + b.minX &&
                        at[0] <= q.x + b.maxX &&
                        at[1] >= q.y + b.minY &&
                        at[1] <= q.y + b.maxY
                    );
                });
                const node = part ? (byPath.get(componentPath(part.id)) ?? null) : null;
                if (node && !selection.has(pathKey(node.ref.path))) onSelect?.(node);
                onContextMenu({ x: e.clientX, y: e.clientY }, node);
            }}
            onPointerMove={marquee ? moveMarquee : wire ? moveWire : pan ? movePan : drag ? moveDrag : undefined}
            onPointerUp={marquee ? endMarquee : wire ? endWire : pan ? endPan : drag ? endDrag : undefined}
            // CANCELLED, NOT FINISHED. This used to route to the same function as pointerup, so a gesture the
            // BROWSER aborted — a device removed, an OS interruption, a touch becoming a two-finger gesture —
            // wrote geometry, minted a revision and scheduled a save. The file's own docstring said the
            // opposite: a cancelled drag is a piece of state that stopped existing.
            onPointerCancel={() => {
                setWire(null);
                setPan(null);
                setDrag(null);
                setMarquee(null);
            }}
        >
            {/* THE WIRE BEING DRAWN, which is not a wire yet. Dashed and in the accent colour so it cannot be
                mistaken for one the document carries, and drawn straight to the pointer rather than routed:
                routing it would say the connection exists, and it does not until the pointer comes up. */}
            {wire &&
                (() => {
                    const p = placed.find((q) => q.id === wire.from.componentId);
                    const s = p?.symbol.pins.find((q) => q.pinId === wire.from.pinId);
                    return p && s ? (
                        <line
                            data-testid="wire-in-flight"
                            x1={p.x + s.x}
                            y1={p.y + s.y}
                            x2={wire.at.x}
                            y2={wire.at.y}
                            stroke="var(--accent, #6cf)"
                            strokeWidth={1}
                            strokeDasharray="5 3"
                        />
                    ) : null;
                })()}

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
                        stroke={
                            netProblem(w.netId) === 'error'
                                ? 'var(--bad, #e5484d)'
                                : netProblem(w.netId) !== undefined
                                  ? 'var(--warn, #e3a008)'
                                  : lies
                                    ? 'var(--warn)'
                                    : 'var(--text-faint)'
                        }
                        strokeWidth={netProblem(w.netId) ? 1.6 : 1}
                        strokeDasharray={lies ? '4 3' : undefined}
                        data-net={w.netName}
                        data-problem={netProblem(w.netId) ?? undefined}
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

            {/* THE REFERENCE, MARKED AT EVERY PIN THAT REACHES IT. Not selectable and not draggable, because
                these are not objects in the design — they are how the drawing SPELLS a connection the netlist
                already has, the way a schematic always has. The author's own ground components are drawn with
                the parts above and stay selectable, movable and deletable like anything else. */}
            {glyphs.map((g) => (
                <g
                    key={g.id}
                    data-testid="ground-glyph"
                    // WHICH TERMINAL this marks. A mark is only meaningful as a statement about a
                    // particular pin, and without saying so nothing outside can tell one from another —
                    // including a test that means to check the mark follows the part it belongs to.
                    data-annotates={g.annotates}
                    transform={`translate(${draggedGlyph(g).x} ${draggedGlyph(g).y})`}
                    aria-hidden
                >
                    {g.symbol.strokes.map((st, i) => (
                        <polyline
                            key={i}
                            points={st.points.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke="var(--text, #ccc)"
                            strokeWidth={1.4}
                        />
                    ))}
                </g>
            ))}

            {/* WHAT THE KEYS DO, said out loud rather than left to be discovered. Every verb here is a key
                and none of them was written down anywhere a screen reader could read; the context menu shows
                them to a sighted user and this is the same courtesy. */}
            <desc id="schematic-keys">
                Tab reaches the object tree and the arrow keys move within it; Enter selects a row. R turns the
                selection, X and Y mirror it, Ctrl+D copies it, Delete removes it. With two terminals selected, W joins
                them into one net; S takes the selected terminals off their net onto a new one, together.
            </desc>

            {/* The box, while it is being drawn. Dashed and unfilled at the edges so it never hides what it
                is being drawn over — the parts a user is deciding about are the ones underneath it. */}
            {marquee && (
                <rect
                    data-testid="marquee"
                    x={Math.min(marquee.from[0], marquee.to[0])}
                    y={Math.min(marquee.from[1], marquee.to[1])}
                    width={Math.abs(marquee.to[0] - marquee.from[0])}
                    height={Math.abs(marquee.to[1] - marquee.from[1])}
                    fill="var(--accent, #6cf)"
                    fillOpacity={0.08}
                    stroke="var(--accent, #6cf)"
                    strokeWidth={1}
                    strokeDasharray="4 3"
                />
            )}

            {/* The supply ports. Same treatment as the reference, and each carries the rail's name — the
                one thing a ground symbol never needs and a rail always does. */}
            {rails.map((r) => (
                <g
                    key={r.id}
                    data-testid="rail-glyph"
                    data-annotates={r.annotates}
                    data-rail={r.label}
                    transform={`translate(${draggedGlyph(r).x} ${draggedGlyph(r).y})`}
                    aria-hidden
                >
                    {r.symbol.strokes.map((st, i) => (
                        <polyline
                            key={i}
                            points={st.points.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke="var(--text, #ccc)"
                            strokeWidth={1.4}
                        />
                    ))}
                    <text
                        x={r.symbol.labelAnchor.x}
                        y={r.symbol.labelAnchor.y}
                        // WHICH WAY THE NAME RUNS, decided with the geometry rather than fixed here. Always
                        // centred, it was drawn across its own bar wherever the mark was turned sideways.
                        textAnchor={r.labelRuns}
                        fill="var(--text-dim, #9ad)"
                        fontSize={8}
                    >
                        {r.label}
                    </text>
                </g>
            ))}

            {placed.map((p) => {
                const path = componentPath(p.id);
                // A part the open box is over is drawn as SELECTED, because that is what releasing will make
                // it. Showing it in some third state would be honest about the mechanism and useless about
                // the outcome — what a user wants from a preview is to recognise the result.
                const isSelected = selection.has(path) || catching.has(p.id);
                return (
                    <g
                        key={p.id}
                        data-testid={`symbol-${p.id}`}
                        data-catching={catching.has(p.id) ? 'yes' : undefined}
                        transform={`translate(${dragged(p).x} ${dragged(p).y})`}
                        onPointerDown={(e) => beginDrag(e, p.id)}
                        // Shift extends the selection; what that MEANS is decided one layer up, so this
                        // canvas and the tree cannot come to different conclusions about the same key.
                        data-problem={partProblem(p.id) ?? undefined}
                        onClick={(e) => {
                            // A drag ends with a click on the part that was grabbed. Treating that as a
                            // selection replaced the whole group with the one part just moved, so a group
                            // drag could only ever be done once.
                            if (gestured.current) return;
                            onSelect?.(byPath.get(path) ?? null, e.shiftKey ? 'toggle' : 'replace');
                        }}
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
                        {/* A RING, not a recolour. Changing the symbol's own strokes would make a flagged
                            resistor a different-looking resistor, and a reader has to be able to tell a mark
                            ABOUT a part from the part itself. Sized from the symbol's real bounds so it fits
                            whatever shape it is drawn around. */}
                        {partProblem(p.id) !== undefined && (
                            <rect
                                data-testid={`problem-${p.id}`}
                                x={p.symbol.bounds.minX - 4}
                                y={p.symbol.bounds.minY - 4}
                                width={p.symbol.bounds.maxX - p.symbol.bounds.minX + 8}
                                height={p.symbol.bounds.maxY - p.symbol.bounds.minY + 8}
                                fill="none"
                                stroke={partProblem(p.id) === 'error' ? 'var(--bad, #e5484d)' : 'var(--warn, #e3a008)'}
                                strokeWidth={1.5}
                                strokeDasharray="4 3"
                                rx={3}
                            />
                        )}
                        {p.symbol.strokes.map((s, i) => {
                            // `key` is NOT in here, and that is not a style choice. React reads a key off the
                            // element, not out of a spread props object, so carrying it in `shape` meant the
                            // key was silently absent — every stroke re-created on each render instead of
                            // being matched to the one before it, and a console error on every paint. It is
                            // written on the element, where React looks for it.
                            const shape = {
                                points: s.points.map(([x, y]) => `${x},${y}`).join(' '),
                                stroke: isSelected ? 'var(--accent, #d99a5c)' : 'var(--text, #ccc)',
                                strokeWidth: isSelected ? 2 : 1.4,
                            };
                            return s.closed ? (
                                <polygon key={i} {...shape} fill="var(--panel-raised, #222)" />
                            ) : (
                                <polyline key={i} {...shape} fill="none" />
                            );
                        })}
                        {p.symbol.pins.map((pin) => {
                            const live = wire?.to?.componentId === p.id && wire.to.pinId === pin.pinId;
                            const source = wire?.from.componentId === p.id && wire.from.pinId === pin.pinId;
                            // A SELECTED TERMINAL HAS TO LOOK SELECTED. Clicking one changes what Delete does
                            // and what the Inspector shows, and the drawing was byte-identical to having
                            // nothing selected — so the user pressed the key and could only find out by
                            // watching what disappeared.
                            const marked = selection.has(pinPath(p.id, pin.pinId));
                            return (
                                <g key={pin.pinId}>
                                    <circle
                                        cx={pin.x}
                                        cy={pin.y}
                                        r={live || source || marked ? 4 : 2}
                                        fill={
                                            live || source
                                                ? 'var(--good)'
                                                : marked
                                                  ? 'var(--accent, #6cf)'
                                                  : 'var(--text-faint, #888)'
                                        }
                                    />
                                    {/* THE PART YOU CAN ACTUALLY HIT. A terminal is drawn two units across and a
                                        person cannot reliably put a pointer on two units of anything — least of
                                        all zoomed out, where two units is less than a pixel. This is invisible,
                                        it is sized in PIXELS rather than sheet units so it stays the same size to
                                        the hand at every zoom, and it is what carries the gesture. */}
                                    {onConnect && (
                                        <circle
                                            data-testid={`pin-${p.id}-${pin.pinId}`}
                                            cx={pin.x}
                                            cy={pin.y}
                                            r={grabRadius}
                                            fill="transparent"
                                            style={{ cursor: 'crosshair' }}
                                            onPointerDown={(e) => beginWire(e, p.id, pin.pinId)}
                                            onClick={(e) => {
                                                // A terminal is its own object. Selecting the PART when a
                                                // terminal is clicked would make "delete what is selected"
                                                // ambiguous at exactly the moment it matters.
                                                e.stopPropagation();
                                                onSelect?.(
                                                    byPath.get(pinPath(p.id, pin.pinId)) ?? null,
                                                    e.shiftKey ? 'toggle' : 'replace',
                                                );
                                            }}
                                        />
                                    )}
                                </g>
                            );
                        })}
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
