/**
 * Placements the CALLER owns, and every stage that would quietly take them back.
 *
 * The engine has five places where a coordinate is written — seed, rotation sweep, force integration, the
 * legalizer's ring walk, and the final recentre — and a pin survives only if all five agree to leave it
 * alone. Four of those are obvious once named. The fifth is not: the recentre subtracts the content midpoint
 * from every position, which is invisible when the engine owns every coordinate and silently relocates a
 * pinned part when it does not. Each has a test here, and each was mutation-checked.
 */
import { placeParts, validateFixedPlacements, type PlaceablePart, type PlacementInput } from './placement';

const part = (id: string, over: Partial<PlaceablePart> = {}): PlaceablePart => ({
    id,
    w: 4,
    h: 4,
    role: 'part',
    pads: [{ x: 0, y: 0, net: 'N' }],
    ...over,
});

const input = (parts: PlaceablePart[], over: Partial<PlacementInput> = {}): PlacementInput => ({
    parts,
    netWeights: { N: 1 },
    boardW: 60,
    boardH: 60,
    gridMm: 0.5,
    marginMm: 4,
    ...over,
});

describe('a pinned part stays exactly where it was put', () => {
    it('is delivered at its pinned coordinates, to the millimetre', () => {
        const out = placeParts(input([part('A', { fixed: { x: 12, y: -4 } }), part('B'), part('C')]));
        expect(out.ok).toBe(true);
        expect(out.positions.A).toEqual({ x: 12, y: -4, rotation: 0 });
    });

    it('survives the final RECENTRE — the stage that hides this best', () => {
        // Every position is normally emitted relative to the content midpoint. With the pinned part far
        // off-centre that midpoint is far from zero, so an unfrozen frame delivers A somewhere else while
        // every courtyard check still passes: the arrangement is internally identical, just moved.
        const out = placeParts(input([part('A', { fixed: { x: 20, y: 18 } }), part('B'), part('C'), part('D')]));
        expect(out.positions.A).toEqual({ x: 20, y: 18, rotation: 0 });
    });

    it('keeps a pinned ROTATION instead of searching for a better one', () => {
        const out = placeParts(input([part('A', { w: 8, h: 2, fixed: { x: 0, y: 0, rotation: 90 } }), part('B')]));
        expect(out.positions.A?.rotation).toBe(90);
    });

    it('still lets the engine CHOOSE the rotation when only a position is pinned', () => {
        // Not a shortcut — a real degree of freedom. "Stay here, orient however routes best."
        const out = placeParts(input([part('A', { fixed: { x: 0, y: 0 } }), part('B')]));
        expect(out.positions.A).toMatchObject({ x: 0, y: 0 });
        expect([0, 90, 180, 270]).toContain(out.positions.A?.rotation);
    });

    it('does NOT park a free part on top of a pinned one', () => {
        // The legalizer walks parts by descending area and skips cells already taken. A pinned part that is
        // not marked as taken BEFORE that walk is invisible to everything legalized before it, and the
        // engine returns ok:true with two courtyards in the same square millimetre.
        const parts = [part('BIG', { w: 10, h: 10 }), part('PIN', { w: 6, h: 6, fixed: { x: 0, y: 0 } })];
        const out = placeParts(input(parts, { spacingMm: 2 }));
        expect(out.ok).toBe(true);
        const a = out.positions.PIN!;
        const b = out.positions.BIG!;
        const gapX = Math.abs(a.x - b.x) - (6 / 2 + 10 / 2);
        const gapY = Math.abs(a.y - b.y) - (6 / 2 + 10 / 2);
        expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(2 - 1e-6);
    });

    it('pins EVERY part when every part is pinned', () => {
        const parts = [
            part('A', { fixed: { x: -10, y: -10 } }),
            part('B', { fixed: { x: 10, y: -10 } }),
            part('C', { fixed: { x: 0, y: 10 } }),
        ];
        const out = placeParts(input(parts));
        expect(out.ok).toBe(true);
        expect(out.positions).toMatchObject({
            A: { x: -10, y: -10 },
            B: { x: 10, y: -10 },
            C: { x: 0, y: 10 },
        });
    });

    it('leaves an unpinned board exactly as it was — pinning must cost nothing when unused', () => {
        // The frame freeze and every guard are conditional. A board with no pins must produce byte-identical
        // output to the one it produced before this feature existed.
        const parts = [part('A'), part('B'), part('C')];
        const a = placeParts(input(parts));
        const b = placeParts(input(parts));
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        // …and the content is still recentred, which is the behaviour pinning suspends.
        const xs = Object.values(a.positions).map((p) => p.x);
        expect(Math.min(...xs) + Math.max(...xs)).toBeLessThanOrEqual(1);
    });

    it('is deterministic with pins, like everything else in this engine', () => {
        const parts = [part('A', { fixed: { x: 6, y: 6 } }), part('B'), part('C')];
        expect(JSON.stringify(placeParts(input(parts)))).toBe(JSON.stringify(placeParts(input(parts))));
    });
});

