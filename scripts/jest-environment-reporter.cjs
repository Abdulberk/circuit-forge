/**
 * Says out loud when a test run could not actually test.
 *
 * THE FAILURE THIS EXISTS TO PREVENT. Docker went down on a dev box, and the API suite answered with 148
 * red tests whose real cause was one line — `Can't reach database server at localhost:5432` — buried in
 * each of them. Two readings were available: "my change broke a hundred things" and "the environment is
 * gone". The second is correct and the cheap habit is to reach it too fast: once you have decided a red
 * suite is environmental you stop reading it, and a genuine regression sitting in the same run rides along
 * unnoticed. The expensive habit — proving which failures are environmental — is the one nobody keeps up.
 *
 * The other half is quieter and worse. Several suites here SKIP themselves when their dependency is
 * missing: the live ngspice specs look for a binary and vanish if it is absent, so the run goes green while
 * measuring nothing. A green run and a green run are indistinguishable on screen, and the difference is
 * whether anything was actually checked.
 *
 * So this reporter makes both states LOUD and refuses to summarise them away:
 *
 *   • it probes each service the suite depends on BEFORE anything runs, so the environment is a recorded
 *     fact rather than something inferred afterwards from error text;
 *   • it counts skipped tests, because a skip is a question that was not asked;
 *   • it prints a banner at the end when either applies, saying in one sentence that the run is NOT a
 *     verdict — including, deliberately, when the run is GREEN. A degraded green is the dangerous one.
 *
 * IT DOES NOT BLOCK THE RUN, and that is deliberate. Most of this repo's tests are pure; refusing to run
 * them because Postgres is down would remove the one thing that stays trustworthy when the environment is
 * not — the ability to prove a change is fine using the tests that do not depend on it. The point is not to
 * stop anyone. It is to make "I could not test that" impossible to miss and impossible to forget.
 */
const net = require('node:net');
const { existsSync } = require('node:fs');

/** One TCP probe. Resolves true/false; never throws, never blocks longer than the timeout. */
function reachable(host, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const done = (ok) => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(port, host);
    });
}

/** Pull host:port out of a URL, tolerating the shapes this repo's env vars actually take. */
function endpointOf(url, defaultPort) {
    if (!url) return null;
    try {
        const u = new URL(url);
        return { host: u.hostname || 'localhost', port: Number(u.port) || defaultPort };
    } catch {
        return null;
    }
}

/**
 * What this run needs, read from the env the tests themselves are configured with — never hard-coded.
 * A hard-coded port would go stale the day someone moves a service and would then report a healthy
 * environment as broken, which is the same lie in the other direction.
 */
function dependencies(env) {
    const out = [];
    const pg = endpointOf(env.DATABASE_URL, 5432);
    if (pg) out.push({ name: 'PostgreSQL', ...pg, why: 'every integration and e2e suite' });
    const redis = endpointOf(env.REDIS_URL, 6379);
    if (redis) out.push({ name: 'Redis', ...redis, why: 'queue and rate-limit suites' });
    const s3 = endpointOf(env.S3_ENDPOINT, 9000);
    if (s3) out.push({ name: 'S3 (MinIO)', ...s3, why: 'artifact storage suites' });
    return out;
}

const BAR = '─'.repeat(96);

class EnvironmentReporter {
    constructor(globalConfig, options = {}) {
        this._options = options;
        this._down = [];
        this._probed = false;
    }

    async onRunStart() {
        const deps = dependencies(process.env);
        const results = await Promise.all(deps.map((d) => reachable(d.host, d.port).then((ok) => ({ ...d, ok }))));
        this._down = results.filter((r) => !r.ok);
        this._probed = true;

        // A binary, not a socket: the live simulation specs look for ngspice and skip when it is absent.
        // Recorded here so the end-of-run banner can say WHY things were skipped rather than only that
        // they were.
        const ngspice = process.env.NGSPICE_PATH;
        this._ngspiceMissing = Boolean(ngspice) && !existsSync(ngspice);

        if (this._down.length > 0) {
            console.log(`\n${BAR}`);
            console.log('⚠  ENVIRONMENT DEGRADED — some dependencies are unreachable BEFORE any test ran:');
            for (const d of this._down) console.log(`     ✗ ${d.name} at ${d.host}:${d.port} — needed by ${d.why}`);
            console.log('   Suites that need them will fail for that reason, not because of the code.');
            console.log(`${BAR}\n`);
        }
    }

    onRunComplete(_contexts, results) {
        const skipped = (results.numPendingTests || 0) + (results.numTodoTests || 0);
        const degraded = this._down.length > 0 || this._ngspiceMissing;
        if (!degraded && skipped === 0) return;

        console.log(`\n${BAR}`);
        console.log('⚠  THIS RUN IS NOT A VERDICT.');
        for (const d of this._down) {
            console.log(`     ✗ ${d.name} was unreachable at ${d.host}:${d.port} for the whole run.`);
        }
        if (this._ngspiceMissing) {
            console.log(`     ✗ NGSPICE_PATH points at "${process.env.NGSPICE_PATH}", which does not exist.`);
        }
        if (skipped > 0) {
            // Stated separately from failures on purpose. A skipped test is not a passing test; it is a
            // question nobody asked, and it costs nothing on screen unless something says so.
            console.log(`     ⃠ ${skipped} test(s) SKIPPED — a skip is a question that was not asked.`);
        }
        if (results.numFailedTests === 0) {
            console.log('   The result above is GREEN, which under these conditions means less than it looks like.');
        } else {
            console.log(
                `   ${results.numFailedTests} test(s) failed. Before blaming the code, rule the environment out —`,
            );
            console.log('   and before blaming the environment, prove it: re-run the suites that do NOT need it.');
        }
        console.log(`${BAR}\n`);
    }
}

module.exports = EnvironmentReporter;
