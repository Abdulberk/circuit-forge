/**
 * Docker-backed KiCad DRC oracle — the process side of pcb-core's `LayoutOptions.notaryDrc` seam.
 * Returns true iff the board is DRC-clean: zero BLOCKING rule violations and zero unconnected items,
 * judged against the sibling .kicad_pro / net class. Kept OUT of the pure library; the harness/worker
 * injects this so the quality margin-retry can use REAL DRC as its completeness+cleanliness oracle.
 *
 * The verdict comes from the REPORT, not the exit code. kicad-cli is asked for `--severity-all` so the
 * report can carry warning-severity findings (which are reported and never gate delivery), and at that
 * severity `--exit-code-violations` exits 5 on a warning too — so reading the code would call every board
 * in the gallery dirty. pcb-core's parseDrcReport owns which severities block, in one place, for both this
 * harness and the production worker.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { KICAD_IMAGE, dockerUserArgs } from './eda-images.mjs';

// scripts/ is not a workspace package, so pcb-core is reached by built path — the same form gen-gallery
// uses. The severity policy must come from pcb-core and nowhere else: a second copy of "which severities
// block" is a second answer to the manufacturability question, and the two would drift apart quietly.
const { parseDrcReport } = await import(
    pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'pcb-core', 'dist', 'index.js'))
        .href
);

/** @param {{ image?: string, timeoutMs?: number, workDir?: string, keep?: boolean }} [opts] */
export function makeKicadDrcRunner(opts = {}) {
    const image = opts.image ?? KICAD_IMAGE;
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const baseDir = opts.workDir ?? tmpdir();
    return async function notaryDrc(kicadPcb, kicadPro) {
        const dir = mkdtempSync(join(baseDir, 'drc-'));
        try {
            writeFileSync(join(dir, 'b.kicad_pcb'), kicadPcb);
            writeFileSync(join(dir, 'b.kicad_pro'), kicadPro);
            const mount = `${dir.replaceAll('\\', '/')}:/work`;
            try {
                execFileSync(
                    'docker',
                    ['run', '--rm', ...dockerUserArgs(), '-v', mount, image, 'kicad-cli', 'pcb', 'drc',
                        '--refill-zones', '--severity-all', '--format', 'json',
                        '--output', '/work/d.json', '/work/b.kicad_pcb'],
                    { stdio: 'pipe', timeout: timeoutMs, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
                );
            } catch (e) {
                // Without --exit-code-violations a non-zero exit is the notary failing, not a verdict — and
                // the caller records this text as a degradation diagnostic and truncates it, so raise what
                // the TOOL said rather than execFileSync's "Command failed: <the whole docker command>",
                // which fills the whole budget with the command line and leaves no room for the reason.
                const said = String(e.stderr ?? '').trim() || String(e.stdout ?? '').trim();
                throw new Error(
                    `kicad-cli DRC failed (exit ${e.status ?? '?'})${said ? `: ${said.slice(-400)}` : ' with no output'}`,
                );
            }
            // FAIL-CLOSED: the file is now the sole verdict, so its absence must never read as a clean board.
            const out = join(dir, 'd.json');
            if (!existsSync(out))
                throw new Error('kicad-cli DRC produced no report file — refusing to assume the board is DRC-clean');
            return parseDrcReport(JSON.parse(readFileSync(out, 'utf8'))).clean;
        } finally {
            if (!opts.keep) rmSync(dir, { recursive: true, force: true });
        }
    };
}
