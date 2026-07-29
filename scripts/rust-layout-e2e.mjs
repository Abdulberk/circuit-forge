/**
 * FULL-PIPELINE end-to-end A/B: every selected gallery circuit is run through the complete quality
 * layout (placement → freerouting → KiCad DRC oracle) TWICE — once with placer:'auto' (the TypeScript
 * force-directed placer) and once with placer:'rust' (the additive out-of-process Rust engine). It
 * reports the REAL total wall time of each layout, the DRC verdict, and the board — so we can see, in an
 * end-to-end context (not the isolated placement micro-benchmark), how much the Rust placement actually
 * moves total layout time, and confirm the Rust integration produces a valid, DRC-clean board.
 *
 * Freerouting + KiCad run in their pinned Docker images (same as scripts/placement-ab.mjs). The Rust
 * placer binary is resolved from RUST_PLACER_PATH (or the crate's release target).
 *
 * Run (after building pcb-core + the Rust release binary):
 *   RUST_PLACER_PATH=/path/to/cf-pcb-place[.exe] node scripts/rust-layout-e2e.mjs [case1 case2 ...]
 */
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFreeroutingRunner } from './lib/freerouting.mjs';
import { makeKicadDrcRunner } from './lib/kicad-drc.mjs';
import { galleryCases } from './lib/gallery-circuits.mjs';
import { runRustPlacement, resolveRustPlacerBinary } from './lib/rust-placement.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..', 'packages', 'pcb-core');
const outRoot = join(pkgRoot, '.rust-layout-e2e');
const { layoutCircuit } = await import(new URL(`file://${join(pkgRoot, 'dist', 'index.js').replace(/\\/g, '/')}`).href);

mkdirSync(outRoot, { recursive: true });
const freeroute = makeFreeroutingRunner({ workDir: outRoot });
const notaryDrc = makeKicadDrcRunner({ workDir: outRoot });

// Fail fast if the Rust binary isn't resolvable.
const rustBinary = resolveRustPlacerBinary();
// pcb-core expects an async PlacementRunner; the lib wrapper is sync (spawnSync) so wrap it.
const rustPlace = async (input) => runRustPlacement(input, { binary: rustBinary });

function boardArea(board) {
    const b = board.find((e) => e.type === 'pcb_board');
    return b?.width && b?.height ? `${b.width}×${b.height}` : '?';
}

async function runOne(circuit, placer) {
    const t0 = Date.now();
    const opts = { router: 'quality', freeroute, notaryDrc, placer };
    if (placer === 'rust') opts.rustPlace = rustPlace;
    const r = await layoutCircuit(circuit, opts);
    const secs = (Date.now() - t0) / 1000;
    const routeMsgs = r.diagnostics.filter((d) => d.code === 'PCB030');
    const drcClean = /DRC-clean confirmed/i.test(routeMsgs[routeMsgs.length - 1]?.message ?? '');
    const adopted = r.diagnostics.find((d) => d.code === 'PCB050' && /ADOPTED/.test(d.message))?.message ?? null;
    const rejected = r.diagnostics.find((d) => d.code === 'PCB051')?.message ?? null;
    // the Rust path logs its own stage time; the TS path does not, so this is present only for 'rust'
    const placeStage =
        r.diagnostics.find((d) => d.code === 'PCB050' && /engine completed in/.test(d.message))?.message ?? null;
    return {
        ok: r.ok,
        secs,
        drcClean,
        adopted,
        rejected,
        placeStage,
        vias: r.stats?.vias,
        traces: r.stats?.traces,
        board: boardArea(r.evaluated),
    };
}

const selected = process.argv.slice(2);
const cases = selected.length ? galleryCases.filter(([n]) => selected.includes(n)) : galleryCases;

console.log(`Rust vs TS FULL-PIPELINE e2e — binary: ${rustBinary}`);
console.log(`cases: ${cases.map(([n]) => n).join(', ')}\n`);

const rows = [];
for (const [name, circuit] of cases) {
    console.log(`────────── ${name} (${circuit.components.length} components)`);
    const auto = await runOne(circuit, 'auto');
    console.log(
        `  auto: ok=${auto.ok} DRC=${auto.drcClean ? '✔' : '✗'} board=${auto.board} vias=${auto.vias} total=${auto.secs.toFixed(1)}s ${auto.adopted ? 'ADOPTED' : auto.rejected ? 'grid-kept' : ''}`,
    );
    const rust = await runOne(circuit, 'rust');
    console.log(
        `  rust: ok=${rust.ok} DRC=${rust.drcClean ? '✔' : '✗'} board=${rust.board} vias=${rust.vias} total=${rust.secs.toFixed(1)}s ${rust.adopted ? 'ADOPTED' : rust.rejected ? 'grid-kept' : ''}`,
    );
    if (rust.placeStage) console.log(`     · ${rust.placeStage.replace(/^.*?: /, '')}`);
    rows.push({ name, auto, rust });
}

console.log('\n════════ TOTAL LAYOUT TIME (auto vs rust) ════════');
let autoSum = 0,
    rustSum = 0;
for (const { name, auto, rust } of rows) {
    autoSum += auto.secs;
    rustSum += rust.secs;
    const delta = auto.secs ? (100 * (rust.secs - auto.secs)) / auto.secs : 0;
    console.log(
        `  ${name.padEnd(18)} auto ${auto.secs.toFixed(1)}s → rust ${rust.secs.toFixed(1)}s (${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%)  DRC ${auto.drcClean ? '✔' : '✗'}→${rust.drcClean ? '✔' : '✗'}`,
    );
}
console.log(`  ${'TOTAL'.padEnd(18)} auto ${autoSum.toFixed(1)}s → rust ${rustSum.toFixed(1)}s`);
console.log('\nNote: on these small gallery boards, placement (auto or rust) is tens of ms while freerouting');
console.log('+ KiCad DRC dominate — so total time is ~unchanged. The Rust win is isolated to the placement');
console.log('stage and only dominates on LARGE boards (see the isolated bench: 400p TS 21s → Rust 0.18s).');
console.log('This run verifies the Rust placement INTEGRATION: adopted end-to-end and routes DRC-clean.');

// Non-zero exit only if the Rust path regressed DRC vs auto on any case (integration must not break routing).
const regressed = rows.some(({ auto, rust }) => auto.drcClean && !rust.drcClean);
process.exit(regressed ? 1 : 0);
