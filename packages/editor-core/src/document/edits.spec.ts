/**
 * The edit primitives, against every gallery circuit rather than one convenient fixture.
 *
 * "It works on the divider" is how an editor ships that corrupts the one board with a subcircuit in it. Each
 * invariant below runs across all eight gallery designs — 27-component chasers, BJT flashers, ICs with 16
 * pins — so a rule that only holds for two-terminal parts fails here rather than in someone's project.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CircuitJson } from '@circuit-forge/eda-core';

import { setDesignator, setNetName, setValue } from './edits';

/**
 * The real gallery circuits — the same objects the layout pipeline and the simulator consume.
 *
 * Read from `scripts/lib/gallery-circuits.mjs` rather than copied into a fixture, so this suite cannot drift
 * away from the boards the rest of the system is tested against. A copy would pass forever while the real
 * gallery moved on.
 *
 * Loaded by running a real Node process, not by importing. The module is ESM with top-level await, this
 * suite compiles to CommonJS, and jest's VM sandbox refuses a dynamic `import()` without
 * `--experimental-vm-modules` — a flag whose failure mode is a suite that stops running rather than one that
 * goes red. Shelling out costs about a second in `beforeAll` and depends on nothing experimental.
 */
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

const componentsOf = (c: CircuitJson) => c.components ?? [];

/**
 * Run an assertion over every gallery circuit, naming the board inside the assertion.
 *
 * The name is part of the compared VALUE, not just a message: a failure then reports WHICH design broke
 * rather than only that something did. That matters when one of eight circuits holds the subcircuit or the
 * 16-pin IC that a rule does not survive.
 */
const forEachCircuit = (assert: (name: string, circuit: CircuitJson) => void): void => {
    expect(GALLERY.length).toBeGreaterThanOrEqual(8); // never let a failed load make these vacuous
    for (const [name, circuit] of GALLERY) assert(name, circuit);
};

