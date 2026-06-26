// Measure REAL ngspice CPU/wall per sim + per Monte-Carlo batch, to anchor the cost model's compute side.
// (Requests/design is derived from loop logic, not measured — it's deterministic + costs LLM requests.)
// Run from apps/worker-sim: node scripts/cost-measure.mjs
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env') });

const { runSimulation } = await import('../dist/simulation/runner.js');
const { runMonteCarloBatch } = await import('../dist/simulation/montecarlo-runner.js');
const { generateNetlist } = await import('../../../packages/eda-core/dist/index.js');

const DIVIDER = (tol) => ({
  version: '1.0',
  components: [
    { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 10', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
    { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', ...(tol ? { tolerance: tol } : {}), pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
    { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', ...(tol ? { tolerance: tol } : {}), pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
    { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
  ],
  nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: 'gnd', name: 'gnd', isGround: true }],
});
const RC = {
  version: '1.0',
  components: [
    { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 1 1k)', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
    { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
    { id: 'c1', type: 'capacitor', designator: 'C1', value: '100n', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
    { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
  ],
  nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: 'gnd', name: 'gnd', isGround: true }],
};
const uid = (k) => `cost-${k}-${process.hrtime.bigint()}`;

const RC_AC = { ...RC, components: RC.components.map((c) => c.id === 'v1' ? { ...c, value: 'AC 1' } : c) };
async function timeSim(label, circuit, analysis) {
  try {
    const netlist = generateNetlist(circuit, analysis);
    const r = await runSimulation({ jobId: uid(label), netlist, probeNames: [], analysisType: analysis.type });
    console.log(`  ${label}: success=${r.success} runtimeMs=${r.runtimeMs} points=${r.result?.meta?.pointsCount ?? '-'}`);
  } catch (e) { console.log(`  ${label}: ERR ${e.message.slice(0, 70)}`); }
}

async function timeMC(label, n) {
  const t0 = Date.now();
  const s = await runMonteCarloBatch({ jobId: uid('mc'), circuit: DIVIDER(0.05), analysis: { type: 'op' }, criteria: [{ probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.5 }], n });
  const wall = Date.now() - t0;
  console.log(`  MC n=${n}: ran=${s.ran} evaluated=${s.evaluated} budgetHit=${s.budgetHit} stoppedEarly=${s.stoppedEarly} runtimeMs=${s.runtimeMs} wall=${wall}ms  → per-variant≈${(s.runtimeMs / Math.max(1, s.ran)).toFixed(0)}ms`);
  return s;
}

async function main() {
  console.log(`ngspice: ${process.env.NGSPICE_PATH}\n=== single sims (ngspice CPU/wall) ===`);
  await timeSim('op (divider)', DIVIDER(), { type: 'op' });
  await timeSim('op (divider) #2', DIVIDER(), { type: 'op' });
  await timeSim('tran RC 5ms/10us', RC, { type: 'tran', stepTime: '10u', stopTime: '5m' });
  await timeSim('ac dec (RC)', RC_AC, { type: 'ac', variation: 'dec', points: 20, startFreq: '10', stopFreq: '1meg' });
  console.log(`\n=== Monte-Carlo batches (the dominant per-design CPU when MC is on) ===`);
  await timeMC('mc', 50);
  await timeMC('mc', 100);
  await timeMC('mc', 300); // expect adaptive-N / 60s budget to cap it
  process.exit(0);
}
main().catch((e) => { console.error('measure crashed:', e); process.exit(1); });
