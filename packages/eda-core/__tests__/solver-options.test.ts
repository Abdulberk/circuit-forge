/**
 * solverOptionTokens + applySolverOptions — the shared `.options` plumbing. applySolverOptions lets the
 * worker run a convergence remedy on the netlist STRING it holds (no CircuitJson); the key invariant is
 * that this string-merge yields the same `.options` token set the generator would emit if it regenerated
 * the netlist with those options.
 */
import { generateNetlist } from '../src/netlist/generator';
import { solverOptionTokens, applySolverOptions } from '../src/netlist/solver-options';
import type { SolverOptions } from '../src/types/analysis';
import type { CircuitJson } from '../src/types/circuit';

/** Every `.options` card's tokens (one inner array per `.options` line). */
function optionCards(netlist: string): string[][] {
    return netlist
        .split(/\r?\n/)
        .filter((l) => /^\s*\.options\b/i.test(l))
        .map((l) => l.trim().replace(/^\.options\s*/i, '').split(/\s+/).filter(Boolean));
}

describe('solverOptionTokens', () => {
    it('emits validated key=value tokens and drops invalid numerics', () => {
        const t = solverOptionTokens({ gmin: '1e-9', reltol: '1e-2', itl4: 500, method: 'gear', abstol: 'DROP ME' });
        expect(t).toEqual(expect.arrayContaining(['gmin=1e-9', 'reltol=1e-2', 'itl4=500', 'method=gear']));
        expect(t.some((x) => x.startsWith('abstol'))).toBe(false); // unparseable value dropped (no injection)
    });

    it('drops out-of-range / non-integer itl4, unknown method, and empty/undefined options', () => {
        expect(solverOptionTokens({ itl4: 0 })).toEqual([]);
        expect(solverOptionTokens({ itl4: 20000 })).toEqual([]);
        expect(solverOptionTokens({ itl4: 1.5 })).toEqual([]);
        expect(solverOptionTokens({ method: 'foo' } as unknown as SolverOptions)).toEqual([]);
        expect(solverOptionTokens(undefined)).toEqual([]);
        expect(solverOptionTokens({})).toEqual([]);
    });
});

describe('applySolverOptions', () => {
    it('returns the netlist UNCHANGED when there are no emittable tokens', () => {
        const nl = '* t\nV1 in 0 5\nR1 in 0 1k\n.op\n.end';
        expect(applySolverOptions(nl, {})).toBe(nl);
        expect(applySolverOptions(nl, { itl4: 0 })).toBe(nl); // invalid lever → no tokens → unchanged
    });

    it('inserts a single .options card before the analysis card when none exists', () => {
        const nl = '* t\nV1 in 0 5\nR1 in 0 1k\n\n* Analysis\n.op\n\n.control\nrun\n.endc\n.end';
        const out = applySolverOptions(nl, { gmin: '1e-9' });
        const cards = optionCards(out);
        expect(cards.length).toBe(1);
        expect(cards[0]).toEqual(['gmin=1e-9']);
        const lines = out.split('\n');
        expect(lines.findIndex((l) => /^\.options/i.test(l))).toBeLessThan(lines.findIndex((l) => /^\.op\b/i.test(l)));
    });

    it('merges into an existing card: remedy wins on a shared key, flags + non-overridden tokens preserved, one card', () => {
        const nl = '* t\nV1 in 0 5\nR1 in 0 1k\n* Options\n.options gmin=1e-12 savecurrents reltol=1e-3\n* Analysis\n.op\n.end';
        const toks = optionCards(applySolverOptions(nl, { gmin: '1e-9', itl4: 500 }))[0]!;
        expect(optionCards(applySolverOptions(nl, { gmin: '1e-9', itl4: 500 })).length).toBe(1);
        expect(toks).toContain('savecurrents'); // flag preserved
        expect(toks).toContain('reltol=1e-3'); // non-overridden preserved
        expect(toks).toContain('gmin=1e-9'); // remedy overrides the original 1e-12
        expect(toks).toContain('itl4=500'); // remedy added
        expect(toks.filter((t) => t.startsWith('gmin=')).length).toBe(1); // gmin not duplicated
    });

    it('folds multiple existing .options lines into one canonical card', () => {
        const nl = '.options gmin=1e-12\n.options savecurrents\n.op\n.end';
        const cards = optionCards(applySolverOptions(nl, { reltol: '1e-2' }));
        expect(cards.length).toBe(1);
        expect(cards[0]).toEqual(expect.arrayContaining(['gmin=1e-12', 'savecurrents', 'reltol=1e-2']));
    });
});

describe('applySolverOptions == a generator regenerate (worker string-merge equals an API regenerate)', () => {
    const circuit: CircuitJson = {
        version: '1.0',
        components: [
            { id: 'v1', type: 'voltage_source', designator: 'V1', value: '5', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
            { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'gnd' }] },
            { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
        ],
        nets: [{ id: 'in', name: 'IN' }, { id: 'gnd', name: 'GND', isGround: true }],
    };
    const remedy: SolverOptions = { gmin: '1e-9', reltol: '1e-2', itl4: 500 };
    const tokenSet = (nl: string) => new Set(optionCards(nl).flat());

    it('op: applied netlist carries the same .options token set as regenerating with those options', () => {
        const applied = applySolverOptions(generateNetlist(circuit, { type: 'op' }), remedy);
        const regenerated = generateNetlist(circuit, { type: 'op', options: remedy });
        expect(tokenSet(applied)).toEqual(tokenSet(regenerated));
    });

    it('tran: applied netlist carries the same .options token set as regenerating with those options', () => {
        const tran = { type: 'tran', stopTime: '5m', stepTime: '10u' } as const;
        const applied = applySolverOptions(generateNetlist(circuit, tran), { method: 'gear', itl4: 1000, reltol: '1e-2' });
        const regenerated = generateNetlist(circuit, { ...tran, options: { method: 'gear', itl4: 1000, reltol: '1e-2' } });
        expect(tokenSet(applied)).toEqual(tokenSet(regenerated));
    });
});
