/**
 * Convergence Doctor — diagnosis + remedy ladder. Pure + deterministic (no ngspice). Migrated into
 * eda-core (from the API) when the worker began running the same ladder.
 */
import { diagnoseConvergence, convergenceRemedyLadder, type ConvergenceKind } from '../src/netlist/convergence';

describe('diagnoseConvergence', () => {
    const cases: { text: string; kind: ConvergenceKind }[] = [
        { text: 'simulation ended early at t=1.2e-06s of 5m (timestep collapse / non-convergence …)', kind: 'timestep_collapse' },
        { text: 'Timestep too small; time = 1.0e-12', kind: 'timestep_collapse' },
        { text: 'ngspice: singular matrix: check nodes 3 and 4', kind: 'singular_matrix' },
        { text: 'Too many iterations without convergence', kind: 'iteration_limit' },
        { text: 'doAnalyses: no convergence in operating point', kind: 'no_convergence' },
        { text: 'ngspice: unable to find DC operating point', kind: 'no_convergence' },
        { text: 'ngspice produced no output (likely a non-converging or degenerate circuit)', kind: 'no_output' },
    ];
    it.each(cases)('classifies "$kind"', ({ text, kind }) => {
        const d = diagnoseConvergence(text, 'tran');
        expect(d.kind).toBe(kind);
        expect(d.isConvergence).toBe(true);
        expect(d.explanation.length).toBeGreaterThan(20);
    });

    it('returns none/non-convergence for unrelated failures (incl. the missing-MODEL trap)', () => {
        for (const t of [
            'invalid circuit: components: expected array',
            'simulation timed out',
            'simulation output too large to summarize',
            // ngspice's missing-model error contains "unable to find" but is NOT a convergence problem —
            // solver remedies can't add a model, so it must classify as 'none' (no wasteful retries).
            'ngspice error: unable to find definition of model q2n2222',
            '',
        ]) {
            const d = diagnoseConvergence(t, 'op');
            expect(d.kind).toBe('none');
            expect(d.isConvergence).toBe(false);
        }
    });
});

describe('convergenceRemedyLadder', () => {
    const VALID_KEYS = new Set(['reltol', 'abstol', 'vntol', 'gmin', 'method', 'itl4']);

    it('every remedy uses only real SolverOptions levers (so the generator emits them)', () => {
        for (const at of ['op', 'tran', 'dc', 'ac']) {
            for (const step of convergenceRemedyLadder(at)) {
                expect(step.label.length).toBeGreaterThan(0);
                expect(step.rationale.length).toBeGreaterThan(0);
                for (const k of Object.keys(step.options)) expect(VALID_KEYS.has(k)).toBe(true);
            }
        }
    });

    it('transient ladder leans on iteration limit / gear; op ladder leans on gmin', () => {
        const tran = convergenceRemedyLadder('tran');
        expect(tran[0]!.options.itl4).toBeGreaterThan(0); // first transient remedy raises the iteration cap
        expect(tran.some((s) => s.options.method === 'gear')).toBe(true);

        const op = convergenceRemedyLadder('op');
        expect(op[0]!.options.gmin).toBeTruthy(); // first op remedy adds gmin
    });

    it('ends with the most-aggressive shared "last resort" step', () => {
        for (const at of ['op', 'tran']) {
            const ladder = convergenceRemedyLadder(at);
            expect(ladder.length).toBeGreaterThanOrEqual(2);
            expect(ladder[ladder.length - 1]!.label).toMatch(/last resort/i);
        }
    });
});
