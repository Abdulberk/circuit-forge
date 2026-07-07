/**
 * NATIVE freerouting runner (LAYOUTJOB_PLAN.md M2) — the pcb-worker runs freerouting as a local jar
 * (`java -jar`), NOT `docker run`, because the worker IS the container (Docker-in-Docker is a security
 * mess we avoid). Identical invocation shape to the Docker runner (scripts/lib/freerouting.mjs), just
 * without the `docker run --entrypoint java IMAGE` wrapper. Injected into pcb-core's `freeroute` seam.
 *
 * Env (set in the pcb-worker image): FREEROUTING_JAR (path to freerouting-executable.jar), JAVA_BIN
 * (default "java"). Batch/headless mode is real and proven (--gui.enabled=false).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {{ jar?: string, java?: string, passes?: number, timeoutMs?: number, workDir?: string, keep?: boolean }} [opts]
 * @returns {(dsn: string) => Promise<string>} matching pcb-core's FreeroutingRunner type
 */
export function makeNativeFreeroutingRunner(opts = {}) {
    const jar = opts.jar ?? process.env.FREEROUTING_JAR ?? '/app/freerouting-executable.jar';
    const java = opts.java ?? process.env.JAVA_BIN ?? 'java';
    const passes = opts.passes ?? 30;
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const baseDir = opts.workDir ?? tmpdir();

    return async function freeroute(dsn) {
        const dir = mkdtempSync(join(baseDir, 'fr-'));
        try {
            const dsnPath = join(dir, 'board.dsn');
            const sesPath = join(dir, 'board.ses');
            writeFileSync(dsnPath, dsn);
            execFileSync(
                java,
                ['-jar', jar, '--gui.enabled=false', '-de', dsnPath, '-do', sesPath, '-mp', String(passes)],
                { stdio: 'pipe', timeout: timeoutMs },
            );
            const ses = readFileSync(sesPath, 'utf8');
            if (!ses.includes('(session')) throw new Error('freerouting produced no SES session');
            return ses;
        } finally {
            if (!opts.keep) rmSync(dir, { recursive: true, force: true });
        }
    };
}
