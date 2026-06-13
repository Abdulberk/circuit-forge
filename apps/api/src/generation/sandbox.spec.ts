/**
 * Sandbox command builder. Pure + platform-parameterized, so the Linux ulimit wrapping is verifiable
 * on any host (incl. the Windows dev box, where enforcement itself can't run). The worker ships a
 * byte-identical copy (apps/worker-sim/src/simulation/sandbox.ts).
 */
import { sandboxedCommand, resolveSandboxConfig, type SandboxConfig } from './sandbox';

const LIMITS = { memoryMb: 2048, cpuSec: 25, fileSizeMb: 256, maxProcs: 64 };
const rlimit: SandboxConfig = { mode: 'rlimit', limits: LIMITS };

describe('sandboxedCommand', () => {
    it('wraps with a bash ulimit preamble + exec on Linux (args passed as argv, no interpolation)', () => {
        const cmd = sandboxedCommand('/usr/bin/ngspice', ['-b', '-o', 'stdout.log', 'circuit.cir'], rlimit, 'linux');
        expect(cmd.file).toBe('bash');
        expect(cmd.args[0]).toBe('-c');
        // ulimit numbers: -v in KB (2048*1024), -t seconds, -f in 1024-blocks (256*1024), -u procs.
        expect(cmd.args[1]).toBe('ulimit -v 2097152 -t 25 -f 262144 -u 64; exec "$@"');
        expect(cmd.args[2]).toBe('bash'); // $0
        expect(cmd.args.slice(3)).toEqual(['/usr/bin/ngspice', '-b', '-o', 'stdout.log', 'circuit.cir']);
    });

    it('drops to a dedicated user via su-exec when one is configured (Linux)', () => {
        const cmd = sandboxedCommand('/usr/bin/ngspice', ['-b', 'circuit.cir'], { ...rlimit, user: 'simrunner' }, 'linux');
        expect(cmd.file).toBe('bash');
        // limits still applied, then exec hands off to su-exec which exec-replaces itself with ngspice.
        expect(cmd.args[1]).toBe('ulimit -v 2097152 -t 25 -f 262144 -u 64; exec su-exec simrunner "$@"');
        expect(cmd.args.slice(3)).toEqual(['/usr/bin/ngspice', '-b', 'circuit.cir']); // bin/args stay argv
    });

    it('runs the binary directly on non-Linux (Windows dev) even when mode is rlimit', () => {
        const cmd = sandboxedCommand('ngspice_con.exe', ['-b', 'circuit.cir'], rlimit, 'win32');
        expect(cmd).toEqual({ file: 'ngspice_con.exe', args: ['-b', 'circuit.cir'] });
    });

    it('runs directly when mode is none, on Linux', () => {
        const cmd = sandboxedCommand('/usr/bin/ngspice', ['-b'], { mode: 'none', limits: LIMITS }, 'linux');
        expect(cmd).toEqual({ file: '/usr/bin/ngspice', args: ['-b'] });
    });
});

describe('resolveSandboxConfig', () => {
    it('auto → rlimit on Linux, none elsewhere', () => {
        expect(resolveSandboxConfig({ platform: 'linux' }).mode).toBe('rlimit');
        expect(resolveSandboxConfig({ platform: 'win32' }).mode).toBe('none');
        expect(resolveSandboxConfig({ SIM_SANDBOX: 'auto', platform: 'darwin' }).mode).toBe('none');
    });

    it('explicit none/rlimit override auto', () => {
        expect(resolveSandboxConfig({ SIM_SANDBOX: 'none', platform: 'linux' }).mode).toBe('none');
        expect(resolveSandboxConfig({ SIM_SANDBOX: 'rlimit', platform: 'win32' }).mode).toBe('rlimit'); // but sandboxedCommand no-ops on win32
    });

    it('applies limit defaults and a CPU backstop derived from the wall-clock timeout', () => {
        const c = resolveSandboxConfig({ platform: 'linux', SIM_TIMEOUT_MS: 10000 });
        expect(c.limits).toMatchObject({ memoryMb: 2048, fileSizeMb: 256, maxProcs: 64 });
        expect(c.limits.cpuSec).toBe(Math.ceil(10000 / 1000) * 2 + 5); // 25 — comfortably above 10s wall-clock
    });

    it('honors explicit limit overrides', () => {
        const c = resolveSandboxConfig({ platform: 'linux', SIM_SANDBOX_MEMORY_MB: 512, SIM_SANDBOX_CPU_SEC: 15, SIM_SANDBOX_FSIZE_MB: 64, SIM_SANDBOX_NPROC: 16 });
        expect(c.limits).toEqual({ memoryMb: 512, cpuSec: 15, fileSizeMb: 64, maxProcs: 16 });
    });

    it('runs as SIM_SANDBOX_USER when it is a valid username', () => {
        expect(resolveSandboxConfig({ platform: 'linux', SIM_SANDBOX_USER: 'simrunner' }).user).toBe('simrunner');
    });

    it('ignores an unsafe SIM_SANDBOX_USER so nothing but a plain name reaches the preamble', () => {
        expect(resolveSandboxConfig({ platform: 'linux', SIM_SANDBOX_USER: 'x; rm -rf /' }).user).toBeUndefined();
        expect(resolveSandboxConfig({ platform: 'linux', SIM_SANDBOX_USER: '$(whoami)' }).user).toBeUndefined();
        expect(resolveSandboxConfig({ platform: 'linux' }).user).toBeUndefined();
    });
});
