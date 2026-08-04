/**
 * The commit kernel, against every gallery circuit.
 *
 * Undo is one of the few features whose bugs are silent AND destructive: a stack that drops an entry loses
 * work the user believes is recoverable, and one that restores the wrong document replaces work that was
 * fine. Both look like nothing happening. So the invariants here are checked over real designs and over
 * long random sequences, not on a two-component fixture.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CircuitJson, UiJson } from '@circuit-forge/eda-core';

import { setDesignator, setNetName, setValue } from './edits';
import {
    HISTORY_LIMIT,
    adopt,
    beginHistory,
    canRedo,
    canUndo,
    commit,
    commitUi,
    isEmptyTouch,
    redo,
    touchedBetween,
    undo,
    type EditorDocument,
    type History,
} from './history';

/** The same real designs the rest of the system is tested against — never a copy. */
let GALLERY: Array<[string, CircuitJson]> = [];

beforeAll(() => {
    const url = pathToFileURL(join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'gallery-circuits.mjs')).href;
    const json = execFileSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `const m = await import(${JSON.stringify(url)}); console.log(JSON.stringify(m.galleryCases));`,
        ],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    GALLERY = JSON.parse(json) as Array<[string, CircuitJson]>;
}, 60_000);

const forEachCircuit = (assert: (name: string, circuit: CircuitJson) => void): void => {
    expect(GALLERY.length).toBeGreaterThanOrEqual(8);
    for (const [name, circuit] of GALLERY) assert(name, circuit);
};

const docOf = (circuit: CircuitJson): EditorDocument => ({ circuit, ui: {} });
const firstId = (h: History) => (h.present.circuit.components ?? [])[0]!.id;
const designatorOf = (h: History) => (h.present.circuit.components ?? [])[0]!.designator;

describe('a commit is all or nothing', () => {
    it('applies a list of edits as ONE revision', () => {
        forEachCircuit((name, circuit) => {
            const parts = circuit.components ?? [];
            if (parts.length < 3) return;
            const h = beginHistory(docOf(circuit));

            const result = commit(h, 'Rename three', [
                (c) => setDesignator(c, parts[0]!.id, 'ZA1'),
                (c) => setDesignator(c, parts[1]!.id, 'ZB2'),
                (c) => setDesignator(c, parts[2]!.id, 'ZC3'),
            ]);
            expect({ name, ok: result.ok }).toEqual({ name, ok: true });
            if (!result.ok) return;

            // Three changes, ONE undo step — the property that makes multi-select deletion usable.
            expect({ name, depth: result.history.past.length }).toEqual({ name, depth: 1 });
            const back = undo(result.history);
            expect({ name, restored: back.present.circuit }).toEqual({ name, restored: circuit });
        });
    });

    it('refuses the WHOLE commit when one edit is refused, and leaves the history untouched', () => {
        // The guarantee that makes a compound operation safe to interrupt: there is no state in which half
        // of it happened and the other half has to be found and undone by hand.
        forEachCircuit((name, circuit) => {
            const parts = circuit.components ?? [];
            if (parts.length < 2) return;
            const h = beginHistory(docOf(circuit));

            const result = commit(h, 'One good, one impossible', [
                (c) => setDesignator(c, parts[0]!.id, 'ZZ98'),
                (c) => setDesignator(c, parts[1]!.id, ''), // refused: empty
                (c) => setDesignator(c, parts[0]!.id, 'ZZ99'),
            ]);

            expect({ name, ok: result.ok, index: result.ok ? null : result.index }).toEqual({
                name,
                ok: false,
                index: 1,
            });
            // Not one character of the first edit survived.
            expect({ name, present: h.present.circuit }).toEqual({ name, present: circuit });
            expect({ name, depth: h.past.length }).toEqual({ name, depth: 0 });
        });
    });

    it('lets a later edit see an earlier one — that is what makes a compound edit expressible', () => {
        forEachCircuit((name, circuit) => {
            const parts = circuit.components ?? [];
            if (parts.length < 2) return;
            const h = beginHistory(docOf(circuit));

            // Swapping two designators is only possible if the second edit sees the first. Via a temporary,
            // exactly as a person would do it.
            const a = parts[0]!;
            const b = parts[1]!;
            const result = commit(h, 'Swap R1/R2', [
                (c) => setDesignator(c, a.id, 'TMP9'),
                (c) => setDesignator(c, b.id, a.designator),
                (c) => setDesignator(c, a.id, b.designator),
            ]);
            expect({ name, ok: result.ok }).toEqual({ name, ok: true });
            if (!result.ok) return;

            const after = result.history.present.circuit.components ?? [];
            expect({ name, a: after[0]!.designator, b: after[1]!.designator }).toEqual({
                name,
                a: b.designator,
                b: a.designator,
            });
        });
    });

    it('a commit that changed nothing is not a revision', () => {
        // Re-typing the same value must not mint an undo step the user then has to press through, nor a
        // save that conflicts with another tab for no reason at all.
        forEachCircuit((name, circuit) => {
            const h = beginHistory(docOf(circuit));
            const parts = circuit.components ?? [];
            const result = commit(h, 'No-op', [(c) => setDesignator(c, parts[0]!.id, parts[0]!.designator)]);
            expect({
                name,
                changed: result.ok && result.changed,
                depth: result.ok ? result.history.past.length : -1,
            }).toEqual({ name, changed: false, depth: 0 });
        });
    });
});

