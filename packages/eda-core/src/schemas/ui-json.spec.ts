/**
 * The drawing's schema, and the one property that matters most about it: it never silently drops anything.
 *
 * A plain `z.object` STRIPS unknown keys. Validating editor state with a schema that had not caught up would
 * therefore delete whatever it did not recognise — a user's wire routing, gone, with a 200 and no message.
 * That is the failure this file exists to make impossible, so most of what follows is about REFUSAL rather
 * than acceptance.
 */
import { z } from 'zod';

import { UiJsonSchema, ViewportSchema, safeValidateUiJson } from './circuit.schema';

const ok = (value: unknown) => safeValidateUiJson(value).success;
const issuesFor = (value: unknown) => {
    const parsed = safeValidateUiJson(value);
    return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'));
};

describe('an empty drawing is valid, because that is the ordinary case', () => {
    it('accepts {} — every draft in existence holds exactly that', () => {
        expect(ok({})).toBe(true);
    });

    it('accepts each part on its own', () => {
        expect(ok({ viewport: { x: 0, y: 0, zoom: 1 } })).toBe(true);
        expect(ok({ positions: {} })).toBe(true);
        expect(ok({ wires: [] })).toBe(true);
        expect(ok({ sheetId: 'main' })).toBe(true);
        expect(ok({ schemaVersion: 1 })).toBe(true);
    });
});

describe('nothing is silently discarded', () => {
    it('REFUSES an unknown key rather than stripping it', () => {
        // The whole reason for `.strict()`. Under a plain object this would have passed and the field would
        // have vanished from the stored document without a trace.
        const parsed = UiJsonSchema.safeParse({ viewport: { x: 0, y: 0, zoom: 1 }, selection: ['r1'] });
        expect(parsed.success).toBe(false);
        expect(issuesFor({ selection: ['r1'] })).toContain('');
    });

    it('refuses an unknown key nested inside a wire, a position and the viewport', () => {
        expect(ok({ wires: [{ netId: 'n', points: [], colour: 'red' }] })).toBe(false);
        expect(ok({ positions: { r1: { x: 0, y: 0, locked: true } } })).toBe(false);
        expect(ok({ viewport: { x: 0, y: 0, zoom: 1, rotation: 0 } })).toBe(false);
    });

    it('shows what a permissive schema would have done instead: accept, and DELETE the field', () => {
        // A guard on the guard, and the clearest statement of what `.strict()` bought. The same input against
        // a non-strict twin passes — and the field is simply gone from the parsed result, with nothing
        // anywhere reporting it. That silent deletion is what would have reached the database.
        const permissive = z.object({ viewport: ViewportSchema.optional() });
        const input = { viewport: { x: 0, y: 0, zoom: 1 }, selection: ['r1'] };

        const loose = permissive.safeParse(input);
        expect(loose.success).toBe(true);
        expect(loose.success && 'selection' in loose.data).toBe(false); // dropped, without a word

        expect(safeValidateUiJson(input).success).toBe(false); // ours refuses instead
    });
});

describe('a coordinate is a coordinate', () => {
    it('refuses a rotation on a WIRE VERTEX — a point has no orientation', () => {
        // The TypeScript type used to say `Position[]` here while the schema said `{x, y}`. Neither looked
        // wrong alone, which is exactly how that kind of drift survives review.
        expect(ok({ wires: [{ netId: 'n', points: [{ x: 0, y: 0, rotation: '90' }] }] })).toBe(false);
    });

    it('refuses NaN and Infinity, which JSON turns into null and a renderer cannot use', () => {
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            expect({ bad, ok: ok({ viewport: { x: bad, y: 0, zoom: 1 } }) }).toEqual({ bad, ok: false });
            expect({ bad, ok: ok({ positions: { r1: { x: bad, y: 0 } } }) }).toEqual({ bad, ok: false });
        }
    });

    it('refuses a zoom of zero or below — every transform divides by it', () => {
        expect(ok({ viewport: { x: 0, y: 0, zoom: 0 } })).toBe(false);
        expect(ok({ viewport: { x: 0, y: 0, zoom: -1 } })).toBe(false);
        expect(ok({ viewport: { x: 0, y: 0, zoom: 0.01 } })).toBe(true);
    });
});