describe('the edit primitives hold on every gallery circuit', () => {
    it('loaded a non-trivial set of real designs', () => {
        expect(GALLERY.length).toBeGreaterThanOrEqual(8);
        expect(GALLERY.some(([, c]) => componentsOf(c).length > 20)).toBe(true);
        // At least one design with a part that is neither a resistor nor a capacitor — otherwise "works on
        // every circuit" would mean "works on two-terminal parts".
        expect(GALLERY.some(([, c]) => componentsOf(c).some((p) => (p.pins?.length ?? 0) > 3))).toBe(true);
    });

    it('renames a part and leaves everything else identical, order included', () => {
        forEachCircuit((name, circuit) => {
            const first = componentsOf(circuit)[0]!;
            const result = setDesignator(circuit, first.id, 'ZZ99');
            expect({ name, ok: result.ok }).toEqual({ name, ok: true });
            if (!result.ok) return;

            expect({ name, designator: componentsOf(result.circuit)[0]!.designator }).toEqual({
                name,
                designator: 'ZZ99',
            });
            // Array ORDER survives: a document that reshuffles on every edit produces a diff nobody can review.
            expect({ name, ids: componentsOf(result.circuit).map((c) => c.id) }).toEqual({
                name,
                ids: componentsOf(circuit).map((c) => c.id),
            });
            expect({ name, nets: result.circuit.nets }).toEqual({ name, nets: circuit.nets });
        });
    });

    it('never mutates the input — the previous document survives for undo', () => {
        forEachCircuit((name, circuit) => {
            const before = JSON.stringify(circuit);
            setDesignator(circuit, componentsOf(circuit)[0]!.id, 'ZZ99');
            setValue(circuit, componentsOf(circuit)[0]!.id, '999k');
            setNetName(circuit, (circuit.nets ?? [])[0]!.id, 'RENAMED');
            expect({ name, unchanged: JSON.stringify(circuit) === before }).toEqual({ name, unchanged: true });
        });
    });

    it('preserves every pin array EXACTLY — order is the subcircuit port binding', () => {
        // `Component.pins` is emitted to SPICE in the authored order for subcircuits, where it must match the
        // macromodel's port order. An incidental map() that rebuilt pins would re-bind ports silently, and
        // the board would simulate as a different circuit than the one on screen.
        forEachCircuit((name, circuit) => {
            const result = setValue(circuit, componentsOf(circuit)[0]!.id, '4k7');
            if (!result.ok) return;
            const before = componentsOf(circuit).map((c) => c.pins);
            const after = componentsOf(result.circuit).map((c) => c.pins);
            expect({ name, after }).toEqual({ name, after: before });
        });
    });

    it('refuses a designator another part already uses, in any case', () => {
        forEachCircuit((name, circuit) => {
            const parts = componentsOf(circuit);
            if (parts.length < 2) return;
            const taken = parts[1]!.designator;
            for (const attempt of [taken, taken.toLowerCase(), taken.toUpperCase()]) {
                const result = setDesignator(circuit, parts[0]!.id, attempt);
                expect({ name, attempt, refused: !result.ok }).toEqual({ name, attempt, refused: true });
                if (!result.ok) expect(result.reason).toBe('duplicate-designator');
            }
        });
    });

    it('lets a part keep its own designator — that is not a clash with itself', () => {
        forEachCircuit((name, circuit) => {
            const first = componentsOf(circuit)[0]!;
            const result = setDesignator(circuit, first.id, first.designator);
            expect({ name, result: { ok: result.ok, changed: result.ok && result.changed } }).toEqual({
                name,
                result: { ok: true, changed: false },
            });
        });
    });

    it('reports an unchanged edit as unchanged, so it never becomes a save or an undo step', () => {
        forEachCircuit((name, circuit) => {
            const first = componentsOf(circuit)[0]!;
            if (first.value === undefined) return;
            for (const same of [first.value, `  ${first.value}  `]) {
                const result = setValue(circuit, first.id, same);
                expect({ name, changed: result.ok && result.changed }).toEqual({ name, changed: false });
            }
        });
    });

    it('refuses empty and whitespace-only input on every field', () => {
        forEachCircuit((name, circuit) => {
            const first = componentsOf(circuit)[0]!;
            const net = (circuit.nets ?? [])[0]!;
            for (const blank of ['', '   ', '\t', '\n']) {
                for (const [field, result] of [
                    ['designator', setDesignator(circuit, first.id, blank)],
                    ['value', setValue(circuit, first.id, blank)],
                    ['net', setNetName(circuit, net.id, blank)],
                ] as const) {
                    expect({ name, field, reason: result.ok ? 'accepted' : result.reason }).toEqual({
                        name,
                        field,
                        reason: 'empty',
                    });
                }
            }
        });
    });

    it('refuses designator characters that break the BOM and pick-place CSVs', () => {
        // A comma shifts every column after it; a space splits a SPICE token. Refused at entry rather than
        // escaped later by whichever exporter remembered to.
        forEachCircuit((name, circuit) => {
            const first = componentsOf(circuit)[0]!;
            for (const bad of ['R 1', 'R,1', '1R', 'R"1', 'R\t1', '-R1', '.R1']) {
                expect({ name, bad, accepted: setDesignator(circuit, first.id, bad).ok }).toEqual({
                    name,
                    bad,
                    accepted: false,
                });
            }
        });
    });

    it('accepts the designator shapes real parts actually use', () => {
        // Asserted as "never refused for its CHARACTERS", not "always accepted". `R1` is a legal shape and is
        // also already taken in astable-flasher, so a blanket `ok: true` would be a test that only passes on
        // circuits that happen not to contain the name — which is exactly the accidental-fixture dependence
        // this whole file exists to avoid. Uniqueness is a different rule, tested above.
        forEachCircuit((name, circuit) => {
            const first = componentsOf(circuit)[0]!;
            for (const good of ['R1', 'U12', 'LED3', 'C_IN', 'Q1A', 'X$1', 'J1-2', 'TP.3']) {
                const result = setDesignator(circuit, first.id, good);
                const verdict = result.ok ? 'accepted' : result.reason;
                expect({ name, good, grammarRefused: verdict === 'invalid-characters' }).toEqual({
                    name,
                    good,
                    grammarRefused: false,
                });
            }
        });
    });

    it('renames a net by NAME and leaves its id and every connection alone', () => {
        forEachCircuit((name, circuit) => {
            const net = (circuit.nets ?? [])[0]!;
            const result = setNetName(circuit, net.id, 'RENAMED_NET');
            expect({ name, ok: result.ok }).toEqual({ name, ok: true });
            if (!result.ok) return;

            const renamed = (result.circuit.nets ?? []).find((n) => n.id === net.id)!;
            expect({ name, label: renamed.name, id: renamed.id }).toEqual({
                name,
                label: 'RENAMED_NET',
                id: net.id,
            });
            // Connectivity is untouched: not one pin moved. Renaming the id instead would have meant
            // rewriting every PinConnection, and anything the sweep missed would be silently disconnected.
            expect({ name, pins: componentsOf(result.circuit).flatMap((c) => c.pins) }).toEqual({
                name,
                pins: componentsOf(circuit).flatMap((c) => c.pins),
            });
        });
    });

    it('refuses a net name another net already uses', () => {
        forEachCircuit((name, circuit) => {
            const nets = circuit.nets ?? [];
            if (nets.length < 2) return;
            const result = setNetName(circuit, nets[0]!.id, nets[1]!.name);
            expect({ name, reason: result.ok ? 'accepted' : result.reason }).toEqual({
                name,
                reason: 'duplicate-designator',
            });
        });
    });

    it('refuses an edit to something that is not there — a stale selection is ordinary', () => {
        forEachCircuit((name, circuit) => {
            for (const [field, result] of [
                ['designator', setDesignator(circuit, 'ghost', 'R9')],
                ['value', setValue(circuit, 'ghost', '1k')],
                ['net', setNetName(circuit, 'ghost', 'N')],
            ] as const) {
                expect({ name, field, reason: result.ok ? 'accepted' : result.reason }).toEqual({
                    name,
                    field,
                    reason: 'no-such-component',
                });
            }
        });
    });

    it('keeps every designator unique after renaming EVERY part in turn', () => {
        // The property that must hold whatever the order of edits: apply a rename to each component in
        // sequence, carrying the result forward, and the document is still assemblable at the end.
        forEachCircuit((name, circuit) => {
            let doc = circuit;
            for (const [i, c] of componentsOf(circuit).entries()) {
                const result = setDesignator(doc, c.id, `X${i}`);
                expect({ name, id: c.id, ok: result.ok }).toEqual({ name, id: c.id, ok: true });
                if (result.ok) doc = result.circuit;
            }
            const designators = componentsOf(doc).map((c) => c.designator.toLowerCase());
            expect({ name, unique: new Set(designators).size, total: designators.length }).toEqual({
                name,
                unique: designators.length,
                total: designators.length,
            });
        });
    });

    it('survives a long random sequence of edits without losing or duplicating anything', () => {
        // Not a fuzz test for crashes — a check that the document's INVARIANTS survive composition. An editor
        // applies thousands of these in a session, and a rule that only holds for one edit at a time is not a
        // rule. Seeded so a failure is reproducible.
        forEachCircuit((name, circuit) => {
            let seed = 12345;
            const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
            let doc = circuit;

            for (let step = 0; step < 300; step++) {
                const parts = componentsOf(doc);
                const nets = doc.nets ?? [];
                const pick = next() % 3;
                if (pick === 0) {
                    const c = parts[next() % parts.length]!;
                    const r = setDesignator(doc, c.id, `D${next() % 50}`);
                    if (r.ok) doc = r.circuit; // a refusal is a legitimate outcome, not a failure
                } else if (pick === 1) {
                    const c = parts[next() % parts.length]!;
                    const r = setValue(doc, c.id, `${1 + (next() % 99)}k`);
                    if (r.ok) doc = r.circuit;
                } else if (nets.length > 0) {
                    const n = nets[next() % nets.length]!;
                    const r = setNetName(doc, n.id, `N${next() % 50}`);
                    if (r.ok) doc = r.circuit;
                }
            }

            const designators = componentsOf(doc).map((c) => c.designator.toLowerCase());
            const netNames = (doc.nets ?? []).map((n) => n.name.toLowerCase());
            expect({
                name,
                parts: componentsOf(doc).length,
                nets: (doc.nets ?? []).length,
                dupDesignators: designators.length - new Set(designators).size,
                dupNets: netNames.length - new Set(netNames).size,
                pinsIntact: JSON.stringify(componentsOf(doc).map((c) => c.pins)),
            }).toEqual({
                name,
                parts: componentsOf(circuit).length,
                nets: (circuit.nets ?? []).length,
                dupDesignators: 0,
                dupNets: 0,
                pinsIntact: JSON.stringify(componentsOf(circuit).map((c) => c.pins)),
            });
        });
    });
});
