/**
 * Docker-backed KiCad DRC — the process side of pcb-core's `LayoutOptions.notaryDrc` seam, and the ONE
 * place a harness may obtain a DRC verdict.
 *
 * Two exports over one implementation: `makeKicadDrcReportRunner` returns the parsed report (blocking
 * violations, warnings, unconnected) and `makeKicadDrcRunner` returns just the boolean the margin ladder
 * needs. They cannot disagree, because the second is the first's `.clean`.
 *
 * WHY BOTH (30 Tem 2026). The harnesses that exist to be EVIDENCE about the product — `pnpm test:layout`,
 * the gallery generator, the routing A/B — each carried their own copy of the DRC invocation and their own
 * reading of the result, and each printed its own "manufacturable stamp". Two implementations of the
 * manufacturability verdict is one too many: a stamp computed by different code from different inputs is
 * not evidence about the product, in either direction. They also all asked for `--severity-error`, so
 * after the product started reporting warning-severity findings the harnesses still could not see them —
 * a board reported CLEAN by the tool whose job is to check the tool.
 *
 * The verdict comes from the REPORT, not the exit code. kicad-cli is asked for `--severity-all` so the
 * report can carry warnings (reported, never gating), and at that severity `--exit-code-violations` exits
 * 5 on a warning too — reading the code would call every board in the gallery dirty. pcb-core's
 * parseDrcReport owns which severities block, in one place, for the harnesses and the production worker
 * alike.
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

/**
 * Run KiCad DRC and return pcb-core's parsed report.
 *
 * @param {{ image?: string, timeoutMs?: number, workDir?: string, keep?: boolean }} [opts]
 * @returns {(kicadPcb: string, kicadPro?: string) => Promise<{clean: boolean, violations: unknown[], warnings: unknown[], unconnected: unknown[]}>}
 */
export function makeKicadDrcReportRunner(opts = {}) {
    const image = opts.image ?? KICAD_IMAGE;
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const baseDir = opts.workDir ?? tmpdir();
    return async function drcReport(kicadPcb, kicadPro) {
        const dir = mkdtempSync(join(baseDir, 'drc-'));
        try {
            writeFileSync(join(dir, 'b.kicad_pcb'), kicadPcb);
            if (kicadPro) writeFileSync(join(dir, 'b.kicad_pro'), kicadPro);
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
                // Without --exit-code-violations a non-zero exit is the notary FAILING, not a verdict — and
                // the caller records this text as a degradation diagnostic and truncates it, so raise what
                // the TOOL said rather than execFileSync's "Command failed: <the whole docker command>",
                // which fills the whole budget with the command line and leaves no room for the reason.
                const said = String(e.stderr ?? '').trim() || String(e.stdout ?? '').trim();
                throw new Error(
                    `kicad-cli DRC failed (exit ${e.status ?? '?'})${said ? `: ${said.slice(-400)}` : ' with no output'}`,
                );
            }
            // FAIL-CLOSED: the file is the sole verdict, so its absence must never read as a clean board.
            const out = join(dir, 'd.json');
            if (!existsSync(out))
                throw new Error('kicad-cli DRC produced no report file — refusing to assume the board is DRC-clean');
            return parseDrcReport(JSON.parse(readFileSync(out, 'utf8')));
        } finally {
            if (!opts.keep) rmSync(dir, { recursive: true, force: true });
        }
    };
}

/**
 * The boolean oracle the quality margin ladder runs on — true iff zero BLOCKING violations and zero
 * unconnected items. Literally the report runner's `.clean`, so the ladder and any harness reporting on the
 * same board can never reach different conclusions about it.
 *
 * @param {{ image?: string, timeoutMs?: number, workDir?: string, keep?: boolean }} [opts]
 * @returns {(kicadPcb: string, kicadPro?: string) => Promise<boolean>}
 */
export function makeKicadDrcRunner(opts = {}) {
    const report = makeKicadDrcReportRunner(opts);
    return async function notaryDrc(kicadPcb, kicadPro) {
        return (await report(kicadPcb, kicadPro)).clean;
    };
}
