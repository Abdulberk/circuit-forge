/**
 * Native freerouting runner — the ONLY implementation (the scripts/lib/ harness copy it was ported from
 * has been deleted; the Docker-backed scripts/lib/freerouting.mjs remains, but that one exists to drive
 * an IMAGE from outside and is not a second copy of this).
 * `java -jar $FREEROUTING_JAR` headless; no docker-in-docker (the worker IS the container). Matches
 * pcb-core's FreeroutingRunner type: (dsn) => Promise<ses>.
 */
import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
/** freerouting logs progress to stdout/stderr which we never read (the result is the SES file); a long
 *  route can far exceed execFile's 1 MiB default and be killed with ENOBUFS mid-route, so budget generously. */
const MAX_BUFFER = 64 * 1024 * 1024;

export interface FreeroutingOpts {
    /**
     * Aborts the java child when the caller cancels. Node's own execFile signal — the route a cancel has
     * to take, because pcb-core's cooperative checkpoint only fires BETWEEN attempts and one attempt is
     * the router's entire budget. Without this, "cancel" would leave freerouting running for up to five
     * more minutes on a job nobody wants, holding a worker slot the whole time.
     */
    signal?: AbortSignal;
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
            try {
                await execFileAsync(
                    java,
                    ['-jar', jar, '--gui.enabled=false', '-de', dsnPath, '-do', sesPath, '-mp', String(passes)],
                    {
                        timeout: timeoutMs,
                        maxBuffer: MAX_BUFFER,
                        signal: opts.signal,
                    },
                );
            } catch (e) {
                // execFile's message is only "Command failed: <the whole java command>" — what the tool
                // actually SAID lives on .stderr. pcb-core records this text as the PCB035 degradation
                // diagnostic and truncates it, so without this the command line consumed the whole budget
                // and the reason never reached the job row. A silent fallback to the fast router is already
                // hard to notice; one that cannot say why is undiagnosable.
                const err = e as { stderr?: string; stdout?: string; code?: number; message?: string };
                const said = (err.stderr ?? '').trim() || (err.stdout ?? '').trim();
                throw new Error(
                    `freerouting failed (exit ${err.code ?? '?'})${said ? `: ${said.slice(-400)}` : ` with no output: ${err.message ?? ''}`}`,
                );
            }
            if (!existsSync(sesPath))
                throw new Error('freerouting exited 0 but wrote no SES file — refusing to treat that as a route');
            const ses = readFileSync(sesPath, 'utf8');
            if (!ses.includes('(session')) throw new Error('freerouting produced no SES session');
            return ses;
        } finally {
            if (!opts.keep) rmSync(dir, { recursive: true, force: true });
        }
    };
}
