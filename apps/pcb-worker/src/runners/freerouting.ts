/**
 * Native freerouting runner (TS port of scripts/lib/freerouting-native.mjs — proven in-image in M2/M3a).
 * `java -jar $FREEROUTING_JAR` headless; no docker-in-docker (the worker IS the container). Matches
 * pcb-core's FreeroutingRunner type: (dsn) => Promise<ses>.
 */
import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
/** freerouting logs progress to stdout/stderr which we never read (the result is the SES file); a long
 *  route can far exceed execFile's 1 MiB default and be killed with ENOBUFS mid-route, so budget generously. */
const MAX_BUFFER = 64 * 1024 * 1024;

export interface FreeroutingOpts {
    jar?: string;
    java?: string;
    passes?: number;
    timeoutMs?: number;
    workDir?: string;
    keep?: boolean;
}

export function makeNativeFreeroutingRunner(opts: FreeroutingOpts = {}): (dsn: string) => Promise<string> {
    const jar = opts.jar ?? process.env.FREEROUTING_JAR ?? '/app/freerouting-executable.jar';
    const java = opts.java ?? process.env.JAVA_BIN ?? 'java';
    const passes = opts.passes ?? 30;
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const baseDir = opts.workDir ?? tmpdir();

    return async function freeroute(dsn: string): Promise<string> {
        const dir = mkdtempSync(join(baseDir, 'fr-'));
        try {
            const dsnPath = join(dir, 'board.dsn');
            const sesPath = join(dir, 'board.ses');
            writeFileSync(dsnPath, dsn);
            // Async execFile: the child runs off-thread so the event loop stays live (BullMQ lock renewal,
            // health, graceful shutdown) for the whole 10-300s route instead of freezing the single JS thread.
            await execFileAsync(java, ['-jar', jar, '--gui.enabled=false', '-de', dsnPath, '-do', sesPath, '-mp', String(passes)], {
                timeout: timeoutMs,
                maxBuffer: MAX_BUFFER,
            });
            const ses = readFileSync(sesPath, 'utf8');
            if (!ses.includes('(session')) throw new Error('freerouting produced no SES session');
            return ses;
        } finally {
            if (!opts.keep) rmSync(dir, { recursive: true, force: true });
        }
    };
}
