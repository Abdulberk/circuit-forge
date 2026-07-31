/**
 * Local ngspice runner — the process side of "simulate this circuit", returning the FULL parsed result.
 *
 * Everything that decides what the answer means lives in eda-core and is called here rather than
 * reimplemented: `resolveGenericModels` (model attachment), `generateNetlist` (the deck, including the
 * node-naming rule a caller may need to join against), `extractProbes` (the emitted wrdata column order,
 * so labels stay aligned even when a probe is rewritten or dropped) and `parseSimulationOutput`. This
 * module owns exactly one thing: spawning the binary and reading its files back.
 *
 * FAIL-CLOSED. An empty or missing output file is raised, never returned as a result with no data — a
 * simulation that produced nothing and a circuit whose signals are all zero look identical in a waveform
 * and mean opposite things.
 *
 * ⚠ The binary must be the CONSOLE build (`ngspice_con.exe`). The chocolatey shim `ngspice.exe` is the GUI
 * build: under `-b` it writes no log, produces no output, and exits 0 — a silent empty success that reads
 * downstream as a circuit with nothing happening in it.
 *
 * NOTE: seven measurement harnesses under scripts/ still carry their own ngspice spawn (coverage-matrix,
 * edge-cases, fuzz-circuits, pairwise-sweep, robustness-*, sim-run). Consolidating them onto this module is
 * a separate mechanical change; this exists so the count stops growing.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { generateNetlist, resolveGenericModels, extractProbes, parseSimulationOutput } = await import(
    pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'eda-core', 'dist', 'index.js'))
        .href
);

/** Console-build ngspice. Overridable, because a CI image installs it somewhere else. */
const DEFAULT_NGSPICE = 'C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe';

/** Lines that mean the run did not produce a trustworthy answer, whatever the exit code said. */
const FAILURE_RE = /singular matrix|no convergence|Timestep too small|Unable to find|fatal|aborted|no such|no output/i;

/**
 * @param {{ binary?: string, timeoutMs?: number, keep?: boolean }} [opts]
 * @returns {(circuit: object, analysis: object, probes?: string[]) => { result: object, netlist: string, warnings: string[] }}
 */
export function makeNgspiceRunner(opts = {}) {
    const binary = opts.binary ?? process.env.NGSPICE_PATH ?? DEFAULT_NGSPICE;
    const timeoutMs = opts.timeoutMs ?? 60_000;

    return function simulate(circuit, analysis, probes) {
        // Generic models are attached to a COPY: a runner must not mutate its caller's circuit, or a second
        // run of the same object would carry the first run's models.
        const extra = resolveGenericModels(circuit);
        const deck = extra.length ? { ...circuit, models: [...(circuit.models ?? []), ...extra] } : circuit;
        const netlist = generateNetlist(deck, analysis, probes ? { probes } : undefined);

        const dir = mkdtempSync(join(tmpdir(), 'cf-ng-'));
        try {
            writeFileSync(join(dir, 'c.cir'), netlist);
            const run = spawnSync(binary, ['-b', '-o', 'log.txt', 'c.cir'], {
                cwd: dir,
                encoding: 'utf-8',
                timeout: timeoutMs,
            });
            const log = existsSync(join(dir, 'log.txt')) ? readFileSync(join(dir, 'log.txt'), 'utf-8') : '';
            const warnings = `${run.stderr ?? ''}\n${log}`
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => FAILURE_RE.test(l));

            const csvPath = join(dir, 'output.csv');
            const csv = existsSync(csvPath) ? readFileSync(csvPath, 'utf-8') : '';
            if (!csv.trim()) {
                throw new Error(
                    `ngspice produced no output (exit ${run.status ?? '?'})` +
                        (warnings.length ? `: ${warnings.slice(0, 3).join(' | ')}` : ''),
                );
            }

            // Labels come from the EMITTED wrdata line, not from what we asked for — the generator may
            // rewrite or drop a probe, and a column read under the wrong name is worse than a missing one.
            const names = extractProbes(netlist);
            const result = parseSimulationOutput(csv, names.length ? names : (probes ?? []), analysis.type);
            return { result, netlist, warnings };
        } finally {
            if (!opts.keep) rmSync(dir, { recursive: true, force: true });
        }
    };
}