describe('undo and redo', () => {
    it('walks back and forward through a sequence and lands exactly where it started', () => {
        forEachCircuit((name, circuit) => {
            let h = beginHistory(docOf(circuit));
            const id = firstId(h);
            const original = designatorOf(h);

            for (const d of ['ZA1', 'ZB2', 'ZC3']) {
                const r = commit(h, `Rename to ${d}`, [(c) => setDesignator(c, id, d)]);
                if (r.ok) h = r.history;
            }
            expect({ name, at: designatorOf(h) }).toEqual({ name, at: 'ZC3' });

            h = undo(undo(undo(h)));
            expect({ name, at: designatorOf(h), canUndo: canUndo(h) }).toEqual({ name, at: original, canUndo: false });

            h = redo(redo(redo(h)));
            expect({ name, at: designatorOf(h), canRedo: canRedo(h) }).toEqual({ name, at: 'ZC3', canRedo: false });
        });
    });

    it('is a no-op at either end, so a keybinding needs no guard', () => {
        forEachCircuit((name, circuit) => {
            const h = beginHistory(docOf(circuit));
            expect({ name, undoIsSame: undo(h) === h, redoIsSame: redo(h) === h }).toEqual({
                name,
                undoIsSame: true,
                redoIsSame: true,
            });
        });
    });

    it('discards the redo branch when a new edit is made after an undo', () => {
        // Keeping it would let a user redo their way into a document that never existed: the branch was
        // taken, and the other one is gone.
        forEachCircuit((name, circuit) => {
            let h = beginHistory(docOf(circuit));
            const id = firstId(h);

            const first = commit(h, 'a', [(c) => setDesignator(c, id, 'ZA1')]);
            if (first.ok) h = first.history;
            h = undo(h);
            expect({ name, canRedo: canRedo(h) }).toEqual({ name, canRedo: true });

            const other = commit(h, 'b', [(c) => setDesignator(c, id, 'ZB2')]);
            if (other.ok) h = other.history;
            expect({ name, canRedo: canRedo(h), at: designatorOf(h) }).toEqual({ name, canRedo: false, at: 'ZB2' });
        });
    });

    it('carries the label, so an undo menu can name what it will reverse', () => {
        forEachCircuit((name, circuit) => {
            const h = beginHistory(docOf(circuit));
            const r = commit(h, 'Rename R1', [(c) => setDesignator(c, firstId(h), 'ZA1')]);
            expect({ name, label: r.ok && r.changed ? r.history.past[0]!.label : null }).toEqual({
                name,
                label: 'Rename R1',
            });
        });
    });

    it('bounds the stack — an editor is a long-lived tab and an unbounded stack is a leak', () => {
        forEachCircuit((name, circuit) => {
            let h = beginHistory(docOf(circuit));
            const id = firstId(h);
            for (let i = 0; i < HISTORY_LIMIT + 25; i++) {
                const r = commit(h, `edit ${i}`, [(c) => setDesignator(c, id, `Z${i}`)]);
                if (r.ok) h = r.history;
            }
            expect({ name, depth: h.past.length }).toEqual({ name, depth: HISTORY_LIMIT });
            // …and the entries kept are the RECENT ones, not the oldest.
            expect({ name, newest: h.past[h.past.length - 1]!.label }).toEqual({
                name,
                newest: `edit ${HISTORY_LIMIT + 24}`,
            });
        });
    });
});

describe('adopting a document from elsewhere', () => {
    it('drops the history, so nothing can be undone across work this editor did not author', () => {
        // Undoing past an adopted document would restore state predating whatever the other author saved,
        // quietly resurrecting work they had already replaced.
        forEachCircuit((name, circuit) => {
            let h = beginHistory(docOf(circuit));
            const r = commit(h, 'mine', [(c) => setDesignator(c, firstId(h), 'ZA1')]);
            if (r.ok) h = r.history;
            expect({ name, canUndo: canUndo(h) }).toEqual({ name, canUndo: true });

            const theirs = adopt(docOf(circuit));
            expect({ name, canUndo: canUndo(theirs), canRedo: canRedo(theirs) }).toEqual({
                name,
                canUndo: false,
                canRedo: false,
            });
        });
    });
});

