/**
 * Tests for runMonteCarlo — the pure batch orchestrator (B-2b Stage 2 core). ngspice is injected as a fake
 * runner driven by each variant's perturbed R value, so the adaptive-N / Wilson-CI / three-way-accounting
 * logic is verified deterministically WITHOUT a simulator.
 */
import type { AcceptanceCriterion } from '../src/analysis/assertions';
import type { SimMeasurement } from '../src/analysis/measurements';
import { runMonteCarlo } from '../src/montecarlo';
import type { CircuitJson } from '../src/types/circuit';
import { parseSpiceValue } from '../src/utils/unit-parser';

// An RC divider whose OUTPUT node voltage = Vin * R2/(R1+R2). R1,R2 toleranced; we judge the output node.
const DIVIDER: CircuitJson = {
    version: '1.0',
    components: [
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: 'DC 10',
            pins: [
                { pinId: '+', netId: 'in' },
                { pinId: '-', netId: '0' },
            ],
        },
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '1k',
            tolerance: 0.05,
            pins: [
                { pinId: '1', netId: 'in' },
                { pinId: '2', netId: 'mid' },
            ],
        },
        {
            id: 'r2',
            type: 'resistor',
            designator: 'R2',
            value: '1k',
            tolerance: 0.05,
            pins: [
                { pinId: '1', netId: 'mid' },
                { pinId: '2', netId: '0' },
            ],
        },
    ],
    nets: [
        { id: 'in', name: 'in' },
        { id: 'mid', name: 'mid' },
        { id: '0', name: '0', isGround: true },
    ],
};

/** Fake ngspice: compute the analytic divider output for the (perturbed) R1,R2 and return it as the measured
 *  final value of node "mid" (the sanitized node id is "nmid"). */
const dividerRunner = (variant: CircuitJson): Promise<SimMeasurement[] | null> => {
    const r1 = parseSpiceValue(variant.components.find((c) => c.id === 'r1')!.value!).value;
    const r2 = parseSpiceValue(variant.components.find((c) => c.id === 'r2')!.value!).value;
    const vout = 10 * (r2 / (r1 + r2));
    return Promise.resolve([{ node: 'nmid', min: vout, max: vout, final: vout, pp: 0, avg: vout, rms: vout }]);
};