describe('pins that cannot be honoured are named, not silently adjusted', () => {
    const check = (parts: PlaceablePart[], over: { grid?: number; margin?: number; spacing?: number } = {}) =>
        validateFixedPlacements(parts, 60, 60, over.grid ?? 0.5, over.margin ?? 4, over.spacing ?? 2.4);

    it('refuses an off-grid pin rather than snapping it', () => {
        // The legalizer snaps freely — it must, it is choosing. Snapping a PINNED part moves the one thing
        // the caller asked not to move, and moves it without saying so.
        const p = check([part('A', { fixed: { x: 7.48, y: 0 } })]);
        expect(p).toEqual([{ kind: 'off-grid', id: 'A', axis: 'x', given: 7.48, nearest: 7.5 }]);
    });

    it('accepts a coordinate that is on the grid but arrived as a lumpy double', () => {
        // These come in as JSON numbers: 7.5 can be 7.499999999999999. An exact comparison would refuse
        // coordinates that ARE legal, which is the worst kind of false rejection — the remedy it names is
        // the value the caller already sent.
        expect(check([part('A', { fixed: { x: 7.5 - 1e-12, y: 0 } })])).toEqual([]);
    });

    it('refuses a pin whose courtyard hangs off the board, naming the limit', () => {
        const p = check([part('A', { w: 4, h: 4, fixed: { x: 29, y: 0 } })]);
        expect(p[0]).toMatchObject({ kind: 'off-board', id: 'A', axis: 'x' });
        expect((p[0] as { limit: number }).limit).toBe(60 / 2 - 4 - 2); // half board − margin − half width
    });

    it('accounts for ROTATION when judging the board edge', () => {
        // A part 2 mm wide and 20 mm tall fits at the right edge upright and does not at 90°.
        const tall = part('A', { w: 2, h: 20 });
        expect(check([{ ...tall, fixed: { x: 24, y: 0, rotation: 0 } }])).toEqual([]);
        expect(check([{ ...tall, fixed: { x: 24, y: 0, rotation: 90 } }])[0]).toMatchObject({ kind: 'off-board' });
    });

    it('refuses two pinned courtyards that overlap, and says by how much to move', () => {
        // The remedy as a number the caller can act on, not "these overlap".
        const p = check([
            part('A', { w: 10, h: 10, fixed: { x: 0, y: 0 } }),
            part('B', { w: 10, h: 10, fixed: { x: 8, y: 0 } }),
        ]);
        expect(p).toEqual([{ kind: 'overlap', a: 'A', b: 'B', byMm: 4.4 }]); // 5+5+2.4 − 8
    });

    it('judges pinned pairs by the SAME spacing rule the legalizer applies', () => {
        const parts = [
            part('A', { w: 10, h: 10, fixed: { x: 0, y: 0 } }),
            part('B', { w: 10, h: 10, fixed: { x: 12, y: 0 } }),
        ];
        expect(check(parts, { spacing: 2 })).toEqual([]); // 5+5+2 = 12, exactly touching the rule
        expect(check(parts, { spacing: 2.4 })[0]).toMatchObject({ kind: 'overlap' });
    });

    it('says nothing about a pinned part overlapping a FREE one — that is the engine’s job', () => {
        const p = check([part('A', { w: 10, h: 10, fixed: { x: 0, y: 0 } }), part('B', { w: 10, h: 10 })]);
        expect(p).toEqual([]);
    });

    it('says nothing at all when nothing is pinned', () => {
        expect(check([part('A'), part('B')])).toEqual([]);
    });
});
