/**
 * Docker-backed KiCad DRC oracle — the process side of pcb-core's `LayoutOptions.notaryDrc` seam.
 * Returns true iff the board is DRC-clean (kicad-cli exits 0 under `--exit-code-violations`, i.e. zero
 * rule violations AND zero unconnected items, judged against the sibling .kicad_pro / net class). Kept
 * OUT of the pure library; the harness/worker injects this so the quality margin-retry can use REAL DRC
 * as its completeness+cleanliness oracle.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** @param {{ image?: string, timeoutMs?: number, workDir?: string, keep?: boolean }} [opts] */
export function makeKicadDrcRunner(opts = {}) {
    const image = opts.image ?? 'kicad/kicad:10.0-full';
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
                    ['run', '--rm', '-v', mount, image, 'kicad-cli', 'pcb', 'drc',
                        '--refill-zones', '--exit-code-violations', '--severity-error', '--format', 'json',
                        '--output', '/work/d.json', '/work/b.kicad_pcb'],
                    { stdio: 'pipe', timeout: timeoutMs, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
                );
                return true; // exit 0 → clean
            } catch (e) {
                if (e.status === 5) return false; // 5 → violations and/or unconnected present
                throw e; // anything else → the notary itself failed
            }
        } finally {
            if (!opts.keep) rmSync(dir, { recursive: true, force: true });
        }
    };
}
