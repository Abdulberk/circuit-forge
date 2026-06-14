/**
 * OS resource limits for the ngspice child process.
 *
 * ngspice runs user-supplied SPICE. The netlist is already sanitized (shell directives rejected,
 * .include path-whitelisted) and time-bounded, but a malformed or pathological circuit can still try to
 * over-consume HOST resources — request too much memory, run too long, write an oversized output file,
 * or spawn too many processes. This wraps the spawn so the kernel caps those per run, keeping one bad
 * job from degrading the host or other tenants.
 *
 * On Linux we prepend a bash `ulimit` preamble and `exec` the binary (so the timeout/kill still target
 * the ngspice PID — exec replaces the shell). When a dedicated low-privilege user is configured, we also
 * drop to it (via su-exec) so the process runs without the worker's privileges and gets its OWN process
 * count limit. On non-Linux (Windows dev) or mode 'none' we run the binary directly — ulimit/su-exec are
 * Linux mechanisms, so this is enforced in Linux prod only (the worker image is Debian/Alpine-based).
 * This is a RESOURCE bound, not a namespace sandbox; full network/filesystem isolation (bubblewrap /
 * per-job container / gVisor) is the recommended stronger layer on top — see ARCHITECTURE/SECURITY docs.
 *
 * `sandboxedCommand` is pure: returns the command to spawn; it does not spawn. Unit-testable across
 * platforms. `probeBwrap` is the one impure helper — a one-shot startup preflight that spawns the cheapest
 * real bwrap invocation to decide whether the host can create the namespaces (it commonly can't under
 * Docker's default seccomp), caching the result so a misconfigured host degrades to the rlimit hardening
 * instead of failing every job.
 */
import { spawn } from 'child_process';

export type SandboxMode = 'none' | 'rlimit';

export interface SandboxLimits {
    /** RLIMIT_AS — max virtual address space (MB). */
    memoryMb: number;
    /** RLIMIT_CPU — max CPU seconds (a backstop to the wall-clock timeout). */
    cpuSec: number;
    /** RLIMIT_FSIZE — max size of any file ngspice writes (MB) — caps a runaway output.csv. */
    fileSizeMb: number;
    /** RLIMIT_NPROC — max processes/threads — caps runaway process/thread creation. */
    maxProcs: number;
}

export interface SandboxConfig {
    mode: SandboxMode;
    limits: SandboxLimits;
    /** Optional dedicated low-privilege user to run the child as (Linux, via su-exec). Gives ngspice its
     *  OWN RLIMIT_NPROC count (not shared with the worker's Node threads) and keeps it off the worker's
     *  privileges. Unset = run as the current user. Operator-set + validated in resolveSandboxConfig.
     *  Ignored when `bwrap` is set (a rootless bwrap userns has a single mapped uid — no su-exec). */
    user?: string;
    /** Wrap the child in a rootless bubblewrap namespace cage (Linux). Set by resolveSandboxConfig only
     *  when SIM_BWRAP is enabled AND probeBwrap() confirmed the host can create the namespaces. */
    bwrap?: boolean;
    /** The per-job working directory — the ONLY real path bwrap binds writable (circuit.cir + output.csv).
     *  Required when `bwrap` is set; the caller (runner) passes the job dir. */
    jobDir?: string;
}

/**
 * Build the argv to run `bin args` under `cfg`. On Linux + mode 'rlimit', wraps with
 * `bash -c 'ulimit ...; exec [su-exec <user>] "$@"' bash <bin> <args...>` (args passed as argv — no string
 * interpolation of the netlist/paths, so no shell-injection surface). Otherwise returns the command unchanged.
 */
export function sandboxedCommand(
    bin: string,
    args: string[],
    cfg: SandboxConfig,
    platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
    if (cfg.mode === 'none' || platform !== 'linux') {
        return { file: bin, args };
    }
    const { memoryMb, cpuSec, fileSizeMb, maxProcs } = cfg.limits;
    // bash ulimit units: -v address space in KB, -t CPU seconds, -f file size in 1024-byte blocks,
    // -u max user processes. exec replaces bash with the target (same PID → kill/timeout still work).
    const preamble = `ulimit -v ${memoryMb * 1024} -t ${cpuSec} -f ${fileSizeMb * 1024} -u ${maxProcs}`;
    // Optionally drop to a dedicated user for the child via su-exec (it exec-replaces itself with the
    // target, keeping the same PID). cfg.user is operator-set + validated (safe username), not user input;
    // the bin/args still ride as argv ("$@") and are never interpolated. su-exec is suppressed under bwrap
    // (a rootless userns maps a single uid — there is no second user to drop to).
    const run = cfg.user && !cfg.bwrap ? `exec su-exec ${cfg.user} "$@"` : `exec "$@"`;
    const inner = ['bash', '-c', `${preamble}; ${run}`, 'bash', bin, ...args];

    // Optional bubblewrap cage AROUND the rlimit wrapper: bwrap = WHERE the child can reach, ulimit = HOW
    // MUCH it can consume — they compose (rlimits inherit across the bwrap exec). The ngspice child runs
    // in a fresh user/mount/pid/ipc/uts + NETWORK namespace over a read-only host root; the ONLY writable
    // real path is the job dir. Only emitted when explicitly enabled + a job dir is known (resolve sets
    // cfg.bwrap only after a successful startup preflight).
    if (cfg.bwrap && cfg.jobDir) {
        const bwrapArgs = [
            // Explicit --unshare-user (NOT --unshare-all, which is --unshare-user-TRY and would SILENTLY
            // run WITHOUT a userns when the host forbids it). Fail loud instead — probeBwrap gates this.
            '--unshare-user', '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
            '--die-with-parent', '--new-session',
            // Drop the worker's env (DB/Redis/S3 creds) — ngspice never needs it — and give a minimal PATH
            // + a writable HOME under the tmpfs.
            '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin:/usr/local/bin', '--setenv', 'HOME', '/tmp',
            '--ro-bind', '/', '/', // read-only host root: shared libs, bash, the ngspice binary
            '--proc', '/proc', '--dev', '/dev', // fresh proc + minimal /dev (ngspice needs /dev/null)
            '--tmpfs', '/tmp', // ngspice spools `.control` blocks here via libc tmpfile() (ignores $TMPDIR)
            '--bind', cfg.jobDir, cfg.jobDir, // the ONLY writable real path (circuit.cir + output.csv)
            '--chdir', cfg.jobDir,
            '--',
            ...inner,
        ];
        return { file: 'bwrap', args: bwrapArgs };
    }
    return { file: inner[0]!, args: inner.slice(1) };
}

