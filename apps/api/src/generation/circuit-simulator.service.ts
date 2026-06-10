/**
 * In-process circuit simulator for the AI "verify-and-fix" loop.
 *
 * Given a model-proposed CircuitJson, this runs the same pipeline the queued worker uses — ERC +
 * eda-core netlist generation + ngspice — but SYNCHRONOUSLY (async/await) in a sandboxed temp dir, and
 * returns a COMPACT summary (ERC findings + run status + per-node measurements) the LLM can read and act
 * on. It is the lightweight, inline counterpart to the queued /design-circuit worker path; it does NOT
 * persist a job. ngspice is a local binary (no network), so this is fully testable offline.
 *
 * Security mirrors the worker (apps/worker-sim/src/simulation/runner.ts): eda-core sanitizes node names
 * during netlist generation, `sanitizeNetlist` rejects shell directives, the run happens in an isolated
 * per-call temp dir with a hard timeout + SIGKILL, the output is size-capped, and NO untrusted `.include`
 * files are ever written (only vetted generic model bodies attached by `attachGenericModels`).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
    safeValidateCircuitJson,
    runErc,
    generateNetlist,
    sanitizeNetlist,
    extractProbes,
    parseSimulationOutput,
    parseSpiceValue,
    type CircuitJson,
    type AnalysisConfig,
    type DataSeries,
} from '@circuit-forge/eda-core';
import { attachGenericModels } from './model-resolution';

/** One node's behaviour over the run, distilled to four numbers the model can reason about. */
export interface SimMeasurement {
    node: string;
    min: number;
    max: number;
    final: number;
    pp: number; // peak-to-peak (max - min)
}

/** The compact, token-bounded result fed back to the model. Never contains raw CSV. */
export interface SimSummary {
    simStatus: 'ok' | 'failed' | 'skipped';
    /** ERC errors (must fix) and warnings (should review), each code + message + related component/net ids. */
    ercErrors: { code: string; message: string; relatedIds: string[] }[];
    ercWarnings: { code: string; message: string; relatedIds: string[] }[];
    /** Set when the netlist couldn't be built or ngspice didn't produce a usable result. */
    runError?: string;
    measurements: SimMeasurement[];
    nodeCount: number;
    analysisType?: string;
}

/** Per-call resource bounds (kept tighter than the queued worker — this runs inline in an HTTP request). */
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_REPORTED_MEASUREMENTS = 40; // cap the per-node list so a wide circuit can't blow the token budget
/**
 * Global concurrency bound for INLINE ngspice runs. The per-user throttle (5/min on generate) does not
 * bound the FLEET: N users × up to maxToolIters verify-loop turns each could otherwise pile up unbounded
 * concurrent ngspice processes (each up to SIM_TIMEOUT_MS of CPU). The spawn itself is async (the event
 * loop is never blocked) — this protects the HOST (CPU/process count), like the worker's CONCURRENCY=2.
 */
const DEFAULT_MAX_CONCURRENT = 4;
/** How long a simulate call may WAIT for a slot before giving up (bounded so the AI loop isn't stalled). */
const DEFAULT_QUEUE_WAIT_MS = 15000;

/** Minimal async semaphore: acquire resolves false (instead of queueing forever) after `waitMs`. */
class Semaphore {
    private inUse = 0;
    private readonly waiters: Array<() => void> = [];
    constructor(private readonly limit: number) {}

    async acquire(waitMs: number): Promise<boolean> {
        if (this.inUse < this.limit) {
            this.inUse++;
            return true;
        }
        return new Promise<boolean>((resolve) => {
            let settled = false;
            const waiter = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.inUse++;
                resolve(true);
            };
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                const i = this.waiters.indexOf(waiter);
                if (i >= 0) this.waiters.splice(i, 1);
                resolve(false);
            }, waitMs);
            this.waiters.push(waiter);
        });
    }

    release(): void {
        this.inUse--;
        const next = this.waiters.shift();
        if (next) next();
    }
}

@Injectable()
export class CircuitSimulatorService {
    /** One semaphore per service instance (the service is a singleton) — bounds inline ngspice host-wide. */
    private readonly semaphore: Semaphore;

    constructor(private readonly config: ConfigService) {
        const limit = Number(this.config.get<string>('SIM_INLINE_CONCURRENCY')) || DEFAULT_MAX_CONCURRENT;
        this.semaphore = new Semaphore(limit);
    }

