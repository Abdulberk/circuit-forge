/**
 * Shared job-dir lifecycle for the variant-batch runners (Monte-Carlo / sweep / corner). Each batch reuses ONE
 * ngspice job dir across all its variants; this centralizes the scaffold the three runners used to duplicate
 * verbatim — create the dir, (legacy two-user mode ONLY) loosen its perms so the dropped ngspice user can write,
 * write the shared model files once, build the per-variant runner, and GUARANTEE teardown in a `finally`.
 * Centralizing it keeps the sandbox-perms invariant in exactly one audited place so it can't drift between runners.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../config';
import type { AnalysisConfig } from '@circuit-forge/eda-core';
import { makeVariantRunner } from './variant-runner';

/** The per-variant ngspice runner shape (stale-CSV safety + OOM guard + THD/gain fold) — see variant-runner.ts. */
export type VariantRunner = ReturnType<typeof makeVariantRunner>;

/**
 * Run `fn` with a prepared, reused ngspice job dir and a per-variant runner bound to it, disposing the dir
 * afterward no matter what. `suffix` (mc/sweep/corner) distinguishes the concurrent batch kinds under SIM_TEMP_DIR.
 */
export async function withVariantJobDir<T>(
    jobId: string,
    suffix: string,
    analysis: AnalysisConfig,
    modelFiles: Array<{ name: string; content: Buffer }> | undefined,
    fn: (runVariant: VariantRunner, jobDir: string) => Promise<T>,
): Promise<T> {
    const jobDir = path.join(config.SIM_TEMP_DIR, `${jobId}-${suffix}`);

    await fs.mkdir(jobDir, { recursive: true });
    // Legacy two-user mode needs the dropped ngspice user to write here; single-uid keeps tight perms.
    if (config.SIM_SANDBOX_USER) await fs.chmod(jobDir, 0o777).catch(() => undefined);

    // Model files are identical across variants — write them once.
    if (modelFiles) {
        for (const m of modelFiles) await fs.writeFile(path.join(jobDir, m.name), m.content);
    }

    const runVariant = makeVariantRunner(jobDir, analysis);
    try {
        return await fn(runVariant, jobDir);
    } finally {
        await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
