/**
 * Gallery generator for apps/pcb-viewer — runs REAL, verified textbook circuits through the FULL
 * pcb-core pipeline (classify → adapter → tscircuit eval → freerouting quality route → Lever-1
 * DRC-oracle → injectModels 3D bodies → kicad-cli glb export) and drops the GLBs into the viewer's
 * public/ dir. No mock: every board is the genuine pipeline output, DRC status reported honestly.
 *
 * Run:  pnpm --filter @circuit-forge/pcb-core build && node scripts/gen-gallery.mjs
 * Needs Docker with kicad/kicad:10.0-full + ghcr.io/freerouting/freerouting:2.2.4.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeFreeroutingRunner } from './lib/freerouting.mjs';
import { makeKicadDrcRunner } from './lib/kicad-drc.mjs';
import { galleryCases } from './lib/gallery-circuits.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..', 'packages', 'pcb-core');
const outRoot = join(pkgRoot, '.gallery');
const publicDir = join(__dirname, '..', 'apps', 'pcb-viewer', 'public');
const { layoutCircuit, injectModels } = await import(
    new URL(`file://${join(pkgRoot, 'dist', 'index.js').replace(/\\/g, '/')}`).href
);

const KICAD_IMAGE = 'kicad/kicad:10.0-full';
const toDocker = (p) => p.replace(/\\/g, '/');
const dockerEnv = { ...process.env, MSYS_NO_PATHCONV: '1' };
const cases = galleryCases;



// ---------------------------------------------------------------- run

mkdirSync(outRoot, { recursive: true });
mkdirSync(publicDir, { recursive: true });
const freeroute = makeFreeroutingRunner({ workDir: outRoot });
const notaryDrc = makeKicadDrcRunner({ workDir: outRoot });
const summary = [];

for (const [name, circuit] of cases) {
    console.log(`\n────────── ${name}`);
    const dir = join(outRoot, name);
    mkdirSync(dir, { recursive: true });
    let q;
    try {
        q = await layoutCircuit(circuit, { router: 'quality', freeroute, notaryDrc });
    } catch (e) {
        console.error(`  ✗ layoutCircuit threw — ${String(e).slice(0, 240)}`);
        summary.push([name, 'THREW', '']);
        continue;
    }
    if (!q.ok || !q.outputs) {
        const errs = q.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join(' | ');
        console.error(`  ✗ layout not ok — ${errs.slice(0, 300)}`);
        summary.push([name, 'NOT-OK', '']);
        continue;
    }
    console.log(`  ✓ layout ok — traces=${q.stats.traces} vias=${q.stats.vias} completeness=${q.completeness}`);
    const applied = q.diagnostics.find((d) => d.code === 'PCB030');
    if (applied) console.log(`  · route: ${applied.message.slice(0, 90)}`);

    const inj = injectModels(q.outputs.kicadPcb);
    if (inj.unmatched.length) console.log(`  ⚠ no 3D body: ${inj.unmatched.map((u) => `${u.id}×${u.count}`).join(', ')}`);
    else console.log(`  ✓ 3D bodies injected: ${inj.injected} footprint(s)`);
    for (const w of inj.warnings) console.log(`  ⚠ align: ${w}`);
    const moved = inj.alignments.filter((a) => a.thetaDeg !== 0 || Math.hypot(a.dx, a.dy) > 0.01);
    if (moved.length) {
        const s = moved.map((a) => `${a.model.replace(/_P.*|_3\.9.*/, '')}(${a.dx.toFixed(2)},${a.dy.toFixed(2)},${a.thetaDeg}°)`);
        console.log(`  · body align: ${[...new Set(s)].join(' ')}`);
    }
    writeFileSync(join(dir, 'board.kicad_pcb'), inj.kicadPcb);
    writeFileSync(join(dir, 'board.kicad_pro'), q.outputs.kicadPro);

    // export GLB (bodied board, full layer stack)
    rmSync(join(dir, `${name}.glb`), { force: true });
    try {
        execFileSync('docker', ['run', '--rm', '-v', `${toDocker(dir)}:/work`, KICAD_IMAGE, 'kicad-cli', 'pcb', 'export', 'glb',
            '--include-tracks', '--include-pads', '--include-zones', '--include-silkscreen', '--include-soldermask',
            '--subst-models', '--output', `/work/${name}.glb`, '/work/board.kicad_pcb'],
            { stdio: 'pipe', timeout: 300000, env: dockerEnv });
        const kb = Math.round(statSync(join(dir, `${name}.glb`)).size / 1024);
        copyFileSync(join(dir, `${name}.glb`), join(publicDir, `${name}.glb`));
        console.log(`  ✓ GLB ${kb} KB → public/${name}.glb`);
        summary.push([name, 'OK', `${kb}KB`]);
    } catch (e) {
        console.error(`  ✗ glb export failed — ${String(e.stderr ?? e).slice(0, 200)}`);
        summary.push([name, 'GLB-FAIL', '']);
        continue;
    }

    // DRC verdict (honest report)
    rmSync(join(dir, 'drc.json'), { force: true });
    try {
        execFileSync('docker', ['run', '--rm', '-v', `${toDocker(dir)}:/work`, KICAD_IMAGE, 'kicad-cli', 'pcb', 'drc',
            '--refill-zones', '--exit-code-violations', '--severity-error', '--format', 'json',
            '--output', '/work/drc.json', '/work/board.kicad_pcb'],
            { stdio: 'pipe', timeout: 300000, env: dockerEnv });
        console.log(`  ✓ DRC CLEAN ✔`);
        summary[summary.length - 1][2] += ' DRC✔';
    } catch (e) {
        if (e.status !== 5) { console.error(`  ✗ DRC exec failed (${e.status})`); continue; }
        const r = existsSync(join(dir, 'drc.json')) ? JSON.parse(readFileSync(join(dir, 'drc.json'), 'utf8')) : null;
        const v = r?.violations ?? [], u = r?.unconnected_items ?? [];
        const bt = {};
        for (const x of v) bt[x.type] = (bt[x.type] ?? 0) + 1;
        console.log(`  ⚠ DRC: ${v.length} violation(s) ${Object.entries(bt).map(([t, n]) => `${t}×${n}`).join(', ')}${u.length ? ` + ${u.length} unrouted` : ''}`);
        summary[summary.length - 1][2] += ` DRC:${v.length}v${u.length ? `/${u.length}u` : ''}`;
    }
}

console.log('\n══════════ SUMMARY ══════════');
for (const [n, s, extra] of summary) console.log(`  ${String(s).padEnd(9)} ${String(extra).padEnd(16)} ${n}`);
console.log(`\ndone: ${summary.filter((s) => s[1] === 'OK').length}/${cases.length} GLB üretildi → apps/pcb-viewer/public/`);