describe('what a revision touched', () => {
    it('names exactly the objects that changed, by identity rather than by id', () => {
        // Ids are not guaranteed unique — the object tree treats duplicates as expected input — so a set
        // keyed on id would silently merge two different parts into one entry.
        forEachCircuit((name, circuit) => {
            const parts = circuit.components ?? [];
            const h = beginHistory(docOf(circuit));
            const r = commit(h, 'one rename', [(c) => setDesignator(c, parts[0]!.id, 'ZA1')]);
            if (!r.ok || !r.changed) return;

            const touched = r.history.past[0]!.touched;
            expect({ name, components: touched.components.size, nets: touched.nets.size }).toEqual({
                name,
                components: 1,
                nets: 0,
            });
            // The object in the set is the NEW one — the thing a checker would have to re-examine.
            const changedObject = [...touched.components][0] as { designator: string };
            expect({ name, designator: changedObject.designator }).toEqual({ name, designator: 'ZA1' });
        });
    });

    it('separates a net change from a component change', () => {
        forEachCircuit((name, circuit) => {
            const h = beginHistory(docOf(circuit));
            const netId = (circuit.nets ?? [])[0]!.id;
            const r = commit(h, 'rename net', [(c) => setNetName(c, netId, 'ZZNET')]);
            if (!r.ok || !r.changed) return;
            const touched = r.history.past[0]!.touched;
            expect({ name, components: touched.components.size, nets: touched.nets.size }).toEqual({
                name,
                components: 0,
                nets: 1,
            });
        });
    });

    it('reports nothing touched between a document and itself', () => {
        forEachCircuit((name, circuit) => {
            const d = docOf(circuit);
            expect({ name, empty: isEmptyTouch(touchedBetween(d, d)) }).toEqual({ name, empty: true });
        });
    });

    it('notices a removal, which leaves no new reference to find', () => {
        forEachCircuit((name, circuit) => {
            const before = docOf(circuit);
            const after = docOf({ ...circuit, components: (circuit.components ?? []).slice(1) });
            const touched = touchedBetween(before, after);
            expect({ name, other: touched.other }).toEqual({ name, other: true });
        });
    });

    it('notices a UI-only change', () => {
        forEachCircuit((name, circuit) => {
            const h = beginHistory(docOf(circuit));
            const r = commitUi(h, 'pan', { viewport: { x: 10, y: 0, zoom: 1 } });
            expect({ name, ok: r.ok, changed: r.ok && r.changed }).toEqual({ name, ok: true, changed: true });
            if (!r.ok || !r.changed) return;
            expect({ name, other: r.history.past[0]!.touched.other }).toEqual({ name, other: true });
            // …and undoing it restores the previous UI state, not just the circuit.
            expect({ name, ui: undo(r.history).present.ui }).toEqual({ name, ui: {} });
        });
    });

    describe('a drawing that did not change is not a revision', () => {
        // Reference comparison reads as sufficient here and never fires: a caller derives the next drawing
        // immutably, so it hands back a NEW object every time — including a drag dropped exactly where it
        // started, or rotate pressed four times. Calling those changes mints an undo step that visibly does
        // nothing AND a save that bumps the concurrency token, so another tab's real work is refused
        // because of a gesture that changed nothing.
        const arranged = { schemaVersion: 1 as const, positions: { r1: { x: 10, y: 20 } } };
        const start = () => commitUi(beginHistory(docOf(GALLERY[0]![1])), 'arrange', arranged);

        it('an equal drawing built as a different object commits nothing', () => {
            const r = start();
            expect(r.ok && r.changed).toBe(true);
            if (!r.ok) throw new Error('unreachable');

            const again = commitUi(r.history, 'move R1', {
                schemaVersion: 1,
                positions: { r1: { x: 10, y: 20 } },
            });
            expect(again.ok && again.changed).toBe(false);
            expect(again.ok && again.history).toBe(r.history); // untouched, not rebuilt
        });

        it('key ORDER is not a change — which order a spread produces is the caller’s business', () => {
            const r = start();
            if (!r.ok) throw new Error('unreachable');
            const reordered = commitUi(r.history, 'move R1', {
                positions: { r1: { y: 20, x: 10 } },
                schemaVersion: 1,
            });
            expect(reordered.ok && reordered.changed).toBe(false);
        });

        it('an absent field and an explicitly undefined one are the same drawing', () => {
            // What a round trip through the server does: `{ rotation: undefined }` is stored and returned
            // as `{}`. Treating them as different would make the first save after every reload a change
            // that commits itself.
            const r = start();
            if (!r.ok) throw new Error('unreachable');
            const withUndefined = commitUi(r.history, 'move R1', {
                schemaVersion: 1,
                positions: { r1: { x: 10, y: 20, rotation: undefined } },
                viewport: undefined,
            });
            expect(withUndefined.ok && withUndefined.changed).toBe(false);
        });

        it('but a real move IS a change, in any field', () => {
            const r = start();
            if (!r.ok) throw new Error('unreachable');
            const variants: UiJson[] = [
                { schemaVersion: 1, positions: { r1: { x: 11, y: 20 } } }, // moved one unit
                { schemaVersion: 1, positions: { r1: { x: 10, y: 20, rotation: '90' } } }, // turned
                { schemaVersion: 1, positions: { r1: { x: 10, y: 20 }, r2: { x: 0, y: 0 } } }, // one more part
                { schemaVersion: 1, positions: {} }, // arrangement cleared
            ];
            for (const next of variants) {
                const moved = commitUi(r.history, 'move', next);
                expect({ next, changed: moved.ok && moved.changed }).toEqual({ next, changed: true });
            }
        });

        it('reversing a wire’s points is a different wire, not the same one', () => {
            // Order is significant INSIDE an array: a wire's points are a path, and the same set of points
            // in the other order is a different path. A comparison that sorted or set-ified would erase it.
            const path = beginHistory(docOf(GALLERY[0]![1]));
            const drawn = commitUi(path, 'wire', {
                wires: [
                    {
                        id: 'w1',
                        netId: 'n1',
                        points: [
                            { x: 0, y: 0 },
                            { x: 10, y: 0 },
                        ],
                    },
                ],
            });
            if (!drawn.ok) throw new Error('unreachable');
            const reversed = commitUi(drawn.history, 'wire', {
                wires: [
                    {
                        id: 'w1',
                        netId: 'n1',
                        points: [
                            { x: 10, y: 0 },
                            { x: 0, y: 0 },
                        ],
                    },
                ],
            });
            expect(reversed.ok && reversed.changed).toBe(true);
        });
    });
});

