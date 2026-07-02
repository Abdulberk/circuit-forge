/**
 * The @tscircuit/eval seam — the ONLY place the ESM-only evaluator is loaded (dynamic import; see
 * tsconfig note). Kept minimal so everything upstream (adapter) and downstream (parity/outputs)
 * stays pure and unit-testable without the ESM dependency.
 */
import type { TscElement } from './parity';

export async function evaluateTscircuit(code: string): Promise<TscElement[]> {
    const { runTscircuitCode } = await import('@tscircuit/eval');
    return (await runTscircuitCode(code)) as TscElement[];
}
