/**
 * The comparison that decides whether a document changed.
 *
 * It gets its own file because getting it wrong is silent in both directions, and both directions were
 * observed rather than imagined:
 *
 *   • Too strict (`JSON.stringify`) and two identical documents compare as different. Postgres `jsonb` does
 *     not preserve key order, so EVERY document that has been through the server compares as different from
 *     the one that was sent. A gesture that changed nothing then commits itself and bumps the concurrency
 *     token, and a local copy identical to the server's is offered back as unsaved work.
 *   • Too loose and a real change is missed, which means an edit that never saves — the worst outcome
 *     available, because the user watched it happen on screen.
 */
import { sameJson } from './same-json';

describe('two documents are the same document', () => {
    it('ignores the order object keys happen to be in', () => {
        // Measured, not assumed: a drawing sent to the live API as {schemaVersion, positions, sheetId} comes
        // back as {sheetId, positions, schemaVersion} — jsonb sorts keys by length, then bytewise.
        const sent = { schemaVersion: 1, positions: { r1: { x: 220, y: 80 } }, sheetId: 'main' };
        const returned = { sheetId: 'main', positions: { r1: { y: 80, x: 220 } }, schemaVersion: 1 };
        expect(sameJson(sent, returned)).toBe(true);
    });

    it('treats an explicitly undefined field as an absent one', () => {
        // What a round trip does to it: `{rotation: undefined}` is stored and returned as `{}`. Calling
        // those different would make the first comparison after every reload report a change nobody made.
        expect(sameJson({ x: 1, rotation: undefined }, { x: 1 })).toBe(true);
        expect(sameJson({ x: 1 }, { x: 1, rotation: undefined })).toBe(true);
    });

    it('does NOT ignore the order of an array', () => {
        // A wire's points are a path. The same points in the other order are a different path, and a
        // comparison that sorted them would erase a real edit.
        expect(sameJson([{ x: 0 }, { x: 10 }], [{ x: 10 }, { x: 0 }])).toBe(false);
        expect(sameJson([1, 2, 3], [1, 2, 3])).toBe(true);
    });

    it('separates a missing key from a null one', () => {
        // `null` is a value the schema can hold — a wire endpoint attached to nothing is `from: null`, and
        // it is deliberately different from "we never recorded it".
        expect(sameJson({ from: null }, {})).toBe(false);
        expect(sameJson({ from: null }, { from: null })).toBe(true);
    });

    it('notices a real change in any position', () => {
        const base = { positions: { r1: { x: 10, y: 20 }, r2: { x: 0, y: 0 } } };
        for (const other of [
            { positions: { r1: { x: 11, y: 20 }, r2: { x: 0, y: 0 } } }, // moved
            { positions: { r1: { x: 10, y: 20, rotation: '90' }, r2: { x: 0, y: 0 } } }, // turned
            { positions: { r1: { x: 10, y: 20 } } }, // one part dropped
            { positions: {} }, // cleared
            {}, // no drawing at all
        ]) {
            expect({ other, same: sameJson(base, other) }).toEqual({ other, same: false });
        }
    });

    it('does not confuse an array with an object that has the same numeric keys', () => {
        // `{0: 'a', 1: 'b'}` and `['a','b']` stringify differently but walk identically under a naive
        // key-by-key comparison, and they are not the same value to anything that reads them.
        expect(sameJson(['a', 'b'], { 0: 'a', 1: 'b' })).toBe(false);
    });

    it('compares primitives and mixed types without throwing', () => {
        expect(sameJson(1, 1)).toBe(true);
        expect(sameJson('1', 1)).toBe(false);
        expect(sameJson(null, undefined)).toBe(false);
        expect(sameJson({}, null)).toBe(false);
        expect(sameJson(null, null)).toBe(true);
    });

    it('handles a drawing the size of a real board without blowing the stack', () => {
        // 400 parts and 5000 wire points is the top of what the schema allows. This runs once per gesture,
        // not per frame, but a recursive comparison that overflowed here would fail only on real designs.
        const drawing = (nudge: number) => ({
            positions: Object.fromEntries(
                Array.from({ length: 400 }, (_, i) => [`c${i}`, { x: i * 10 + nudge, y: i * 3 }]),
            ),
            wires: Array.from({ length: 200 }, (_, w) => ({
                id: `w${w}`,
                netId: `n${w}`,
                points: Array.from({ length: 25 }, (_, p) => ({ x: p, y: w })),
            })),
        });
        expect(sameJson(drawing(0), drawing(0))).toBe(true);
        expect(sameJson(drawing(0), drawing(1))).toBe(false);
    });
});
