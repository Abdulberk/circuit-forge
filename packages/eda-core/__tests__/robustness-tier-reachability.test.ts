/**
 * The invariant this file exists for: **every tier the engine offers must be reachable.**
 *
 * The stopping rule and the grading rule were written independently and contradicted each other. Stopping
 * said "stop once the Wilson 95% half-width is ≤ 0.03", which a flawless run satisfies at 61 samples, where
 * the Wilson LOWER bound is 0.9408. Grading said "robust when the lower bound ≥ robustMin", and the lowest
 * robustMin shipped is 0.99. So a perfect design was graded `marginal` — always, at every setting — and the
 * user was told to buy tighter parts to fix what was really a sample-count artefact. On top of that the run
 * ceiling was a flat 2000 while the automotive/medical bar (0.999) needs 3838 clean runs, so those two tiers
 * were unreachable by arithmetic rather than by design quality.
 *
 * Both halves are individually well tested elsewhere: montecarlo-orchestrator.test.ts drives the stopping
 * rule with adaptive stopping DISABLED (ciStopHalfWidth: 0) in 7 of 8 cases, and montecarlo.test.ts feeds
 * classifyRobustness hand-written intervals that no orchestrator produced. Neither could see the
 * contradiction, because the contradiction only exists where they MEET. Every test here runs the real
 * orchestrator and grades its real output.
 */
import { evaluateAssertions, type AcceptanceCriterion } from '../src/analysis/assertions';
import type { SimMeasurement } from '../src/analysis/measurements';
import {
    runMonteCarlo,
    classifyRobustness,
    requiredRunsForBar,
    barsForProfile,
    DEFAULT_ROBUSTNESS_PROFILE,
    ROBUSTNESS_PROFILES,
    type VariantRunner,
} from '../src/montecarlo';
import type { CircuitJson } from '../src/types/circuit';

// Minimal toleranced circuit — the perturbation engine needs a toleranced part to vary, but the VERDICT in
// these tests comes from the injected runner, so the circuit itself stays deliberately boring.
const CIRCUIT: CircuitJson = {
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
                { pinId: '2', netId: '0' },
            ],
        },
    ],
    nets: [{ id: 'in', name: 'IN' }],
};

const CRITERIA: AcceptanceCriterion[] = [{ label: 'out ok', probe: 'v(in)', metric: 'final', op: 'gte', value: 1 }];

const measure = (v: number): SimMeasurement[] => [
    { node: 'in', min: v, max: v, final: v, pp: 0, avg: v, rms: v } as unknown as SimMeasurement,
];

/** A runner that passes a fixed FRACTION of variants, deterministically (every k-th fails). */
const runnerPassing = (passFraction: number): VariantRunner => {
    let i = 0;
    return () => {
        i++;
        const pass = passFraction >= 1 ? true : i % Math.round(1 / (1 - passFraction)) !== 0;
        return Promise.resolve(measure(pass ? 5 : 0));
    };
};

/** Counts how many variants the orchestrator actually asked for. */
const counting = (inner: VariantRunner): { runner: VariantRunner; calls: () => number } => {
    let n = 0;
    return {
        runner: (c, i) => {
            n++;
            return inner(c, i);
        },
        calls: () => n,
    };
};

// Sanity: the fake runner + the real assertion evaluator agree on what "pass" means, so a green test below
// cannot be an artefact of the fixture disagreeing with the engine.
describe('fixture sanity', () => {
    it('the injected measurement really satisfies (and really fails) the criterion', () => {
        expect(evaluateAssertions(measure(5), CRITERIA, true, CIRCUIT.nets).every((r) => r.pass)).toBe(true);
        expect(evaluateAssertions(measure(0), CRITERIA, true, CIRCUIT.nets).every((r) => r.pass)).toBe(false);
    });
});

describe('requiredRunsForBar — the arithmetic that ties a bar to a run count', () => {
    // At p̂ = 1 the Wilson lower bound is n/(n+z²), so reaching R needs n ≥ z²·R/(1−R).
    it.each([
        [0.9, 35],
        [0.99, 381],
        [0.999, 3838],
    ])('robustMin %p needs %p clean runs', (bar, expected) => {
        expect(requiredRunsForBar(bar)).toBe(expected);
    });

    it('the returned count is exactly sufficient — one fewer run misses the bar', () => {
        for (const bar of [0.9, 0.99, 0.999]) {
            const n = requiredRunsForBar(bar);
            const lo = (k: number) => classifyRobustness({ yield: 1, evaluated: k, ci95: wilsonLowAt(k) }, 'x');
            void lo;
            expect(wilsonLowAt(n).low).toBeGreaterThanOrEqual(bar);
            expect(wilsonLowAt(n - 1).low).toBeLessThan(bar);
        }
    });

    it('degenerate bars fall back to the runaway guard instead of diverging or hanging', () => {
        for (const bad of [1, 1.5, 0, -0.1, NaN, Infinity]) {
            const v = requiredRunsForBar(bad);
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThan(0);
        }
    });
});

