/**
 * In-process ("local") simulation surface for the worker's design loop.
 *
 * runDesignLoop talks to a simulation backend through three calls — createQuickSim → getStatus → getResult
 * (plus a Monte-Carlo variant) — a contract shaped around the API's ASYNC simulation QUEUE. In the worker we
 * must NOT re-enqueue those per-round sims onto the 'simulations' queue: a design job that enqueues a sim and
 * then polls it would, if both shared a worker pool, risk holding every slot while waiting for a sim that can
 * never start (self-deadlock — see config.ts DESIGN_CONCURRENCY). So this surface runs ngspice RIGHT HERE,
 * synchronously, and serves the queue-shaped contract out of a small in-memory map: createQuickSim runs the
 * sim and stashes its terminal outcome; the first getStatus poll returns that terminal status (no waiting);
 * getResult returns the (downsampled) series.
 *
 * The mapping from the runner's SimulationJobResult to {status, metrics} and the getResult payload MIRRORS the
 * 'simulations' queue processor's handleSuccess / handleFailure EXACTLY (same status values, same
 * metrics.failureClass='infra'|'sim', same convergence report, same WORKER_MAX_POINTS bounding), so the loop
 * sees byte-identical evidence whether it runs in the API (real queue + DB rows) or here (this local path).
 * Like the API's createQuickSim, probe names are left empty so the runner derives them from the netlist's
 * `wrdata` line (extractProbes) — identical to production.
 *
 * Per design job the loop runs ≤ maxRounds (≤4) sims + at most one MC pass, so the map holds a handful of
 * entries and is garbage-collected with the surface when the job ends. `userId` is unused — there is no
 * per-sim ownership row here; the DesignJob is the single owned/billable unit.
 */
import { downsampleResult, type AnalysisConfig } from '@circuit-forge/eda-core';
import type { DesignRunSim } from '@circuitforge/llm-core';
import { config } from '../config';
import { runSimulation } from '../simulation/runner';
import { runMonteCarloBatch } from '../simulation/montecarlo-runner';
import { ngspiceSem } from './pools';

/** A finished local run, shaped to answer the loop's getStatus + getResult from memory. */
interface StoredOutcome {
    /** SUCCEEDED | FAILED | TIMED_OUT — the loop branches on this exactly as on a queue job's status. */
    status: string;
    /** What getStatus returns as `.metrics` (pointsCount / failureClass / convergence). */
    statusMetrics: Record<string, unknown>;
    /** The full object getResult returns: { result: SimulationResult, metrics: {pointsCount}, error? }. */
    resultPayload: Record<string, unknown>;
}

export function makeLocalSim(): DesignRunSim {
    const store = new Map<string, StoredOutcome>();
    let counter = 0;
    const nextId = (kind: string) => `local-${++counter}-${kind}`;

    return {
        async createQuickSim(netlist, analysisConfig, _userId) {
            const jobId = nextId('sim');
            // Mirror the API's enqueue default ('tran' when the analysis carries no type).
            const analysisType = (analysisConfig as { type?: string } | undefined)?.type || 'tran';
            // probeNames=[] → runner derives them from the netlist (identical to the API's createQuickSim).
            // Acquire one process-global ngspice permit so concurrent candidates/jobs can't oversubscribe CPU.
            const r = await ngspiceSem.run(() => runSimulation({ jobId, netlist, probeNames: [], analysisType }));

            if (r.success && r.result) {
                const pointsCount = r.result.meta.pointsCount;
                // Bound the stored series to WORKER_MAX_POINTS, exactly like the queue processor's
                // handleSuccess, so a long transient can't bloat the persisted DesignJob.result.
                const bounded = downsampleResult(r.result, config.WORKER_MAX_POINTS);
                store.set(jobId, {
                    status: 'SUCCEEDED',
                    statusMetrics: {
                        pointsCount,
                        runtimeMs: r.runtimeMs,
                        ...(r.convergence ? { convergence: r.convergence } : {}),
                    },
                    resultPayload: { status: 'SUCCEEDED', result: bounded, metrics: { pointsCount } },
                });
            } else {
                // Same classification as handleFailure: a genuine wall-clock timeout is TIMED_OUT; an infra
                // failure (ngspice never launched / fs error) is FAILED + failureClass:'infra' (→ the loop
                // reports "inconclusive", never a design failure); any other ngspice fault is FAILED + 'sim'.
                const status = !r.infra && r.error?.includes('timed out') ? 'TIMED_OUT' : 'FAILED';
                store.set(jobId, {
                    status,
                    statusMetrics: {
                        failureClass: r.infra ? 'infra' : 'sim',
                        ...(r.convergence ? { convergence: r.convergence } : {}),
                    },
                    resultPayload: { status, error: r.error },
                });
            }
            return { jobId };
        },

        async getStatus(jobId, _userId) {
            const o = store.get(jobId);
            // A missing entry would only happen on a programming error; treat it as infra so the loop stays
            // honest ("inconclusive") rather than silently passing.
            if (!o) return { status: 'FAILED', metrics: { failureClass: 'infra' } };
            return { status: o.status, metrics: o.statusMetrics };
        },

        async getResult(jobId, _userId) {
            return store.get(jobId)?.resultPayload ?? { status: 'FAILED', error: 'result unavailable' };
        },

        async createMonteCarloJob(circuit, analysisConfig, criteria, opts, _userId) {
            const jobId = nextId('mc');
            try {
                // runMonteCarloBatch regenerates a netlist per variant from `circuit` and never throws on a
                // sim fault (a dead corner is counted errored). The catch below is a defensive net only.
                // One ngspice permit for the whole batch — it spawns variants SERIALLY, so it uses ≤1 ngspice
                // at a time; holding one permit for the batch correctly reflects that against the global cap.
                const s = await ngspiceSem.run(() => runMonteCarloBatch({
                    jobId,
                    circuit,
                    analysis: (analysisConfig ?? {}) as unknown as AnalysisConfig,
                    criteria,
                    ...(opts.n ? { n: opts.n } : {}),
                    ...(opts.seed ? { seed: opts.seed } : {}),
                }));
                store.set(jobId, {
                    status: 'SUCCEEDED',
                    statusMetrics: {
                        monteCarlo: {
                            yield: s.yield,
                            ci95: s.ci95,
                            total: s.total,
                            evaluated: s.evaluated,
                            passed: s.passed,
                            failed: s.failed,
                            errored: s.errored,
                            ran: s.ran,
                            stoppedEarly: s.stoppedEarly,
                            budgetHit: s.budgetHit,
                        },
                    },
                    resultPayload: { status: 'SUCCEEDED' },
                });
            } catch (e) {
                store.set(jobId, {
                    status: 'FAILED',
                    statusMetrics: { failureClass: 'infra' },
                    resultPayload: { status: 'FAILED', error: e instanceof Error ? e.message : String(e) },
                });
            }
            return { jobId };
        },
    };
}