describe('the document survives a long random session', () => {
    it('never loses, duplicates or corrupts anything across 400 mixed operations', () => {
        // Undo bugs compound: one dropped entry is invisible until the user walks back through it. Seeded so
        // a failure is reproducible.
        forEachCircuit((name, circuit) => {
            let seed = 987654321;
            const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
            let h = beginHistory(docOf(circuit));
            const parts = circuit.components ?? [];
            const nets = circuit.nets ?? [];

            for (let step = 0; step < 400; step++) {
                const roll = next() % 5;
                if (roll === 0) {
                    h = undo(h);
                } else if (roll === 1) {
                    h = redo(h);
                } else if (roll === 2 && nets.length > 0) {
                    const r = commit(h, 'net', [
                        (c) => setNetName(c, nets[next() % nets.length]!.id, `N${next() % 40}`),
                    ]);
                    if (r.ok) h = r.history;
                } else if (roll === 3) {
                    const r = commit(h, 'value', [
                        (c) => setValue(c, parts[next() % parts.length]!.id, `${1 + (next() % 90)}k`),
                    ]);
                    if (r.ok) h = r.history;
                } else {
                    const r = commit(h, 'designator', [
                        (c) => setDesignator(c, parts[next() % parts.length]!.id, `D${next() % 40}`),
                    ]);
                    if (r.ok) h = r.history;
                }
            }

            const now = h.present.circuit;
            const designators = (now.components ?? []).map((c) => c.designator.toLowerCase());
            const netNames = (now.nets ?? []).map((n) => n.name.toLowerCase());
            expect({
                name,
                parts: (now.components ?? []).length,
                nets: (now.nets ?? []).length,
                dupParts: designators.length - new Set(designators).size,
                dupNets: netNames.length - new Set(netNames).size,
                pins: JSON.stringify((now.components ?? []).map((c) => c.pins)),
                depth: h.past.length <= HISTORY_LIMIT,
            }).toEqual({
                name,
                parts: parts.length,
                nets: nets.length,
                dupParts: 0,
                dupNets: 0,
                pins: JSON.stringify(parts.map((c) => c.pins)),
                depth: true,
            });
        });
    });

    it('undoing all the way back reaches the document it started from, exactly', () => {
        forEachCircuit((name, circuit) => {
            let h = beginHistory(docOf(circuit));
            const parts = circuit.components ?? [];
            for (let i = 0; i < 20; i++) {
                const r = commit(h, `e${i}`, [(c) => setDesignator(c, parts[i % parts.length]!.id, `Q${i}`)]);
                if (r.ok) h = r.history;
            }
            while (canUndo(h)) h = undo(h);
            expect({ name, back: h.present.circuit }).toEqual({ name, back: circuit });
        });
    });
});