/** Wilson-95 lower/upper for a FLAWLESS run of k samples — mirrors the engine's own formula. */
function wilsonLowAt(k: number): { low: number; high: number } {
    const z2 = 1.959963984540054 ** 2;
    return { low: k / (k + z2), high: 1 };
}

describe('THE REGRESSION: a flawless design must be able to earn the top tier', () => {
    // This is the case that was broken. Before the fix the run stopped at 61 samples with lower = 0.9408 and
    // classifyRobustness returned 'marginal' for a design that never failed once.
    it.each(Object.keys(ROBUSTNESS_PROFILES))(
        'profile %s: 100%% passing → tier "robust"',
        async (profile) => {
            const bars = ROBUSTNESS_PROFILES[profile]!;
            const report = await runMonteCarlo(CIRCUIT, CRITERIA, runnerPassing(1), {
                seed: 1,
                stopBars: { robustMin: bars.robustMin, marginalMin: bars.marginalMin },
            });

            const verdict = classifyRobustness(report as unknown as Record<string, unknown>, profile);
            expect(verdict.tier).toBe('robust');
            expect(report.failed).toBe(0);
            expect(verdict.yieldLowerBound!).toBeGreaterThanOrEqual(bars.robustMin);
        },
        60_000,
    );

    it('stops as soon as the bar is cleared — it does not burn the whole ceiling', async () => {
        const bars = ROBUSTNESS_PROFILES.consumer!;
        const c = counting(runnerPassing(1));
        const report = await runMonteCarlo(CIRCUIT, CRITERIA, c.runner, {
            seed: 1,
            stopBars: { robustMin: bars.robustMin, marginalMin: bars.marginalMin },
        });
        // Exactly the arithmetic minimum: earning the bar is not optional, overshooting it is waste.
        expect(c.calls()).toBe(requiredRunsForBar(bars.robustMin));
        expect(report.stoppedEarly).toBe(true);
    }, 60_000);

    it('guards the class of bug: every shipped profile is reachable within its own derived ceiling', () => {
        // A future edit that tightens a bar without touching the ceiling (or vice versa) fails here rather
        // than shipping a tier nobody can earn.
        for (const [name, bars] of Object.entries(ROBUSTNESS_PROFILES)) {
            const needed = requiredRunsForBar(bars.robustMin);
            expect(bars.marginalMin).toBeLessThan(bars.robustMin);
            expect(needed).toBeLessThanOrEqual(50_000); // the absolute runaway guard
            expect(name).toBeTruthy();
        }
    });
});

describe('stopping is DECISION-based: cheap when the answer is obvious, patient when it is not', () => {
    it('a clearly-bad design is settled in far fewer runs than a clearly-good one', async () => {
        const bars = ROBUSTNESS_PROFILES.consumer!;
        const stopBars = { robustMin: bars.robustMin, marginalMin: bars.marginalMin };

        const bad = counting(runnerPassing(0.5));
        const badReport = await runMonteCarlo(CIRCUIT, CRITERIA, bad.runner, { seed: 1, stopBars });
        expect(classifyRobustness(badReport as unknown as Record<string, unknown>, 'consumer').tier).toBe('at-risk');

        const good = counting(runnerPassing(1));
        await runMonteCarlo(CIRCUIT, CRITERIA, good.runner, { seed: 1, stopBars });

        // The economic property: proving "bad" is cheap, proving "excellent" is what costs.
        expect(bad.calls()).toBeLessThan(good.calls());
        expect(bad.calls()).toBeLessThan(100);
    }, 60_000);

    it('does NOT stop at the old fixed-precision point (61) while the tier is still open', async () => {
        const bars = ROBUSTNESS_PROFILES.consumer!;
        const c = counting(runnerPassing(1));
        await runMonteCarlo(CIRCUIT, CRITERIA, c.runner, {
            seed: 1,
            stopBars: { robustMin: bars.robustMin, marginalMin: bars.marginalMin },
        });
        expect(c.calls()).toBeGreaterThan(61); // the exact number the old rule stopped at
    }, 60_000);

    it('never stops before minRuns, even when the interval looks decided', async () => {
        const c = counting(runnerPassing(0.5));
        await runMonteCarlo(CIRCUIT, CRITERIA, c.runner, {
            seed: 1,
            minRuns: 40,
            stopBars: { robustMin: 0.99, marginalMin: 0.9 },
        });
        expect(c.calls()).toBeGreaterThanOrEqual(40);
    }, 60_000);

    it('a nonsensical bar pair (marginalMin above robustMin) terminates instead of hanging', async () => {
        const report = await runMonteCarlo(CIRCUIT, CRITERIA, runnerPassing(1), {
            seed: 1,
            n: 120,
            stopBars: { robustMin: 0.5, marginalMin: 0.95 },
        });
        expect(report.ran).toBeLessThanOrEqual(120);
    }, 60_000);
});