describe('runMonteCarlo', () => {
    it('yields ~100% when the acceptance band comfortably contains the tolerance spread', async () => {
        // 5V ± 0.5V band; with R1,R2 ±5% the divider output stays ~4.75–5.25 → essentially all pass.
        const criteria: AcceptanceCriterion[] = [{ probe: 'mid', metric: 'final', op: 'approx', value: 5, tol: 0.5 }];
        const y = await runMonteCarlo(DIVIDER, criteria, dividerRunner, { n: 200, seed: 7, ciStopHalfWidth: 0 });
        expect(y.evaluated).toBe(200);
        expect(y.errored).toBe(0);
        expect(y.yield).toBeGreaterThan(0.98);
        expect(y.ci95.high).toBeLessThanOrEqual(1);
    });

    it('yields a meaningful PARTIAL when the band is tight relative to the spread', async () => {
        // 5V ± 0.05V (±1%) band; the divider output spreads wider than that → a fraction fail.
        const criteria: AcceptanceCriterion[] = [{ probe: 'mid', metric: 'final', op: 'approx', value: 5, tol: 0.05 }];
        const y = await runMonteCarlo(DIVIDER, criteria, dividerRunner, { n: 250, seed: 11, ciStopHalfWidth: 0 });
        expect(y.yield).toBeGreaterThan(0.1);
        expect(y.yield).toBeLessThan(0.95); // genuinely partial, not trivially 0 or 1
        expect(y.passed + y.failed).toBe(250);
    });

    it('is deterministic for a seed', async () => {
        const crit: AcceptanceCriterion[] = [{ probe: 'mid', metric: 'final', op: 'approx', value: 5, tol: 0.05 }];
        const a = await runMonteCarlo(DIVIDER, crit, dividerRunner, { n: 100, seed: 42, ciStopHalfWidth: 0 });
        const b = await runMonteCarlo(DIVIDER, crit, dividerRunner, { n: 100, seed: 42, ciStopHalfWidth: 0 });
        expect(a.yield).toBe(b.yield);
        expect(a.passed).toBe(b.passed);
    });

    it('adaptive-N stops early on a clearly-robust design (CI tight) — far fewer than n runs', async () => {
        const crit: AcceptanceCriterion[] = [{ probe: 'mid', metric: 'final', op: 'approx', value: 5, tol: 1 }]; // huge band → all pass
        const y = await runMonteCarlo(DIVIDER, crit, dividerRunner, {
            n: 300,
            seed: 3,
            ciStopHalfWidth: 0.05,
            minRuns: 24,
        });
        expect(y.stoppedEarly).toBe(true);
        expect(y.ran).toBeLessThan(300);
        expect(y.ran).toBeGreaterThanOrEqual(24);
    });

    it('EXCLUDES un-runnable (errored) variants from the yield denominator', async () => {
        const crit: AcceptanceCriterion[] = [{ probe: 'mid', metric: 'final', op: 'approx', value: 5, tol: 0.5 }];
        // Runner errors on every 3rd variant (returns null), passes the rest.
        const flakyRunner = (v: CircuitJson, i: number) => (i % 3 === 2 ? Promise.resolve(null) : dividerRunner(v));
        const y = await runMonteCarlo(DIVIDER, crit, flakyRunner, { n: 60, seed: 5, ciStopHalfWidth: 0 });
        expect(y.errored).toBeGreaterThan(0);
        expect(y.evaluated).toBe(y.passed + y.failed);
        expect(y.total).toBe(y.evaluated + y.errored);
        expect(y.yield).toBeCloseTo(y.passed / y.evaluated, 10); // denominator excludes errored
    });

    it('shouldStop (per-batch budget) halts the loop early and reports the honest count', async () => {
        const crit: AcceptanceCriterion[] = [{ probe: 'mid', metric: 'final', op: 'approx', value: 5, tol: 0.05 }];
        let calls = 0;
        // Stop after 10 variants have been drawn (simulates a wall-clock budget hit).
        const y = await runMonteCarlo(DIVIDER, crit, dividerRunner, {
            n: 300,
            seed: 9,
            ciStopHalfWidth: 0,
            shouldStop: () => ++calls > 10,
        });
        expect(y.stoppedEarly).toBe(true);
        expect(y.ran).toBeLessThan(300);
        expect(y.ran).toBeLessThanOrEqual(11);
    });

    it('onProgress fires once per evaluated variant (checkpoint hook)', async () => {
        const crit: AcceptanceCriterion[] = [{ probe: 'mid', metric: 'final', op: 'approx', value: 5, tol: 0.5 }];
        const seen: number[] = [];
        const y = await runMonteCarlo(DIVIDER, crit, dividerRunner, {
            n: 15,
            seed: 4,
            ciStopHalfWidth: 0,
            onProgress: (r) => seen.push(r),
        });
        expect(seen).toHaveLength(y.evaluated); // one checkpoint per evaluated variant
        expect(seen[seen.length - 1]).toBe(y.evaluated); // monotonic running count
    });

    it('a thrown runner counts as errored, not a crash', async () => {
        const crit: AcceptanceCriterion[] = [{ probe: 'mid', metric: 'final', op: 'approx', value: 5, tol: 0.5 }];
        const throwingRunner = (v: CircuitJson, i: number) => {
            if (i === 0) throw new Error('spawn failed');
            return dividerRunner(v);
        };
        const y = await runMonteCarlo(DIVIDER, crit, throwingRunner, { n: 30, seed: 1, ciStopHalfWidth: 0 });
        expect(y.errored).toBeGreaterThanOrEqual(1);
        expect(y.evaluated).toBe(29);
    });
});
