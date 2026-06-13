// Live ngspice proof of the WORKER-side Convergence Doctor (slice 2).
//   node scripts/convergence-worker-live.mjs
//
// Drives the REAL worker runSimulation() (apps/worker-sim/dist) against the REAL ngspice binary —
// no mocks — to prove, end to end:
//   P1  happy path: a sound circuit runs in ONE attempt, no convergence report (refactor intact).
//   P2  a GENUINE ngspice convergence failure ("Timestep too small") is detected from ngspice's -o log,
//       the full solver-remedy ladder is walked locally (real re-runs), and — when the failure is a true
//       discontinuity no lever can fix — it is reported HONESTLY as recovered:false with the diagnosis +
//       every remedy tried. (ngspice-41 is robust enough that a naturally-recoverable numeric failure was
//       not reproducible deterministically on this box; P3 closes the loop on the recovery half.)
//   P3  a remedied deck (applySolverOptions output) is VALID ngspice and runs clean — so a recovery (a
//       remedy attempt returning success) is the same proven success path P1 exercises.
//
// config.ts auto-loads the monorepo root .env (NGSPICE_PATH etc.); SIM_SANDBOX auto-resolves to 'none'
// off Linux. Requires: pnpm --filter @circuit-forge/eda-core build && pnpm --filter @circuitforge/worker-sim build.
import { generateNetlist } from '../packages/eda-core/dist/index.js';
import { applySolverOptions } from '../packages/eda-core/dist/index.js';

const runnerMod = await import('../apps/worker-sim/dist/simulation/runner.js');
const runSimulation = runnerMod.runSimulation ?? runnerMod.default?.runSimulation;

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗ FAIL:'} ${msg}`); if (!cond) failures++; };
const uid = () => `live-${Math.random().toString(36).slice(2)}-${process.hrtime.bigint()}`;

// A sound 10V/1k/1k divider (out = 5V) — converges in one shot.
const DIVIDER = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 10', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: 'gnd', name: 'gnd', isGround: true }],
};

// A hard-comparator relaxation oscillator: an ideal discontinuity at node d. Its transient operating
// point genuinely can't be tracked at any tolerance — ngspice aborts with "Timestep too small". A real,
// repeatable convergence-class failure the ladder must detect, walk, and then honestly give up on.
const HARD_OSC = `* hard-comparator relaxation oscillator (genuine timestep collapse)
V1 vcc 0 5
B1 d 0 V=(v(c) > 2.5) ? 0.2 : 4.8
R1 d c 50
C1 c 0 2n ic=0
.tran 2n 50u uic
.control
set filetype=ascii
run
wrdata output.csv v(c)
.endc
.end
`;

async function main() {
    console.log(`ngspice: ${process.env.NGSPICE_PATH}`);

    console.log('\nP1 — happy path (sound divider, op): one attempt, no remedy ladder');
    const goodNetlist = generateNetlist(DIVIDER, { type: 'op' });
    const r1 = await runSimulation({ jobId: uid(), netlist: goodNetlist, probeNames: [], analysisType: 'op' });
    ok(r1.success === true, `runs successfully (success=${r1.success}${r1.error ? `, error=${r1.error}` : ''})`);
    ok(r1.convergence === undefined, 'no convergence report on a clean run (ladder never engaged)');

    console.log('\nP2 — genuine "Timestep too small": detected, full ladder walked, honest non-recovery');
    const r2 = await runSimulation({ jobId: uid(), netlist: HARD_OSC, probeNames: [], analysisType: 'tran' });
    ok(r2.success === false, `the unsolvable oscillator fails (success=${r2.success})`);
    ok(!!r2.convergence, 'a convergence report was produced (the failure was diagnosed, not swallowed)');
    if (r2.convergence) {
        ok(r2.convergence.recovered === false, `honestly reports recovered=false (got ${r2.convergence.recovered})`);
        ok(r2.convergence.kind === 'timestep_collapse', `diagnosed kind=timestep_collapse (got ${r2.convergence.kind})`);
        ok(Array.isArray(r2.convergence.triedRemedies) && r2.convergence.triedRemedies.length === 3,
            `walked the full transient ladder — 3 remedies tried (got ${r2.convergence.triedRemedies?.length}: ${JSON.stringify(r2.convergence.triedRemedies)})`);
    }
    ok(/timestep too small/i.test(r2.error ?? '') || /timestep too small/i.test(r2.stderr ?? ''),
        'the real ngspice "Timestep too small" message was captured from the -o log (stderr fold works)');

    console.log('\nP3 — a remedied deck (applySolverOptions output) is valid ngspice and runs clean');
    const remedied = applySolverOptions(goodNetlist, { method: 'gear', itl4: 1000, reltol: '1e-2', gmin: '1e-9' });
    ok(/\.options\b/i.test(remedied) && /reltol=1e-2/.test(remedied) && /method=gear/.test(remedied),
        'applySolverOptions injected a .options card with the remedy tokens');
    const r3 = await runSimulation({ jobId: uid(), netlist: remedied, probeNames: [], analysisType: 'op' });
    ok(r3.success === true, `the remedied deck simulates successfully (success=${r3.success}${r3.error ? `, error=${r3.error}` : ''})`);

    console.log(`\n${failures === 0 ? 'ALL LIVE CHECKS PASSED' : `${failures} LIVE CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('live proof crashed:', e); process.exit(1); });