describe('budget and error accounting still win over the new rule', () => {
    it('the wall-clock budget cuts the run and is reported honestly', async () => {
        let calls = 0;
        const report = await runMonteCarlo(CIRCUIT, CRITERIA, runnerPassing(1), {
            seed: 1,
            stopBars: { robustMin: 0.99, marginalMin: 0.9 },
            shouldStop: () => ++calls > 30, // budget bites long before the bar could be earned
        });
        expect(report.stoppedEarly).toBe(true);
        expect(report.ran).toBeLessThan(requiredRunsForBar(0.99));
        // A budget-cut run must not masquerade as a graded one.
        expect(classifyRobustness(report as unknown as Record<string, unknown>, 'consumer').tier).not.toBe('robust');
    }, 60_000);

    it('errored variants are excluded from the decision, not counted as failures', async () => {
        let i = 0;
        const runner: VariantRunner = () => Promise.resolve(++i % 3 === 0 ? null : measure(5)); // 1/3 infra faults
        const report = await runMonteCarlo(CIRCUIT, CRITERIA, runner, {
            seed: 1,
            stopBars: { robustMin: 0.99, marginalMin: 0.9 },
        });
        expect(report.errored).toBeGreaterThan(0);
        expect(report.failed).toBe(0);
        expect(report.evaluated).toBe(report.passed);
        // An infra hiccup must not cost the design its tier.
        expect(classifyRobustness(report as unknown as Record<string, unknown>, 'consumer').tier).toBe('robust');
    }, 60_000);

    it('an all-errored run gives up quickly and yields nothing to grade, rather than a fake at-risk', async () => {
        const c = counting(() => Promise.resolve(null));
        const report = await runMonteCarlo(CIRCUIT, CRITERIA, c.runner, {
            seed: 1,
            n: 300,
            minRuns: 24,
            stopBars: { robustMin: 0.99, marginalMin: 0.9 },
        });
        expect(report.evaluated).toBe(0);
        expect(report.errored).toBe(report.ran);
        // A broken runner is not a design signal, so there is nothing to grade...
        expect(classifyRobustness(report as unknown as Record<string, unknown>, 'consumer').tier).not.toBe('at-risk');
        // ...and we must not keep spawning against it: bail once minRuns attempts produced no usable sample.
        expect(c.calls()).toBe(24);
    }, 60_000);
});

describe('backwards compatibility — profile-less callers are untouched', () => {
    it('without stopBars the old fixed-precision rule still governs (stops around 61)', async () => {
        const c = counting(runnerPassing(1));
        const report = await runMonteCarlo(CIRCUIT, CRITERIA, c.runner, { seed: 1, ciStopHalfWidth: 0.03 });
        expect(report.stoppedEarly).toBe(true);
        expect(c.calls()).toBe(61); // documents the exact legacy behaviour this fix does NOT change
    }, 60_000);

    it('ciStopHalfWidth 0 still disables adaptive stopping entirely', async () => {
        const c = counting(runnerPassing(1));
        await runMonteCarlo(CIRCUIT, CRITERIA, c.runner, { seed: 1, n: 40, ciStopHalfWidth: 0 });
        expect(c.calls()).toBe(40);
    }, 60_000);

    it('an explicit n still bounds the run even with bars', async () => {
        const c = counting(runnerPassing(1));
        await runMonteCarlo(CIRCUIT, CRITERIA, c.runner, {
            seed: 1,
            n: 50,
            stopBars: { robustMin: 0.99, marginalMin: 0.9 },
        });
        expect(c.calls()).toBe(50);
    }, 60_000);

    it('n = 1 is honoured', async () => {
        const report = await runMonteCarlo(CIRCUIT, CRITERIA, runnerPassing(1), { seed: 1, n: 1, minRuns: 1 });
        expect(report.ran).toBe(1);
    });

    it('the same seed still reproduces the same run exactly', async () => {
        const opts = { seed: 42, stopBars: { robustMin: 0.99, marginalMin: 0.9 } };
        const a = await runMonteCarlo(CIRCUIT, CRITERIA, runnerPassing(0.9), opts);
        const b = await runMonteCarlo(CIRCUIT, CRITERIA, runnerPassing(0.9), opts);
        expect(a).toEqual(b);
    }, 60_000);
});

