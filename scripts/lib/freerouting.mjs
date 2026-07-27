/**
 * Docker-backed freerouting runner — the process side of pcb-core's `LayoutOptions.freeroute` seam.
 * Kept OUT of the pure library (packages/pcb-core stays child_process/Docker-free); the harness and,
 * later, the Faz-2 worker inject this.
 *
 * Pinned to freerouting 2.2.4 (2.2.3 mis-parses KiCad-10 DSNs, issue #676). Invocation shape verified
 * live 3 Tem 2026: bare args are rejected, so we override the entrypoint to `java -jar` and pass the
 * headless flags. Returns the Specctra SES text; throws if the container fails or emits no session.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FR_IMAGE } from './eda-images.mjs';

/**
 * @param {{ image?: string, passes?: number, timeoutMs?: number, workDir?: string, keep?: boolean }} [opts]
 * @returns {(dsn: string) => Promise<string>} a runner matching pcb-core's FreeroutingRunner type
 */
export function makeFreeroutingRunner(opts = {}) {
    const image = opts.image ?? FR_IMAGE;
    const passes = opts.passes ?? 30;
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const baseDir = opts.workDir ?? tmpdir();

    return async function freeroute(dsn) {
        const dir = mkdtempSync(join(baseDir, 'fr-'));
        try {
            writeFileSync(join(dir, 'board.dsn'), dsn);
            const mount = `${dir.replaceAll('\\', '/')}:/work`;
            execFileSync(
                'docker',
                [
                    'run', '--rm', '-v', mount, '--entrypoint', 'java', image,
                    '-jar', '/app/freerouting-executable.jar',
                    '--gui.enabled=false', '-de', '/work/board.dsn', '-do', '/work/board.ses', '-mp', String(passes),
                ],
                { stdio: 'pipe', timeout: timeoutMs, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
            );
            const ses = readFileSync(join(dir, 'board.ses'), 'utf8');
            if (!ses.includes('(session')) throw new Error('freerouting produced no SES session');
            return ses;
        } finally {
            if (!opts.keep) rmSync(dir, { recursive: true, force: true });
        }
    };
}
