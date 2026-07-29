/**
 * Lever-2 A/B measurement — the REAL test the plan gates on (PLACEMENT_PLAN.md §8):
 * every gallery circuit is run TWICE through the full quality pipeline (freerouting + Lever-1
 * DRC-oracle), once with placer:'grid' (baseline) and once with placer:'auto', and the honest
 * metrics are tabulated: vias, trace count, total copper length, board area, DRC verdict, HPWL
 * decision. No mock, no cherry-picking — aggregate wins or the feature doesn't ship.
 *
 * Run: pnpm --filter @circuit-forge/pcb-core build && node scripts/placement-ab.mjs
 */
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFreeroutingRunner } from './lib/freerouting.mjs';
import { makeKicadDrcRunner } from './lib/kicad-drc.mjs';
import { galleryCases } from './lib/gallery-circuits.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..', 'packages', 'pcb-core');
const outRoot = join(pkgRoot, '.placement-ab');
const { layoutCircuit } = await import(new URL(`file://${join(pkgRoot, 'dist', 'index.js').replace(/\\/g, '/')}`).href);

mkdirSync(outRoot, { recursive: true });
const freeroute = makeFreeroutingRunner({ workDir: outRoot });
const notaryDrc = makeKicadDrcRunner({ workDir: outRoot });

/** Total routed copper length (mm) from the evaluated board's pcb_trace routes. */
function copperLengthMm(board) {
    let sum = 0;
    for (const t of board.filter((e) => e.type === 'pcb_trace')) {
        const r = t.route ?? [];
        for (let i = 1; i < r.length; i++) {
            const dx = (r[i].x ?? 0) - (r[i - 1].x ?? 0);
            const dy = (r[i].y ?? 0) - (r[i - 1].y ?? 0);
            sum += Math.sqrt(dx * dx + dy * dy);
        }
    }
    return sum;
}

function boardArea(board) {
    const b = board.find((e) => e.type === 'pcb_board');
    return b?.width && b?.height ? { w: b.width, h: b.height, mm2: b.width * b.height } : null;
}

async function runOne(name, circuit, placer) {
    const t0 = Date.now();
    const r = await layoutCircuit(circuit, { router: 'quality', freeroute, notaryDrc, placer });
    // LAST PCB030 = the final route (an auto attempt that got reverted emits an earlier PCB030 too)
    const routeMsgs = r.diagnostics.filter((d) => d.code === 'PCB030');
    const routeMsg = routeMsgs[routeMsgs.length - 1]?.message ?? '';
    const drcClean = /DRC-clean confirmed/i.test(routeMsg);
    const adopted = r.diagnostics.find((d) => d.code === 'PCB050' && /ADOPTED/.test(d.message))?.message;
    const rejected = r.diagnostics.find((d) => d.code === 'PCB051')?.message;
    return {
        ok: r.ok,
        vias: r.stats.vias,
        traces: r.stats.traces,
        lenMm: copperLengthMm(r.evaluated),
        area: boardArea(r.evaluated),
        drcClean,
        adopted: adopted ?? null,
        rejected: rejected ?? null,
        secs: (Date.now() - t0) / 1000,
    };
}

const rows = [];
for (const [name, circuit] of galleryCases) {
    console.log(`\n────────── ${name}`);
    const grid = await runOne(name, circuit, 'grid');
    console.log(
        `  grid: ok=${grid.ok} vias=${grid.vias} traces=${grid.traces} len=${grid.lenMm.toFixed(0)}mm board=${grid.area?.w}×${grid.area?.h} DRC=${grid.drcClean ? '✔' : '✗'} (${grid.secs.toFixed(0)}s)`,
    );
    const auto = await runOne(name, circuit, 'auto');
    console.log(
        `  auto: ok=${auto.ok} vias=${auto.vias} traces=${auto.traces} len=${auto.lenMm.toFixed(0)}mm board=${auto.area?.w}×${auto.area?.h} DRC=${auto.drcClean ? '✔' : '✗'} (${auto.secs.toFixed(0)}s)`,
    );
    if (auto.adopted) console.log(`  · ${auto.adopted}`);
    if (auto.rejected) console.log(`  · ${auto.rejected}`);
    rows.push({ name, grid, auto });
}

// ---------------------------------------------------------------- aggregate verdict

console.log('\n════════════════ A/B TABLE (grid → auto) ════════════════');
let gVias = 0,
    aVias = 0,
    gLen = 0,
    aLen = 0,
    gArea = 0,
    aArea = 0,
    gClean = 0,
    aClean = 0,
    adoptedCount = 0;
for (const { name, grid, auto } of rows) {
    gVias += grid.vias;
    aVias += auto.vias;
    gLen += grid.lenMm;
    aLen += auto.lenMm;
    gArea += grid.area?.mm2 ?? 0;
    aArea += auto.area?.mm2 ?? 0;
    gClean += grid.drcClean ? 1 : 0;
    aClean += auto.drcClean ? 1 : 0;
    adoptedCount += auto.adopted ? 1 : 0;
    const dv = grid.vias ? (100 * (auto.vias - grid.vias)) / grid.vias : 0;
    const dl = grid.lenMm ? (100 * (auto.lenMm - grid.lenMm)) / grid.lenMm : 0;
    console.log(
        `  ${name.padEnd(17)} vias ${String(grid.vias).padStart(2)}→${String(auto.vias).padEnd(3)} (${dv >= 0 ? '+' : ''}${dv.toFixed(0)}%)` +
            ` len ${grid.lenMm.toFixed(0).padStart(4)}→${auto.lenMm.toFixed(0).padEnd(4)}mm (${dl >= 0 ? '+' : ''}${dl.toFixed(0)}%)` +
            ` board ${grid.area?.mm2 ?? '?'}→${auto.area?.mm2 ?? '?'}mm² DRC ${grid.drcClean ? '✔' : '✗'}→${auto.drcClean ? '✔' : '✗'}` +
            ` ${auto.adopted ? 'AUTO' : 'grid-kept'}`,
    );
}
const pct = (a, b) => (b ? ((100 * (a - b)) / b).toFixed(1) : '0');
console.log('\n──────── AGGREGATE ────────');
console.log(`  adopted:        ${adoptedCount}/${rows.length}`);
console.log(`  vias:           ${gVias} → ${aVias}  (${pct(aVias, gVias)}%)`);
console.log(`  copper length:  ${gLen.toFixed(0)} → ${aLen.toFixed(0)} mm  (${pct(aLen, gLen)}%)`);
console.log(`  board area:     ${gArea.toFixed(0)} → ${aArea.toFixed(0)} mm²  (${pct(aArea, gArea)}%)`);
console.log(`  DRC-clean:      ${gClean}/${rows.length} → ${aClean}/${rows.length}`);
console.log('\nGates (plan §2): vias ≤ -30%, len ≤ -20%, DRC-clean must not regress.');
process.exit(aClean < gClean ? 1 : 0);