describe('the note must send the user to the RIGHT action', () => {
    it('a short run says "more variants", never "buy tighter parts"', () => {
        // 61 flawless runs: lower 0.9408 (below the bar) but upper still 1 → robust is not ruled out.
        const short = classifyRobustness({ yield: 1, evaluated: 61, ci95: wilsonLowAt(61) }, 'consumer');
        expect(short.tier).toBe('marginal');
        expect(short.note).toMatch(/more variants|Undecided/i);
        expect(short.note).not.toMatch(/Tighten component tolerances/i);
        expect(short.note).toContain(String(requiredRunsForBar(0.99)));
    });

    it('a genuinely marginal design (upper below the bar) does get told to tighten tolerances', () => {
        const real = classifyRobustness({ yield: 0.95, evaluated: 4000, ci95: { low: 0.94, high: 0.96 } }, 'consumer');
        expect(real.tier).toBe('marginal');
        expect(real.note).toMatch(/Tighten component tolerances/i);
        expect(real.note).not.toMatch(/more variants/i);
    });

    it('an at-risk design is still called out plainly', () => {
        const bad = classifyRobustness({ yield: 0.5, evaluated: 200, ci95: { low: 0.43, high: 0.57 } }, 'consumer');
        expect(bad.tier).toBe('at-risk');
        expect(bad.note).toMatch(/At risk/i);
    });

    it('no Monte-Carlo at all stays "unknown" — nominal-only, not a grade', () => {
        expect(classifyRobustness(undefined, 'consumer').tier).toBe('unknown');
        expect(classifyRobustness({}, 'consumer').note).toMatch(/NOMINAL/i);
    });

    // Separate defect, same family, found by the all-errored case above. computeYield reports
    // wilson95(0, 0) = {low: 0, high: 1} when the denominator is empty; 0 is a valid number, so the grader
    // used to read it as "0% yield" and return `at-risk` for a batch where every variant failed to SPAWN.
    // That blames the design for an infrastructure fault — the exact inversion the errored-exclusion rule
    // exists to prevent, just at the aggregate level. It matters beyond this repo: classifyRobustness is a
    // published export, so an outside caller has none of our internal `evaluated > 0` guards.
    it('a zero-sample run is UNKNOWN, never at-risk — no samples means no verdict', () => {
        const allErrored = { yield: 0, evaluated: 0, errored: 40, ci95: { low: 0, high: 1 } };
        const v = classifyRobustness(allErrored, 'consumer');
        expect(v.tier).toBe('unknown');
        expect(v.yieldLowerBound).toBeNull();
        expect(v.yield).toBeNull(); // a 0 point-estimate over 0 samples is not a measurement either
        expect(v.note).toMatch(/infrastructure fault/i);
        expect(v.note).toMatch(/NOT a design signal/i);
    });

    it('one usable sample is not silently dropped — the zero-sample guard is about zero, not "few"', () => {
        const v = classifyRobustness({ yield: 1, evaluated: 1, errored: 9, ci95: { low: 0.2, high: 1 } }, 'consumer');
        expect(v.evaluated).toBe(1);
        expect(v.yieldLowerBound).toBe(0.2);
    });
});

/**
 * `at-risk` is the ONLY tier that gates — verification.service flips /verify-design to `fail` on it. So it
 * must be EARNED from evidence, never inferred from a wide interval. Ten flawless variants give a Wilson
 * lower bound of 10/(10+z²) = 0.72, under marginalMin 0.9: before the guard, a design that failed NOTHING
 * was graded a design fault and could fail the whole verdict. "Never false-fail a correct design" is this
 * engine's stated first principle, so this is the sharpest edge in the module.
 */
