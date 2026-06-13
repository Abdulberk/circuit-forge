/**
 * OS resource-limit hardening for the inline ngspice child (the AI verify loop + /verify-design run
 * user-supplied SPICE in-process). Identical mechanism to the worker's sandbox (apps/worker-sim/src/
 * simulation/sandbox.ts) — kept as a separate copy because the two are independent deployables; both
 * are unit-tested. On Linux it prepends a bash `ulimit` preamble and `exec`s the binary (so the
 * kill/timeout still target the ngspice PID); on Windows dev / mode 'none' it runs the binary directly.
 * This is a RESOURCE bound, not a namespace sandbox — full network/FS isolation (bubblewrap / per-job
 * container) is the recommended stronger layer. Pure: returns the command; does not spawn.
 */
export type SandboxMode = 'none' | 'rlimit';

export interface SandboxLimits {
    memoryMb: number; // RLIMIT_AS — virtual address space
    cpuSec: number; // RLIMIT_CPU — backstop to the wall-clock timeout
    fileSizeMb: number; // RLIMIT_FSIZE — caps a runaway output.csv
    maxProcs: number; // RLIMIT_NPROC — blocks fork bombs
}

export interface SandboxConfig {
    mode: SandboxMode;
    limits: SandboxLimits;
}

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
    // bash ulimit units: -v (KB), -t (CPU s), -f (1024-byte blocks), -u (procs). exec replaces the
    // shell with ngspice (same PID), and args are argv (no interpolation → no injection surface).
    const preamble = `ulimit -v ${memoryMb * 1024} -t ${cpuSec} -f ${fileSizeMb * 1024} -u ${maxProcs}`;
    return { file: 'bash', args: ['-c', `${preamble}; exec "$@"`, 'bash', bin, ...args] };
}

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
