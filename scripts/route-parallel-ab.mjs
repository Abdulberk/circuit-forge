/**
 * A/B: sequential (routeConcurrency=1) vs wave-parallel (routeConcurrency=K) quality routing, end-to-end
 * through layoutCircuit. Uses ASYNC docker runners (execFile, non-blocking) so Promise.all actually
 * overlaps freerouting+DRC across margins — the harness's default runners are execFileSync (blocking) and
 * would mask the effect. Verifies the two configs produce the SAME board (parallelism must not change the
 * result). Warms the docker/kicad caches first so the one-time cold-start doesn't skew the sequential run.
 *
 * Run: node scripts/route-parallel-ab.mjs [caseName] [K]     (defaults: shift-register 4)
 */
import { mkdirSync } from 'node:fs';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { galleryCases } from './lib/gallery-circuits.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..', 'packages', 'pcb-core');
const outRoot = join(pkgRoot, '.route-parallel-ab');
const { layoutCircuit } = await import(new URL(`file://${join(pkgRoot, 'dist', 'index.js').replace(/\\/g, '/')}`).href);
mkdirSync(outRoot, { recursive: true });

const FR_IMAGE = 'ghcr.io/freerouting/freerouting:2.2.4';
const KI_IMAGE = 'kicad/kicad:10.0-full';
const MAXBUF = 64 * 1024 * 1024;

// ---- async (non-blocking) docker runners, same invocations as scripts/lib/*.mjs ----
const meter = { fr: { n: 0, ms: 0 }, drc: { n: 0, ms: 0 } };
async function freeroute(dsn) {
    const dir = mkdtempSync(join(outRoot, 'fr-'));
    const t = performance.now();
    try {
        writeFileSync(join(dir, 'board.dsn'), dsn);
        const mount = `${dir.replaceAll('\\', '/')}:/work`;
        await execFileAsync('docker', ['run', '--rm', '-v', mount, '--entrypoint', 'java', FR_IMAGE,
            '-jar', '/app/freerouting-executable.jar', '--gui.enabled=false', '-de', '/work/board.dsn', '-do', '/work/board.ses', '-mp', '30'],
            { timeout: 300_000, maxBuffer: MAXBUF, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
        const ses = readFileSync(join(dir, 'board.ses'), 'utf8');
        if (!ses.includes('(session')) throw new Error('no SES session');
        return ses;
    } finally { meter.fr.n++; meter.fr.ms += performance.now() - t; rmSync(dir, { recursive: true, force: true }); }
}
async function notaryDrc(kicadPcb, kicadPro) {
    const dir = mkdtempSync(join(outRoot, 'drc-'));
    const t = performance.now();
    try {
        writeFileSync(join(dir, 'b.kicad_pcb'), kicadPcb);
        writeFileSync(join(dir, 'b.kicad_pro'), kicadPro);
        const mount = `${dir.replaceAll('\\', '/')}:/work`;
        try {
            await execFileAsync('docker', ['run', '--rm', '-v', mount, KI_IMAGE, 'kicad-cli', 'pcb', 'drc',
                '--refill-zones', '--exit-code-violations', '--severity-error', '--format', 'json', '--output', '/work/d.json', '/work/b.kicad_pcb'],
                { timeout: 300_000, maxBuffer: MAXBUF, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
            return true;
        } catch (e) {
            if (e.code === 5) return false;
            throw e;
        }
    } finally { meter.drc.n++; meter.drc.ms += performance.now() - t; rmSync(dir, { recursive: true, force: true }); }
}

const caseName = process.argv[2] ?? 'shift-register';
const K = Number(process.argv[3] ?? 4);
const [, circuit] = galleryCases.find(([n]) => n === caseName);

function summary(r) {
    const board = r.evaluated.find((e) => e.type === 'pcb_board');
    const drcMsg = r.diagnostics.filter((d) => d.code === 'PCB030').pop()?.message ?? '';
    return { ok: r.ok, vias: r.stats.vias, traces: r.stats.traces,
        board: board ? `${board.width}x${board.height}` : '?', drcClean: /DRC-clean confirmed/i.test(drcMsg) };
}
async function run(label, routeConcurrency) {
    meter.fr = { n: 0, ms: 0 }; meter.drc = { n: 0, ms: 0 };
    const t = performance.now();
    const r = await layoutCircuit(circuit, { router: 'quality', freeroute, notaryDrc, placer: 'auto', routeConcurrency });
    const s = (performance.now() - t) / 1000;
    const sum = summary(r);
    console.log(`${label.padEnd(18)} total=${s.toFixed(0)}s  freeroute=${meter.fr.n}×(${(meter.fr.ms / 1000).toFixed(0)}s)  drc=${meter.drc.n}×(${(meter.drc.ms / 1000).toFixed(0)}s)  ok=${sum.ok} DRC=${sum.drcClean ? '✔' : '✗'} board=${sum.board} vias=${sum.vias} traces=${sum.traces}`);
    return { s, sum };
}

console.log(`\n=== ${caseName} (${circuit.components.length} comp) — sequential vs wave-parallel(K=${K}) ===`);
console.log('warming docker/kicad image caches (one throwaway layout)...');
await layoutCircuit(circuit, { router: 'quality', freeroute, notaryDrc, placer: 'auto', routeConcurrency: 1 });
const seq = await run('sequential K=1', 1);
const par = await run(`parallel K=${K}`, K);

const sameBoard = JSON.stringify(seq.sum) === JSON.stringify(par.sum);
console.log(`\n── result ──`);
console.log(`  wall-time: ${seq.s.toFixed(0)}s → ${par.s.toFixed(0)}s   (${(seq.s / par.s).toFixed(2)}× faster, ${(100 * (1 - par.s / seq.s)).toFixed(0)}% shorter)`);
console.log(`  identical board (determinism/quality preserved): ${sameBoard ? 'YES ✔' : 'NO ✗ — ' + JSON.stringify({ seq: seq.sum, par: par.sum })}`);
process.exit(sameBoard ? 0 : 1);