/** Module cache: set by probeBwrap() at startup. bwrap activates only after a successful preflight on the
 *  actual host (rootless userns is commonly blocked by Docker's default seccomp), so a misconfigured host
 *  degrades to the rlimit hardening instead of failing every job. */
let bwrapReady = false;

/** Is SIM_BWRAP set to an enabling value? */
export function isBwrapEnabled(v?: string): boolean {
    return v !== undefined && ['1', 'true', 'on', 'yes'].includes(v.toLowerCase());
}

/**
 * One-shot startup preflight: can this host create the namespaces bwrap needs? Runs the cheapest real
 * bwrap invocation and caches the result (read by resolveSandboxConfig). No-op (false) when disabled or
 * off Linux. Never throws.
 */
export async function probeBwrap(opts: {
    enabled: boolean;
    bin?: string;
    platform?: NodeJS.Platform;
    log?: (ok: boolean, detail: string) => void;
}): Promise<boolean> {
    const platform = opts.platform ?? process.platform;
    if (!opts.enabled || platform !== 'linux') {
        bwrapReady = false;
        return false;
    }
    const bin = opts.bin ?? 'bwrap';
    bwrapReady = await new Promise<boolean>((resolve) => {
        try {
            const p = spawn(bin, ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '--', '/bin/true'], { stdio: 'ignore' });
            p.on('error', () => resolve(false));
            p.on('close', (code) => resolve(code === 0));
        } catch {
            resolve(false);
        }
    });
    opts.log?.(bwrapReady, bwrapReady ? 'preflight passed' : 'preflight failed (unprivileged user namespaces blocked?)');
    return bwrapReady;
}

/** Resolve sandbox config from env. SIM_SANDBOX: 'auto' (default) → rlimit on Linux, none elsewhere.
 *  SIM_SANDBOX_USER (validated to a plain username) → run ngspice as that dedicated user on Linux. */
export function resolveSandboxConfig(env: {
    SIM_SANDBOX?: string;
    SIM_SANDBOX_MEMORY_MB?: number;
    SIM_SANDBOX_CPU_SEC?: number;
    SIM_SANDBOX_FSIZE_MB?: number;
    SIM_SANDBOX_NPROC?: number;
    SIM_SANDBOX_USER?: string;
    SIM_BWRAP?: string;
    SIM_TIMEOUT_MS?: number;
    platform?: NodeJS.Platform;
}): SandboxConfig {
    const platform = env.platform ?? process.platform;
    const requested = (env.SIM_SANDBOX ?? 'auto').toLowerCase();
    const mode: SandboxMode = requested === 'none' ? 'none' : requested === 'rlimit' ? 'rlimit' : platform === 'linux' ? 'rlimit' : 'none';
    // CPU backstop sits comfortably above the wall-clock timeout so it never fires for a legit run.
    const cpuBackstop = Math.ceil((env.SIM_TIMEOUT_MS ?? 10000) / 1000) * 2 + 5;
    // bwrap is active only when enabled AND the startup preflight (probeBwrap) succeeded on this host.
    const bwrap = isBwrapEnabled(env.SIM_BWRAP) && bwrapReady;
    // Only accept a plain username (no shell metacharacters) — it's interpolated into the bash preamble.
    // Suppressed under bwrap: a rootless userns maps a single uid, so there's no second user to drop to.
    const user = !bwrap && env.SIM_SANDBOX_USER && /^[a-z_][a-z0-9_-]*$/.test(env.SIM_SANDBOX_USER) ? env.SIM_SANDBOX_USER : undefined;
    return {
        mode,
        ...(user ? { user } : {}),
        ...(bwrap ? { bwrap: true } : {}),
        limits: {
            memoryMb: env.SIM_SANDBOX_MEMORY_MB ?? 2048,
            cpuSec: env.SIM_SANDBOX_CPU_SEC ?? cpuBackstop,
            fileSizeMb: env.SIM_SANDBOX_FSIZE_MB ?? 256,
            maxProcs: env.SIM_SANDBOX_NPROC ?? 64,
        },
    };
}
