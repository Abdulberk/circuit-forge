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
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    safeValidateCircuitJson,
    runErc,
    generateNetlist,
    sanitizeNetlist,
    extractProbes,
    parseSimulationOutput,
    parseSpiceValue,
    assessTransientCompleteness,
    diagnoseConvergence,
    convergenceRemedyLadder,
    summarizeSeries,
    parseFourierLog,
    parseTransferFunction,
    attachFourierThd,
    attachTransferFunction,
    type CircuitJson,
    type AnalysisConfig,
    type ConvergenceReport,
    type SimMeasurement,
} from '@circuit-forge/eda-core';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { attachGenericModels } from './model-resolution';
import { sandboxedCommand, resolveSandboxConfig, type SandboxConfig } from './sandbox';

// The Convergence Doctor + the measurement distiller (summarizeSeries / SimMeasurement) now live in eda-core
// so the WORKER runs the identical logic in prod (and the Monte-Carlo batch can reduce each variant locally).
// Re-exported here so existing importers (verification.service, design.service, assertions) keep their
// './circuit-simulator.service' path unchanged.
export type { ConvergenceReport, SimMeasurement } from '@circuit-forge/eda-core';
export { summarizeSeries } from '@circuit-forge/eda-core';

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
    /** Set by simulateWithRemedies() when a convergence failure was diagnosed (and possibly fixed). */
    convergence?: ConvergenceReport;
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
    async simulate(circuitInput: unknown, analysis?: AnalysisConfig, extraProbes?: string[]): Promise<SimSummary> {
        const ngspicePath = this.config.get<string>('NGSPICE_PATH');
        if (!ngspicePath) {
            return {
                simStatus: 'skipped',
                ercErrors: [],
                ercWarnings: [],
                measurements: [],
                nodeCount: 0,
                runError: 'simulation not configured',
            };
        }

        // 1) Validate the model-proposed circuit against the schema.
        const validated = safeValidateCircuitJson(circuitInput);
        if (!validated.success) {
            const issues = validated.error.errors
                .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
                .join('; ');
            return {
                simStatus: 'failed',
                ercErrors: [],
                ercWarnings: [],
                measurements: [],
                nodeCount: 0,
                runError: `invalid circuit: ${issues}`,
            };
        }
        const circuit = validated.data as CircuitJson;

        // 2) Attach the bodies of any referenced generic models (bjt/mosfet/subckt/…) so it is self-contained.
        attachGenericModels(circuit);

        // 3) ERC (always runs, even if ngspice later fails — the model wants both signals).
        const erc = runErc(circuit);
        const ercErrors = erc.issues
            .filter((i) => i.severity === 'error')
            .map((i) => ({ code: i.code, message: i.message, relatedIds: i.relatedIds }));
        const ercWarnings = erc.issues
            .filter((i) => i.severity === 'warning')
            .map((i) => ({ code: i.code, message: i.message, relatedIds: i.relatedIds }));

        const an: AnalysisConfig = analysis ?? { type: 'op' };

        // 4) Generate the netlist (can throw on a conflicting model body — report, don't crash).
        let netlist: string;
        try {
            // Branch-current assertion probes (i(R1)) aren't in the voltage-only defaults — UNION them in.
            netlist = generateNetlist(circuit, an, extraProbes?.length ? { extraProbes } : {});
        } catch (e) {
            return {
                simStatus: 'failed',
                ercErrors,
                ercWarnings,
                measurements: [],
                nodeCount: 0,
                analysisType: an.type,
                runError: `netlist generation failed: ${e instanceof Error ? e.message : String(e)}`,
            };
        }

        // 5-7) Run ngspice in an isolated temp dir, parse the output — under the GLOBAL semaphore, so a
        // burst of verify-loops can't pile up unbounded concurrent ngspice processes on the host. Everything
        // above (validation/ERC/netlist) is cheap pure-JS and stays outside the gate. If no slot frees up
        // within the wait window we report 'skipped' (the AI loop continues with ERC-only feedback).
        const gotSlot = await this.semaphore.acquire(this.queueWaitMs());
        if (!gotSlot) {
            return {
                simStatus: 'skipped',
                ercErrors,
                ercWarnings,
                measurements: [],
                nodeCount: 0,
                analysisType: an.type,
                runError: 'simulation capacity is saturated — proceeding on ERC results only (try again shortly)',
            };
        }
        const dir = path.join(os.tmpdir(), 'cf-sim', randomUUID());
        try {
            await fs.mkdir(dir, { recursive: true });
            const sanitized = sanitizeNetlist(netlist, dir); // rejects shell directives / bad includes
            await fs.writeFile(path.join(dir, 'circuit.cir'), sanitized);

            const { stdout, stderr, exitCode, timedOut } = await this.runNgspice(ngspicePath, dir);
            if (timedOut)
                return {
                    simStatus: 'failed',
                    ercErrors,
                    ercWarnings,
                    measurements: [],
                    nodeCount: 0,
                    analysisType: an.type,
                    runError: 'simulation timed out',
                };
            if (exitCode !== 0) {
                return {
                    simStatus: 'failed',
                    ercErrors,
                    ercWarnings,
                    measurements: [],
                    nodeCount: 0,
                    analysisType: an.type,
                    runError: this.distillNgspiceError(stderr, exitCode),
                };
            }

            let csv: string;
            try {
                csv = await fs.readFile(path.join(dir, 'output.csv'), 'utf-8');
            } catch {
                return {
                    simStatus: 'failed',
                    ercErrors,
                    ercWarnings,
                    measurements: [],
                    nodeCount: 0,
                    analysisType: an.type,
                    runError: 'ngspice produced no output (likely a non-converging or degenerate circuit)',
                };
            }
            if (Buffer.byteLength(csv) > DEFAULT_MAX_OUTPUT_BYTES) {
                return {
                    simStatus: 'failed',
                    ercErrors,
                    ercWarnings,
                    measurements: [],
                    nodeCount: 0,
                    analysisType: an.type,
                    runError: 'simulation output too large to summarize',
                };
            }

            const probes = extractProbes(sanitized);
            const result = parseSimulationOutput(csv, probes, an.type);

            // Detect a SILENTLY TRUNCATED transient: ngspice can exit 0 yet stop far before stopTime when the
            // adaptive timestep collapses (floating node / too-hard a switching edge). Reporting that partial
            // run as "ok" would mislead the model — treat ending well short of stopTime as a failure.
            if (an.type === 'tran') {
                const parsedStop = parseSpiceValue(an.stopTime);
                const { endedEarly, lastTime } = assessTransientCompleteness(
                    result.series,
                    parsedStop.isValid ? parsedStop.value : 0,
                );
                if (endedEarly) {
                    return {
                        simStatus: 'failed',
                        ercErrors,
                        ercWarnings,
                        measurements: [],
                        nodeCount: result.series.length,
                        analysisType: an.type,
                        runError: `simulation ended early at t=${lastTime.toExponential(2)}s of ${an.stopTime} (timestep collapse / non-convergence — often a floating node, a missing DC path to ground, or too-hard a switching edge)`,
                    };
                }
            }

            const allMeasurements = result.series.map((s) => summarizeSeries(s, an.type));

            // Fold in the LISTING-derived metrics a thd/gain criterion gates on. Unlike the worker's runSimulation
            // (which parses these and puts them on SimulationResult), the inline runner only reads output.csv — so
            // THD (from a `fourier` request) and small-signal gain (from a `tf` request) live in ngspice's `-o`
            // listing, unread. Parse it here, gated on the deck actually requesting them, and attach — same pattern
            // and same helpers as apps/worker-sim/src/simulation/runner.ts. Best-effort: a parse miss never fails
            // the run (report-only metrics don't gate on their own; only an explicit thd/gain assertion does).
            // Attach on the FULL set BEFORE the display cap below — slicing first would strip the metric from a
            // target probe beyond MAX_REPORTED_MEASUREMENTS (the worker path is uncapped; keep parity for ≤cap).
            const wantsFourier = /^\s*fourier\s/im.test(sanitized);
            const wantsTf = /^\s*tf\s/im.test(sanitized);
            if (wantsFourier || wantsTf) {
                // Combine the stdout pipe AND the -o log — the fourier/tf tables land in one or the other
                // depending on the ngspice build (same as the worker's runner reads both).
                const listing = `${stdout}\n${await fs.readFile(path.join(dir, 'stdout.log'), 'utf-8').catch(() => '')}`;
                if (wantsFourier) attachFourierThd(allMeasurements, parseFourierLog(listing));
                // Pass the requested tf output node as a fallback so a valid gain still binds if ngspice's
                // `output_impedance_at_<node>` echo is missing/truncated (else outputNode='' → binds to nothing).
                if (wantsTf)
                    attachTransferFunction(
                        allMeasurements,
                        parseTransferFunction(listing, sanitized.match(/^\s*tf\s+(\S+)/im)?.[1]),
                    );
            }

            // Cap the per-node list (token budget for a wide circuit) AFTER attaching so the metrics survive.
            const measurements = allMeasurements.slice(0, MAX_REPORTED_MEASUREMENTS);
            return {
                simStatus: 'ok',
                ercErrors,
                ercWarnings,
                measurements,
                nodeCount: result.series.length,
                analysisType: an.type,
            };
        } catch (e) {
            return {
                simStatus: 'failed',
                ercErrors,
                ercWarnings,
                measurements: [],
                nodeCount: 0,
                analysisType: an.type,
                runError: e instanceof Error ? e.message : String(e),
            };
        } finally {
            this.semaphore.release();
            await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    /**
     * Convergence Doctor: simulate(), and if it fails with a CONVERGENCE-class error, automatically
     * retry with an escalating ladder of solver remedies (gmin / tolerance / iteration-limit / gear),
     * stopping at the first that converges. Returns the recovered summary annotated with what fixed it,
     * or the original failure annotated with a plain-language diagnosis when nothing helped. Non-
     * convergence failures (bad netlist, timeout) and successful runs pass straight through unchanged,
     * so the proven happy path costs exactly one run.
     */
    async simulateWithRemedies(
        circuitInput: unknown,
        analysis?: AnalysisConfig,
        extraProbes?: string[],
    ): Promise<SimSummary> {
        const base = await this.simulate(circuitInput, analysis, extraProbes);
        if (base.simStatus !== 'failed') return base;

        const diag = diagnoseConvergence(base.runError, base.analysisType);
        if (!diag.isConvergence) return base; // not a solver problem — remedies won't help

        const ladder = convergenceRemedyLadder(base.analysisType);
        const baseAnalysis: AnalysisConfig = analysis ?? { type: 'op' };
        const baseOptions = (baseAnalysis as { options?: Record<string, unknown> }).options ?? {};
        const tried: string[] = [];

        for (const remedy of ladder) {
            const mergedAnalysis = {
                ...baseAnalysis,
                options: { ...baseOptions, ...remedy.options },
            } as AnalysisConfig;
            const retry = await this.simulate(circuitInput, mergedAnalysis, extraProbes);
            if (retry.simStatus === 'ok') {
                return {
                    ...retry,
                    convergence: {
                        recovered: true,
                        kind: diag.kind,
                        diagnosis: diag.explanation,
                        remedyApplied: remedy.label,
                        rationale: remedy.rationale,
                        attempts: tried.length + 1,
                    },
                };
            }
            // A 'skipped' retry means host sim capacity is saturated — stop walking the ladder rather
            // than block (up to the queue-wait) on each remaining remedy, and don't claim it was tried.
            if (retry.simStatus === 'skipped') {
                return {
                    ...base,
                    convergence: {
                        recovered: false,
                        kind: diag.kind,
                        diagnosis: diag.explanation,
                        attempts: tried.length,
                        triedRemedies: tried,
                        note: 'simulation capacity was saturated — not all remedies could be attempted; retry shortly.',
                    },
                };
            }
            tried.push(remedy.label);
        }

        return {
            ...base,
            convergence: {
                recovered: false,
                kind: diag.kind,
                diagnosis: diag.explanation,
                attempts: tried.length,
                triedRemedies: tried,
            },
        };
    }

    /** Sandbox config for the inline ngspice child, read once from env. */
    private sandboxConfig(timeoutMs: number): SandboxConfig {
        const num = (k: string) => {
            const v = Number(this.config.get<string>(k));
            return Number.isFinite(v) && v > 0 ? v : undefined;
        };
        return resolveSandboxConfig({
            SIM_SANDBOX: this.config.get<string>('SIM_SANDBOX'),
            SIM_SANDBOX_MEMORY_MB: num('SIM_SANDBOX_MEMORY_MB'),
            SIM_SANDBOX_CPU_SEC: num('SIM_SANDBOX_CPU_SEC'),
            SIM_SANDBOX_FSIZE_MB: num('SIM_SANDBOX_FSIZE_MB'),
            SIM_SANDBOX_NPROC: num('SIM_SANDBOX_NPROC'),
            SIM_TIMEOUT_MS: timeoutMs,
        });
    }

    /** Spawn ngspice in batch mode, mirroring the worker (apps/worker-sim/src/simulation/runner.ts). */
    private runNgspice(
        ngspicePath: string,
        cwd: string,
    ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
        const timeoutMs = Number(this.config.get<string>('SIM_TIMEOUT_MS')) || DEFAULT_TIMEOUT_MS;
        // OS resource limits (Linux prod) so an untrusted/verify-design circuit can't exhaust the host;
        // direct spawn on Windows dev / SIM_SANDBOX=none.
        const { file, args } = sandboxedCommand(
            ngspicePath,
            ['-b', '-o', 'stdout.log', 'circuit.cir'],
            this.sandboxConfig(timeoutMs),
        );
        return new Promise((resolve) => {
            const proc: ChildProcess = spawn(file, args, {
                cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: timeoutMs,
            });
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            // The wrdata series is a FILE (output.csv) — the stdout pipe carries ngspice's listing echo, which is
            // where the `fourier`/`tf` control commands may print their tables (BUILD-DEPENDENT: stdout pipe OR
            // the `-o` log). Capture it (bounded; the listing is small, not the dataset) so a thd/gain criterion
            // can read those metrics regardless of which sink this ngspice build uses — same as the worker.
            proc.stdout?.on('data', (d: Buffer) => {
                stdout += d.toString();
            });
            proc.stderr?.on('data', (d: Buffer) => {
                stderr += d.toString();
            });
            const timer = setTimeout(() => {
                timedOut = true;
                proc.kill('SIGKILL');
            }, timeoutMs);
            proc.on('close', (code) => {
                clearTimeout(timer);
                resolve({ stdout, stderr, exitCode: code, timedOut });
            });
            proc.on('error', (err) => {
                clearTimeout(timer);
                resolve({ stdout, stderr: stderr + err.message, exitCode: 1, timedOut: false });
            });
        });
    }

    /** Pull the most actionable line out of ngspice stderr so the model gets a specific, short cause. */
    private distillNgspiceError(stderr: string, exitCode: number | null): string {
        const line = stderr
            .split('\n')
            .map((l) => l.trim())
            .find((l) =>
                /singular matrix|no convergence|Timestep too small|Unable to find|fatal|aborted|no such/i.test(l),
            );
        return line ? `ngspice error: ${line}` : `ngspice exited with code ${exitCode}`;
    }
}

/* summarizeSeries + SimMeasurement moved to eda-core (src/analysis/measurements.ts); re-exported at the top
 * of this file so all './circuit-simulator.service' importers are unchanged. */