describe('a symbol can be oriented', () => {
    it('accepts the four quarter turns and refuses anything else', () => {
        for (const rotation of ['0', '90', '180', '270']) {
            expect({ rotation, ok: ok({ positions: { r1: { x: 0, y: 0, rotation } } }) }).toEqual({
                rotation,
                ok: true,
            });
        }
        expect(ok({ positions: { r1: { x: 0, y: 0, rotation: '45' } } })).toBe(false);
        expect(ok({ positions: { r1: { x: 0, y: 0, rotation: 90 } } })).toBe(false); // number, not the literal
    });

    it('accepts a mirror, which rotation alone cannot express', () => {
        // An op-amp with its inputs on the right, a connector facing the other way — routine, and not a
        // rotation of anything.
        expect(ok({ positions: { r1: { x: 0, y: 0, mirror: 'x' } } })).toBe(true);
        expect(ok({ positions: { r1: { x: 0, y: 0, mirror: 'y', rotation: '90' } } })).toBe(true);
        expect(ok({ positions: { r1: { x: 0, y: 0, mirror: 'diagonal' } } })).toBe(false);
    });
});

describe('a wire records what it was attached to', () => {
    it('accepts an endpoint bound to a pin', () => {
        expect(
            ok({
                wires: [
                    {
                        id: 'w1',
                        netId: 'gnd',
                        points: [
                            { x: 0, y: 0 },
                            { x: 10, y: 0 },
                        ],
                        from: { componentId: 'r1', pinId: '2' },
                        to: { componentId: 'gnd1', pinId: '1' },
                    },
                ],
            }),
        ).toBe(true);
    });

    it('distinguishes "attached to nothing" from "not recorded"', () => {
        // `null` is a real state — a wire drawn into empty space. `undefined` is an older drawing that never
        // recorded the binding. Collapsing them would make a deliberate loose end indistinguishable from a
        // document we simply cannot read.
        expect(ok({ wires: [{ netId: 'n', points: [], from: null, to: null }] })).toBe(true);
        expect(ok({ wires: [{ netId: 'n', points: [] }] })).toBe(true);
    });

    it('refuses a half-written pin reference', () => {
        expect(ok({ wires: [{ netId: 'n', points: [], from: { componentId: 'r1' } }] })).toBe(false);
        expect(ok({ wires: [{ netId: 'n', points: [], from: { componentId: '', pinId: '1' } }] })).toBe(false);
    });

    it('requires a net — a wire that belongs to nothing is not a connection', () => {
        expect(ok({ wires: [{ points: [] }] })).toBe(false);
        expect(ok({ wires: [{ netId: '', points: [] }] })).toBe(false);
    });
});

describe('the document a drawing arrives in cannot be unbounded', () => {
    it('caps wires and points, so one request cannot become an unbounded write', () => {
        const manyWires = { wires: Array.from({ length: 5001 }, () => ({ netId: 'n', points: [] })) };
        expect(ok(manyWires)).toBe(false);

        const manyPoints = {
            wires: [{ netId: 'n', points: Array.from({ length: 501 }, (_, i) => ({ x: i, y: 0 })) }],
        };
        expect(ok(manyPoints)).toBe(false);
    });

    it('accepts a realistically large drawing', () => {
        const realistic = {
            schemaVersion: 1 as const,
            viewport: { x: -120, y: 40, zoom: 1.5 },
            positions: Object.fromEntries(
                Array.from({ length: 300 }, (_, i) => [`c${i}`, { x: i * 20, y: (i % 10) * 20, rotation: '90' }]),
            ),
            wires: Array.from({ length: 400 }, (_, i) => ({
                id: `w${i}`,
                netId: `n${i % 50}`,
                points: [
                    { x: i, y: 0 },
                    { x: i, y: 10 },
                    { x: i + 5, y: 10 },
                ],
                from: { componentId: `c${i % 300}`, pinId: '1' },
                to: null,
            })),
            sheetId: 'main',
        };
        expect(ok(realistic)).toBe(true);
    });
});

describe('what the two drawings in the live database look like', () => {
    it('still validates the original shape, which has no ids and no schemaVersion', () => {
        // Backwards compatibility is not theoretical here: the field has existed for months and two rows
        // hold real coordinates. Rejecting them would make those projects unopenable.
        expect(
            ok({
                viewport: { x: 0, y: 0, zoom: 1 },
                positions: { r1: { x: 10, y: 20 }, c1: { x: 30, y: 20, rotation: '270' } },
                wires: [{ netId: 'gnd', points: [{ x: 0, y: 0 }] }],
            }),
        ).toBe(true);
    });
});
