/**
 * OS resource-limit hardening for the ngspice child process.
 *
 * ngspice runs user-supplied SPICE. The netlist is already sanitized (shell directives rejected,
 * .include path-whitelisted) and time-bounded, but a malicious or pathological circuit can still try
 * to exhaust HOST resources — balloon memory (OOM the box), spin CPU, write a giant output file (fill
 * the disk), or fork. This wraps the spawn so the kernel caps those per run.
 *
 * On Linux we prepend a bash `ulimit` preamble and `exec` the binary (so the timeout/kill still target
 * the ngspice PID — exec replaces the shell, no lingering process). On non-Linux (Windows dev) or mode
 * 'none' we run the binary directly — ulimit is a POSIX/Linux mechanism, so enforcement is Linux-prod
 * only (where the worker/api run in Debian-based containers that ship bash). This is a RESOURCE bound,
 * not a namespace sandbox; full network/filesystem isolation (bubblewrap / per-job container / gVisor)
 * is the recommended stronger layer on top — see ARCHITECTURE/SECURITY docs.
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
    /** RLIMIT_NPROC — max processes/threads (blocks fork bombs). */
    maxProcs: number;
}

export interface SandboxConfig {
    mode: SandboxMode;
    limits: SandboxLimits;
}

/**
 * Build the argv to run `bin args` under `cfg`. On Linux + mode 'rlimit', wraps with
 * `bash -c 'ulimit ...; exec "$@"' bash <bin> <args...>` (args passed as argv — no string
 * interpolation, so no shell-injection surface). Otherwise returns the command unchanged.
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
    // -u max user processes. `exec "$@"` replaces bash with ngspice (same PID → kill/timeout still work).
    const preamble = `ulimit -v ${memoryMb * 1024} -t ${cpuSec} -f ${fileSizeMb * 1024} -u ${maxProcs}`;
    return { file: 'bash', args: ['-c', `${preamble}; exec "$@"`, 'bash', bin, ...args] };
}

/** Resolve sandbox config from env. SIM_SANDBOX: 'auto' (default) → rlimit on Linux, none elsewhere. */
export function resolveSandboxConfig(env: {
    SIM_SANDBOX?: string;
    SIM_SANDBOX_MEMORY_MB?: number;
    SIM_SANDBOX_CPU_SEC?: number;
    SIM_SANDBOX_FSIZE_MB?: number;
    SIM_SANDBOX_NPROC?: number;
    SIM_TIMEOUT_MS?: number;
    platform?: NodeJS.Platform;
}): SandboxConfig {
    const platform = env.platform ?? process.platform;
    const requested = (env.SIM_SANDBOX ?? 'auto').toLowerCase();
    const mode: SandboxMode = requested === 'none' ? 'none' : requested === 'rlimit' ? 'rlimit' : platform === 'linux' ? 'rlimit' : 'none';
    // CPU backstop sits comfortably above the wall-clock timeout so it never fires for a legit run.
    const cpuBackstop = Math.ceil((env.SIM_TIMEOUT_MS ?? 10000) / 1000) * 2 + 5;
    return {
        mode,
        limits: {
            memoryMb: env.SIM_SANDBOX_MEMORY_MB ?? 2048,
            cpuSec: env.SIM_SANDBOX_CPU_SEC ?? cpuBackstop,
            fileSizeMb: env.SIM_SANDBOX_FSIZE_MB ?? 256,
            maxProcs: env.SIM_SANDBOX_NPROC ?? 64,
        },
    };
}
