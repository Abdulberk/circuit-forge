/**
 * Diagnostic: where does a single layoutCircuit's wall time actually go? Wraps the freeroute + DRC
 * runners with per-call timers/counters so we can see whether the cost is MANY sequential routing
 * attempts (→ parallelizable) or ONE slow route (→ a freerouting-version/quality problem). No product
 * code changed — pure observation.
 *
 * Run: node scripts/route-profile.mjs [caseName]   (default: shift-register)
 */
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { makeFreeroutingRunner } from './lib/freerouting.mjs';
import { makeKicadDrcRunner } from './lib/kicad-drc.mjs';
import { galleryCases } from './lib/gallery-circuits.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..', 'packages', 'pcb-core');
const outRoot = join(pkgRoot, '.route-profile');
const { layoutCircuit } = await import(new URL(`file://${join(pkgRoot, 'dist', 'index.js').replace(/\\/g, '/')}`).href);
mkdirSync(outRoot, { recursive: true });

const caseName = process.argv[2] ?? 'shift-register';
const entry = galleryCases.find(([n]) => n === caseName);
if (!entry) {
    console.error(`no case ${caseName}; have: ${galleryCases.map(([n]) => n).join(', ')}`);
    process.exit(2);
}
const [, circuit] = entry;

const rawFree = makeFreeroutingRunner({ workDir: outRoot });
const rawDrc = makeKicadDrcRunner({ workDir: outRoot });

const events = [];
let frSeq = 0,
    drcSeq = 0;
const freeroute = async (dsn) => {
    const seq = ++frSeq;
    const t = performance.now();
    try {
        const r = await rawFree(dsn);
        events.push({ kind: 'freeroute', seq, ms: performance.now() - t, ok: true });
        return r;
    } catch (e) {
        events.push({ kind: 'freeroute', seq, ms: performance.now() - t, ok: false, err: String(e).slice(0, 80) });
        throw e;
    }
};
const notaryDrc = async (pcb, proj) => {
    const seq = ++drcSeq;
    const t = performance.now();
    const clean = await rawDrc(pcb, proj);
    events.push({ kind: 'drc', seq, ms: performance.now() - t, clean });
    return clean;
};

console.log(`profiling ${caseName} (${circuit.components.length} components) — full quality layout...`);
const t0 = performance.now();
const r = await layoutCircuit(circuit, { router: 'quality', freeroute, notaryDrc, placer: 'auto' });
const totalS = (performance.now() - t0) / 1000;

let frTotal = 0,
    drcTotal = 0;
for (const e of events) {
    if (e.kind === 'freeroute') frTotal += e.ms;
    else drcTotal += e.ms;
    console.log(
        `  ${e.kind.padEnd(9)} #${e.seq}  ${(e.ms / 1000).toFixed(1)}s  ${e.kind === 'freeroute' ? (e.ok ? 'ok' : 'FAIL ' + e.err) : e.clean ? 'DRC ✔' : 'DRC ✗'}`,
    );
}
console.log(`\n── totals ──`);
console.log(
    `  freeroute calls: ${frSeq}  (${(frTotal / 1000).toFixed(1)}s, ${((100 * frTotal) / (totalS * 1000)).toFixed(0)}% of total)`,
);
console.log(
    `  drc calls:       ${drcSeq}  (${(drcTotal / 1000).toFixed(1)}s, ${((100 * drcTotal) / (totalS * 1000)).toFixed(0)}% of total)`,
);
console.log(`  layoutCircuit total: ${totalS.toFixed(1)}s   ok=${r.ok}`);
console.log(
    `  DIAGNOSIS: ${frSeq > 2 ? `${frSeq} sequential routing attempts → PARALLELIZABLE (wall-time could drop to ~1-2 runs)` : `only ${frSeq} routing attempt(s) → NOT a parallelism problem; slow single run points at freerouting version/quality`}`,
);
