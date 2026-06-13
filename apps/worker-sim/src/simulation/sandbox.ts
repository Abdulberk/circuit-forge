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
 * Pure: returns the command to spawn; it does not spawn. Unit-testable across platforms.
 */
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
     *  privileges. Unset = run as the current user. Operator-set + validated in resolveSandboxConfig. */
    user?: string;
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
    // the bin/args still ride as argv ("$@") and are never interpolated.
    const run = cfg.user ? `exec su-exec ${cfg.user} "$@"` : `exec "$@"`;
    return { file: 'bash', args: ['-c', `${preamble}; ${run}`, 'bash', bin, ...args] };
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
    SIM_TIMEOUT_MS?: number;
    platform?: NodeJS.Platform;
}): SandboxConfig {
    const platform = env.platform ?? process.platform;
    const requested = (env.SIM_SANDBOX ?? 'auto').toLowerCase();
    const mode: SandboxMode = requested === 'none' ? 'none' : requested === 'rlimit' ? 'rlimit' : platform === 'linux' ? 'rlimit' : 'none';
    // CPU backstop sits comfortably above the wall-clock timeout so it never fires for a legit run.
    const cpuBackstop = Math.ceil((env.SIM_TIMEOUT_MS ?? 10000) / 1000) * 2 + 5;
    // Only accept a plain username (no shell metacharacters) — it's interpolated into the bash preamble.
    const user = env.SIM_SANDBOX_USER && /^[a-z_][a-z0-9_-]*$/.test(env.SIM_SANDBOX_USER) ? env.SIM_SANDBOX_USER : undefined;
    return {
        mode,
        ...(user ? { user } : {}),
        limits: {
            memoryMb: env.SIM_SANDBOX_MEMORY_MB ?? 2048,
            cpuSec: env.SIM_SANDBOX_CPU_SEC ?? cpuBackstop,
            fileSizeMb: env.SIM_SANDBOX_FSIZE_MB ?? 256,
            maxProcs: env.SIM_SANDBOX_NPROC ?? 64,
        },
    };
}
