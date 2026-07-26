/**
 * Solver `.options` helpers — the single source of truth for turning the typed SolverOptions levers
 * into validated SPICE `.options` tokens, and for merging a set of solver options into an ALREADY
 * generated netlist string.
 *
 * `applySolverOptions` exists so the WORKER can run the Convergence Doctor's remedy ladder locally:
 * the worker only has the netlist string (not the CircuitJson), so a remedy = re-emit the netlist with
 * the remedy's solver options merged into its `.options` card, then re-run ngspice. The token formatting
 * + anchored numeric validation is shared with the generator (generator.ts), so a remedy can never emit
 * a token the generator wouldn't (and an unvalidated value can never reach a netlist line).
 */
import type { SolverOptions } from '../types/analysis';

/** Anchored SPICE numeric pattern — a value that fails this is DROPPED (an unvalidated token on a
 *  netlist line would be injection). Mirrors the generator's guard exactly. */
const SPICE_NUM = /^\+?\d*\.?\d+(?:[eE][+-]?\d+)?(?:meg|MEG|[fpnumkgtFPNUMKGT])?$/;

/**
 * Turn typed SolverOptions into the `key=value` tokens the `.options` card carries. Invalid numeric
 * values are silently dropped (ngspice defaults apply). Shared by the generator and applySolverOptions
 * so there is exactly one place that decides what a solver option looks like on a netlist line.
 */
export function solverOptionTokens(options: SolverOptions | undefined): string[] {
    const tokens: string[] = [];
    if (!options) return tokens;
    for (const key of ['reltol', 'abstol', 'vntol', 'gmin'] as const) {
        const v = options[key]?.trim();
        if (v && SPICE_NUM.test(v)) tokens.push(`${key}=${v}`);
    }
    if (options.method === 'trap' || options.method === 'gear') tokens.push(`method=${options.method}`);
    if (
        typeof options.itl4 === 'number' &&
        Number.isInteger(options.itl4) &&
        options.itl4 > 0 &&
        options.itl4 <= 10000
    ) {
        tokens.push(`itl4=${options.itl4}`);
    }
    return tokens;
}

/** The `* Options` comment the generator emits above its `.options` card (kept consistent on insert). */
const OPTIONS_COMMENT = '* Options';

/**
 * Merge `options` into an existing netlist's `.options` card and return the new netlist. Used worker-side
 * to apply a convergence remedy without the CircuitJson. Behaviour:
 *   - No emittable tokens → the netlist is returned UNCHANGED.
 *   - An existing `.options` line → the remedy tokens are merged into it (remedy wins on a shared key;
 *     flags like `savecurrents` and non-overridden tokens are preserved; any extra `.options` lines are
 *     folded into the first so there is one canonical card).
 *   - No `.options` line → a new one is inserted just before the analysis card (`.tran`/`.ac`/`.dc`/`.op`),
 *     falling back to before `.control`, then `.end`. `.options` is a global dot-card collected during the
 *     parse pass, so position only needs to be inside the deck and after any original card it overrides.
 * Line endings are normalized to `\n` (the netlist is rewritten to disk fresh; ngspice is `\n`-tolerant).
 */
export function applySolverOptions(netlist: string, options: SolverOptions): string {
    const remedyTokens = solverOptionTokens(options);
    if (remedyTokens.length === 0) return netlist;
    const remedyKeys = new Set(remedyTokens.map((t) => t.split('=')[0]!.toLowerCase()));

    const lines = netlist.split(/\r?\n/);
    const optionIdxs: number[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*\.options\b/i.test(lines[i]!)) optionIdxs.push(i);
    }

    if (optionIdxs.length > 0) {
        // Fold every existing `.options` token (across all such lines) that the remedy does NOT override
        // into one canonical card, de-duplicating by key, then append the remedy tokens (so they win).
        const kept: string[] = [];
        const seenKeys = new Set<string>();
        for (const idx of optionIdxs) {
            const toks = lines[idx]!.trim()
                .replace(/^\.options\s*/i, '')
                .split(/\s+/)
                .filter(Boolean);
            for (const tok of toks) {
                const key = tok.split('=')[0]!.toLowerCase();
                if (remedyKeys.has(key) || seenKeys.has(key)) continue;
                seenKeys.add(key);
                kept.push(tok);
            }
        }
        lines[optionIdxs[0]!] = `.options ${[...kept, ...remedyTokens].join(' ')}`;
        // Drop the now-merged extra `.options` lines (back-to-front so indices stay valid).
        for (let j = optionIdxs.length - 1; j >= 1; j--) lines.splice(optionIdxs[j]!, 1);
        return lines.join('\n');
    }

    // No existing card — insert before the most appropriate anchor.
    const anchorOf = (re: RegExp) => lines.findIndex((l) => re.test(l));
    let at = anchorOf(/^\s*\.(tran|ac|dc|op)\b/i);
    if (at < 0) at = anchorOf(/^\s*\.control\b/i);
    if (at < 0) at = anchorOf(/^\s*\.end\b/i);
    const card = `.options ${remedyTokens.join(' ')}`;
    if (at < 0) {
        lines.push(card);
    } else {
        lines.splice(at, 0, OPTIONS_COMMENT, card, '');
    }
    return lines.join('\n');
}
