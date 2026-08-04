/**
 * The instrument that guards against a false green, guarded itself.
 *
 * This session produced the same lesson three separate times, each from a different tool: a shell pipeline
 * whose `head` silently truncated the summary and reported success; a boundary test whose header said it
 * proved the package installs standalone while it only read a manifest; and a connection count that seemed
 * to show tests writing to the wrong database and did not. Every one of them was a MEASURING DEVICE that
 * looked right and measured something else.
 *
 * `scripts/jest-environment-reporter.cjs` exists precisely to stop a run being mistaken for a verdict. An
 * untested version of it would be the same trap one level up — a watchdog that has quietly stopped barking
 * is worse than no watchdog, because its silence is read as an all-clear.
 *
 * Three properties, and the third matters as much as the first two: it must stay QUIET when the
 * environment is healthy. A banner that prints on every run is one people stop reading, and then it is
 * decoration rather than a guard.
 */
import { createRequire } from 'node:module';

const load = () =>
    createRequire(__filename)('../../../scripts/jest-environment-reporter.cjs') as new (
        globalConfig: unknown,
        options: unknown,
    ) => {
        onRunStart: () => Promise<void>;
        onRunComplete: (
            contexts: unknown,
            results: { numFailedTests: number; numPendingTests: number; numTodoTests: number },
        ) => void;
    };

/** Capture what the reporter printed, without letting it reach the real console. */
async function reportOn(
    env: Record<string, string | undefined>,
    results: { numFailedTests?: number; numPendingTests?: number; numTodoTests?: number } = {},
): Promise<string> {
    const Reporter = load();
    const before = { ...process.env };
    const lines: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args) => void lines.push(args.join(' ')));
    try {
        for (const [k, v] of Object.entries(env)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        const reporter = new Reporter({}, {});
        await reporter.onRunStart();
        reporter.onRunComplete([], {
            numFailedTests: results.numFailedTests ?? 0,
            numPendingTests: results.numPendingTests ?? 0,
            numTodoTests: results.numTodoTests ?? 0,
        });
        return lines.join('\n');
    } finally {
        spy.mockRestore();
        process.env = before;
    }
}

/** A port nothing listens on, so the probe genuinely fails rather than being told it failed. */
const DEAD = 'postgresql://postgres:x@127.0.0.1:59999/nope';
const HEALTHY = process.env.DATABASE_URL!; // whatever the suite is really configured with

describe('a run against a broken environment cannot read as a verdict', () => {
    it('names the unreachable dependency BEFORE any test runs', async () => {
        // Before, not after, because the point is to be a recorded fact rather than something inferred
        // afterwards from a hundred identical error strings.
        const out = await reportOn({ DATABASE_URL: DEAD, REDIS_URL: undefined, S3_ENDPOINT: undefined });
        expect(out).toMatch(/ENVIRONMENT DEGRADED/);
        expect(out).toMatch(/PostgreSQL at 127\.0\.0\.1:59999/);
    });

    it('says a GREEN run means less than it looks like — which is the dangerous case', async () => {
        // A degraded run that FAILS is at least confusing enough to investigate. A degraded run that passes
        // is indistinguishable from a healthy one, and that is the state this exists for.
        const out = await reportOn({ DATABASE_URL: DEAD, REDIS_URL: undefined, S3_ENDPOINT: undefined });
        expect(out).toMatch(/NOT A VERDICT/);
        expect(out).toMatch(/GREEN, which under these conditions means less than it looks like/);
    });

    it('counts SKIPPED tests, because a skip is a question that was not asked', async () => {
        // The quieter half. Several suites here vanish when their dependency is missing — the live ngspice
        // specs look for a binary and skip — so the run goes green having measured nothing.
        const out = await reportOn({ DATABASE_URL: HEALTHY }, { numPendingTests: 7 });
        expect(out).toMatch(/7 test\(s\) SKIPPED/);
    });

    it('STAYS QUIET when the environment is healthy and nothing was skipped', async () => {
        // The property that keeps the other three worth anything. A banner on every run is one nobody
        // reads, and an unread warning is the same as no warning with extra noise.
        const out = await reportOn({ DATABASE_URL: HEALTHY });
        expect(out).toBe('');
    });

    it('reads the endpoints from the ENV the tests are configured with, not from hard-coded ports', async () => {
        // Hard-coded ports would report a healthy environment as broken the day someone moves a service —
        // the same lie in the other direction, and the one that teaches people to ignore the banner.
        const out = await reportOn({ DATABASE_URL: 'postgresql://postgres:x@127.0.0.1:59998/nope' });
        expect(out).toMatch(/127\.0\.0\.1:59998/);
    });
});