describe('at-risk must be earned, not inferred from a small sample', () => {
    const wilson = (passed: number, n: number): { low: number; high: number } => {
        const z = 1.959963984540054;
        const z2 = z * z;
        const p = passed / n;
        const denom = 1 + z2 / n;
        const centre = (p + z2 / (2 * n)) / denom;
        const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
        return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
    };

    it('a FLAWLESS 10-variant run is not at-risk — the interval has not ruled out the bar', () => {
        const ci = wilson(10, 10);
        expect(ci.low).toBeLessThan(0.9); // the trap: the lower bound alone says "at-risk"
        expect(ci.high).toBeGreaterThanOrEqual(0.9); // ...but the upper bound says we simply do not know yet
        const v = classifyRobustness({ yield: 1, evaluated: 10, ci95: ci }, 'consumer');
        expect(v.tier).not.toBe('at-risk');
        expect(v.tier).toBe('unknown');
        expect(v.note).toMatch(/NOT a design fault/i);
    });

    it.each([5, 10, 20, 34])('a flawless run of %i variants is never called a design fault', (n) => {
        const v = classifyRobustness({ yield: 1, evaluated: n, ci95: wilson(n, n) }, 'consumer');
        expect(v.tier).not.toBe('at-risk');
    });

    it('a genuinely bad design IS still at-risk — the guard must not blunt the real signal', () => {
        // 200 variants at 50% pass: the interval sits entirely below the 0.9 bar, so "bad" is decided.
        const ci = wilson(100, 200);
        expect(ci.high).toBeLessThan(0.9);
        const v = classifyRobustness({ yield: 0.5, evaluated: 200, ci95: ci }, 'consumer');
        expect(v.tier).toBe('at-risk');
        expect(v.note).toMatch(/At risk/i);
    });

    it('the sampler and the grader agree on when a tier is decided', async () => {
        // Same invariant, both halves: a run that stops on a decided tier must not then be graded "unknown".
        const bars = ROBUSTNESS_PROFILES.consumer!;
        const report = await runMonteCarlo(CIRCUIT, CRITERIA, runnerPassing(0.5), {
            seed: 3,
            stopBars: { robustMin: bars.robustMin, marginalMin: bars.marginalMin },
        });
        const v = classifyRobustness(report as unknown as Record<string, unknown>, 'consumer');
        expect(v.tier).not.toBe('unknown');
    }, 60_000);
});

/**
 * The default profile. classifyRobustness has always defaulted an absent profile to 'consumer'; the sampler
 * did not. A caller who names no profile therefore ran a bar-less (fixed ±3%) sample and was then graded
 * against consumer bars — the sampler aiming at one target while the verdict is scored against another,
 * which is the original defect one layer up. barsForProfile is the single resolver both halves use.
 */
describe('an absent profile resolves to the SAME bars in both halves', () => {
    it('barsForProfile falls back to the documented default', () => {
        expect(barsForProfile(undefined)).toEqual(ROBUSTNESS_PROFILES[DEFAULT_ROBUSTNESS_PROFILE]);
        expect(barsForProfile('consumer')).toEqual(ROBUSTNESS_PROFILES.consumer);
        expect(barsForProfile('automotive')).toEqual(ROBUSTNESS_PROFILES.automotive);
    });

    it('an unknown or inherited key falls back rather than resolving to junk', () => {
        // 'constructor'/'toString' come off Object.prototype on a plain-object lookup — a bare
        // ROBUSTNESS_PROFILES[name] would hand back a Function and every bar comparison would silently fail.
        for (const bad of ['nope', '', 'constructor', 'toString', '__proto__', 'CONSUMER']) {
            expect(barsForProfile(bad)).toEqual(ROBUSTNESS_PROFILES[DEFAULT_ROBUSTNESS_PROFILE]);
        }
    });

    it('classifyRobustness with no profile argument grades on the default bars', () => {
        const ci = { low: 0.995, high: 1 };
        expect(classifyRobustness({ yield: 1, evaluated: 400, ci95: ci }).tier).toBe('robust');
        expect(classifyRobustness({ yield: 1, evaluated: 400, ci95: ci }, 'automotive').tier).not.toBe('robust');
    });

    it('THE DEFAULT PATH: a profile-less flawless run still earns the top tier', async () => {
        // The shipped default request carries no profile. Before this fix that meant no bars at all, so the
        // run stopped at 61 and a flawless design was graded "marginal" — the exact defect the previous
        // commit claimed to fix, still live on the path almost every request takes.
        const bars = barsForProfile(undefined);
        const report = await runMonteCarlo(CIRCUIT, CRITERIA, runnerPassing(1), {
            seed: 1,
            stopBars: { robustMin: bars.robustMin, marginalMin: bars.marginalMin },
        });
        expect(classifyRobustness(report as unknown as Record<string, unknown>).tier).toBe('robust');
        expect(report.evaluated).toBe(requiredRunsForBar(bars.robustMin));
    }, 60_000);
});
