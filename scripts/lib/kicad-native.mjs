/**
 * NATIVE KiCad runner (LAYOUTJOB_PLAN.md M2) — the pcb-worker calls `kicad-cli` directly (it is
 * installed in the image, which is derived from kicad/kicad:10.0-full so the 3D model library lives at
 * /usr/share/kicad/3dmodels), NOT `docker run`. Provides the three things the LayoutJob needs:
 *   • notaryDrc(pcb,pro)  → boolean accept-oracle for pcb-core's margin-retry (exit-code-violations)
 *   • drcReport(pcb,pro)  → parsed report (violations + unconnected) for airwires + categorized checks
 *   • exportGlb(pcb)      → 3D GLB bytes (kicad-cli export glb --subst-models)
 *
 * Env (pcb-worker image): KICAD_CLI (default "kicad-cli").
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeNativeKicad(opts = {}) {
    const cli = opts.cli ?? process.env.KICAD_CLI ?? 'kicad-cli';
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const baseDir = opts.workDir ?? tmpdir();

    const withBoard = (kicadPcb, kicadPro, fn) => {
        const dir = mkdtempSync(join(baseDir, 'kc-'));
        try {
            writeFileSync(join(dir, 'b.kicad_pcb'), kicadPcb);
            if (kicadPro) writeFileSync(join(dir, 'b.kicad_pro'), kicadPro);
            return fn(dir);
        } finally {
            if (!opts.keep) rmSync(dir, { recursive: true, force: true });
        }
    };

    /** Boolean accept-oracle (exit 0 = clean; exit 5 = violations/unconnected). Matches the Docker runner. */
    const notaryDrc = async (kicadPcb, kicadPro) =>
        withBoard(kicadPcb, kicadPro, (dir) => {
            try {
                execFileSync(cli, ['pcb', 'drc', '--refill-zones', '--exit-code-violations', '--severity-error',
                    '--format', 'json', '--output', join(dir, 'd.json'), join(dir, 'b.kicad_pcb')],
                    { stdio: 'pipe', timeout: timeoutMs });
                return true;
            } catch (e) {
                if (e.status === 5) return false;
                throw e;
            }
        });

    /** Parsed DRC report (no --exit-code-violations so it never throws on findings) → { violations, unconnected_items }. */
    const drcReport = async (kicadPcb, kicadPro) =>
        withBoard(kicadPcb, kicadPro, (dir) => {
            const out = join(dir, 'd.json');
            execFileSync(cli, ['pcb', 'drc', '--refill-zones', '--severity-error', '--format', 'json',
                '--output', out, join(dir, 'b.kicad_pcb')], { stdio: 'pipe', timeout: timeoutMs });
            return existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { violations: [], unconnected_items: [] };
        });

    /** Export the bodied board to a GLB (Buffer). --subst-models resolves /usr/share/kicad/3dmodels bodies. */
    const exportGlb = async (kicadPcb) =>
        withBoard(kicadPcb, null, (dir) => {
            const out = join(dir, 'b.glb');
            execFileSync(cli, ['pcb', 'export', 'glb', '--include-tracks', '--include-pads', '--include-zones',
                '--include-silkscreen', '--include-soldermask', '--subst-models', '--output', out, join(dir, 'b.kicad_pcb')],
                { stdio: 'pipe', timeout: timeoutMs });
            return readFileSync(out);
        });

    return { notaryDrc, drcReport, exportGlb };
}