    private queueWaitMs(): number {
        return Number(this.config.get<string>('SIM_INLINE_QUEUE_WAIT_MS')) || DEFAULT_QUEUE_WAIT_MS;
    }

    /** Whether an ngspice binary is configured — gates the simulate tool at offer time. */
    available(): boolean {
        return !!this.config.get<string>('NGSPICE_PATH');
    }

    /**
     * Validate → attach generic models → ERC → netlist → ngspice → parse → summarize.
     * Never throws: every failure mode is reported in the summary so the agentic loop stays alive.
     */
    async simulate(circuitInput: unknown, analysis?: AnalysisConfig): Promise<SimSummary> {
        const ngspicePath = this.config.get<string>('NGSPICE_PATH');
        if (!ngspicePath) {
            return { simStatus: 'skipped', ercErrors: [], ercWarnings: [], measurements: [], nodeCount: 0, runError: 'simulation not configured' };
        }

        // 1) Validate the model-proposed circuit against the schema.
        const validated = safeValidateCircuitJson(circuitInput);
        if (!validated.success) {
            const issues = validated.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
            return { simStatus: 'failed', ercErrors: [], ercWarnings: [], measurements: [], nodeCount: 0, runError: `invalid circuit: ${issues}` };
        }
        const circuit = validated.data as CircuitJson;

        // 2) Attach the bodies of any referenced generic models (bjt/mosfet/subckt/…) so it is self-contained.
        attachGenericModels(circuit);

        // 3) ERC (always runs, even if ngspice later fails — the model wants both signals).
        const erc = runErc(circuit);
        const ercErrors = erc.issues.filter((i) => i.severity === 'error').map((i) => ({ code: i.code, message: i.message, relatedIds: i.relatedIds }));
        const ercWarnings = erc.issues.filter((i) => i.severity === 'warning').map((i) => ({ code: i.code, message: i.message, relatedIds: i.relatedIds }));

        const an: AnalysisConfig = analysis ?? { type: 'op' };

        // 4) Generate the netlist (can throw on a conflicting model body — report, don't crash).
        let netlist: string;
        try {
            netlist = generateNetlist(circuit, an);
        } catch (e) {
            return { simStatus: 'failed', ercErrors, ercWarnings, measurements: [], nodeCount: 0, analysisType: an.type, runError: `netlist generation failed: ${e instanceof Error ? e.message : String(e)}` };
        }

        // 5-7) Run ngspice in an isolated temp dir, parse the output — under the GLOBAL semaphore, so a
        // burst of verify-loops can't pile up unbounded concurrent ngspice processes on the host. Everything
        // above (validation/ERC/netlist) is cheap pure-JS and stays outside the gate. If no slot frees up
        // within the wait window we report 'skipped' (the AI loop continues with ERC-only feedback).
        const gotSlot = await this.semaphore.acquire(this.queueWaitMs());
        if (!gotSlot) {
            return { simStatus: 'skipped', ercErrors, ercWarnings, measurements: [], nodeCount: 0, analysisType: an.type, runError: 'simulation capacity is saturated — proceeding on ERC results only (try again shortly)' };
        }
        const dir = path.join(os.tmpdir(), 'cf-sim', randomUUID());
        try {
            await fs.mkdir(dir, { recursive: true });
            const sanitized = sanitizeNetlist(netlist, dir); // rejects shell directives / bad includes
            await fs.writeFile(path.join(dir, 'circuit.cir'), sanitized);

            const { stderr, exitCode, timedOut } = await this.runNgspice(ngspicePath, dir);
            if (timedOut) return { simStatus: 'failed', ercErrors, ercWarnings, measurements: [], nodeCount: 0, analysisType: an.type, runError: 'simulation timed out' };
            if (exitCode !== 0) {
                return { simStatus: 'failed', ercErrors, ercWarnings, measurements: [], nodeCount: 0, analysisType: an.type, runError: this.distillNgspiceError(stderr, exitCode) };
            }

            let csv: string;
            try {
                csv = await fs.readFile(path.join(dir, 'output.csv'), 'utf-8');
            } catch {
                return { simStatus: 'failed', ercErrors, ercWarnings, measurements: [], nodeCount: 0, analysisType: an.type, runError: 'ngspice produced no output (likely a non-converging or degenerate circuit)' };
            }
            if (Buffer.byteLength(csv) > DEFAULT_MAX_OUTPUT_BYTES) {
                return { simStatus: 'failed', ercErrors, ercWarnings, measurements: [], nodeCount: 0, analysisType: an.type, runError: 'simulation output too large to summarize' };
            }

            const probes = extractProbes(sanitized);
            const result = parseSimulationOutput(csv, probes, an.type);

            // Detect a SILENTLY TRUNCATED transient: ngspice can exit 0 yet stop far before stopTime when the
            // adaptive timestep collapses (floating node / too-hard a switching edge). Reporting that partial
            // run as "ok" would mislead the model — treat ending well short of stopTime as a failure.
            if (an.type === 'tran') {
                const lastT = Math.max(
                    0,
                    ...result.series.map((s) => (s.points.length ? s.points[s.points.length - 1]!.x : 0)),
                );
                const parsedStop = parseSpiceValue(an.stopTime);
                const want = parsedStop.isValid ? parsedStop.value : 0;
                if (want > 0 && lastT > 0 && lastT < 0.9 * want) {
                    return {
                        simStatus: 'failed',
                        ercErrors,
                        ercWarnings,
                        measurements: [],
                        nodeCount: result.series.length,
                        analysisType: an.type,
                        runError: `simulation ended early at t=${lastT.toExponential(2)}s of ${an.stopTime} (timestep collapse / non-convergence — often a floating node, a missing DC path to ground, or too-hard a switching edge)`,
                    };
                }
            }

            const measurements = result.series.map(summarizeSeries).slice(0, MAX_REPORTED_MEASUREMENTS);
            return {
                simStatus: 'ok',
                ercErrors,
                ercWarnings,
                measurements,
                nodeCount: result.series.length,
                analysisType: an.type,
            };
        } catch (e) {
            return { simStatus: 'failed', ercErrors, ercWarnings, measurements: [], nodeCount: 0, analysisType: an.type, runError: e instanceof Error ? e.message : String(e) };
        } finally {
            this.semaphore.release();
            await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    /** Spawn ngspice in batch mode, mirroring the worker (apps/worker-sim/src/simulation/runner.ts). */
    private runNgspice(ngspicePath: string, cwd: string): Promise<{ stderr: string; exitCode: number | null; timedOut: boolean }> {
        const timeoutMs = Number(this.config.get<string>('SIM_TIMEOUT_MS')) || DEFAULT_TIMEOUT_MS;
        return new Promise((resolve) => {
            const proc: ChildProcess = spawn(ngspicePath, ['-b', '-o', 'stdout.log', 'circuit.cir'], {
                cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: timeoutMs,
            });
            let stderr = '';
            let timedOut = false;
            proc.stdout?.on('data', () => undefined); // drained but unused; the result is output.csv
            proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
            const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
            proc.on('close', (code) => { clearTimeout(timer); resolve({ stderr, exitCode: code, timedOut }); });
            proc.on('error', (err) => { clearTimeout(timer); resolve({ stderr: stderr + err.message, exitCode: 1, timedOut: false }); });
        });
    }

    /** Pull the most actionable line out of ngspice stderr so the model gets a specific, short cause. */
    private distillNgspiceError(stderr: string, exitCode: number | null): string {
        const line = stderr
            .split('\n')
            .map((l) => l.trim())
            .find((l) => /singular matrix|no convergence|Timestep too small|Unable to find|fatal|aborted|no such/i.test(l));
        return line ? `ngspice error: ${line}` : `ngspice exited with code ${exitCode}`;
    }
}

/** Distil one series to {min,max,final,pp}. Empty series degrade to zeros (caller reports nodeCount=0). */
function summarizeSeries(s: DataSeries): SimMeasurement {
    const ys = s.points.map((p) => p.y).filter((y) => Number.isFinite(y));
    if (ys.length === 0) return { node: s.name, min: 0, max: 0, final: 0, pp: 0 };
    const min = Math.min(...ys);
    const max = Math.max(...ys);
    const round = (n: number) => Number(n.toPrecision(4));
    return { node: s.name, min: round(min), max: round(max), final: round(ys[ys.length - 1]!), pp: round(max - min) };
}
