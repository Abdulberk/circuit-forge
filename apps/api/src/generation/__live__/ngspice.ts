/**
 * Is there a usable ngspice on this machine, and where?
 *
 * ONE ANSWER TO ONE QUESTION. Two live specs used to decide this two different ways: `verify-design-live`
 * searched the known install locations, and `spec-satisfaction-live` required `NGSPICE_PATH` to be exported
 * by hand. On a developer machine with ngspice installed, that meant one of them ran and the other reported
 * itself skipped — three real tests over real simulator output, quietly not running, on a machine that could
 * run them. Nothing failed; the suite was simply smaller than it looked.
 *
 * IT PROBES RATHER THAN TRUSTING THE FILE. On Windows the Chocolatey package installs two binaries beside
 * each other: `ngspice.exe`, which opens a window and writes nothing to a pipe, and `ngspice_con.exe`, which
 * is the batch one. Both exist, both are executable, and a resolver that stopped at `existsSync` would pick
 * whichever came first in its list and hand back something that runs, exits zero, and produces NO OUTPUT —
 * so every assertion over the results would be evaluated against nothing. That is the worst shape a test
 * environment can take, and it is why this asks the binary to solve a circuit whose answer is known before
 * it will vouch for it.
 *
 * The probe is a two-resistor divider across ten volts. The node between them must sit at five. A binary
 * that cannot produce that number is not one this suite can learn anything from.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Where ngspice is installed when nobody has said.
 *
 * `ngspice_con` FIRST on Windows, deliberately: see above. The bare `ngspice` on PATH is left for platforms
 * where it is the batch binary, and the probe is what decides between them either way.
 */
const KNOWN = [
    'C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe',
    '/usr/bin/ngspice',
    '/usr/local/bin/ngspice',
    '/opt/homebrew/bin/ngspice',
];

/** A circuit whose answer is arithmetic: 10 V across two equal resistors puts the middle at 5. */
const PROBE_DECK = `probe
v1 in 0 dc 10
r1 in out 1k
r2 out 0 1k
.op
.control
run
print v(out)
quit
.endc
.end
`;

/** Does this binary actually solve a circuit and say so on a pipe? */
function answers(binary: string): boolean {
    const dir = mkdtempSync(join(tmpdir(), 'ngspice-probe-'));
    try {
        const deck = join(dir, 'probe.cir');
        writeFileSync(deck, PROBE_DECK);
        const out = execFileSync(binary, ['-b', deck], { encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
        // Five volts, however it is spelled — 5, 5.0, 5.000000e+00.
        return /\b5(\.0+)?(e[+-]?0*)?\b/i.test(out);
    } catch {
        return false;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

let resolved: string | null | undefined;

/**
 * The path to a working ngspice, or an empty string.
 *
 * Cached, because the probe spawns a process and several suites ask. `NGSPICE_PATH` wins when it is set AND
 * works — an explicit path that does not answer is worth saying out loud rather than silently replacing,
 * since somebody meant it.
 */
export function ngspiceBinary(): string {
    if (resolved !== undefined) return resolved ?? '';

    // Tried by RUNNING it, not by looking for a file. CI sets `NGSPICE_PATH: ngspice` — a bare command name,
    // resolved through PATH — and a resolver that insisted on an existing file would reject the very value
    // this repo's own workflow supplies.
    const asked = process.env.NGSPICE_PATH;
    if (asked) {
        if (answers(asked)) return (resolved = asked);
        // eslint-disable-next-line no-console
        console.warn(
            `NGSPICE_PATH is set to ${asked}, which does not solve a divider. On Windows that is almost` +
                ` always the GUI build — use ngspice_con.exe. Searching the usual places instead.`,
        );
    }

    resolved = KNOWN.find((p) => existsSync(p) && answers(p)) ?? null;
    return resolved ?? '';
}

/**
 * `describe` when a real ngspice is present, and a LOUD skip when it is not.
 *
 * A silent skip is how a suite shrinks without anyone noticing. This prints the one line that tells a reader
 * the difference between "these passed" and "these did not run", which is the whole reason the gate exists.
 */
export function describeWithNgspice(title: string): jest.Describe {
    if (ngspiceBinary()) return describe;
    // eslint-disable-next-line no-console
    console.warn(`SKIPPED (no working ngspice on this machine): ${title}`);
    return describe.skip;
}
