/**
 * NATIVE toolchain verification (LAYOUTJOB_PLAN.md M2) — runs INSIDE the pcb-runtime image, where
 * kicad-cli / java / freerouting.jar are installed NATIVELY (no docker run). It exercises the actual
 * native-runner code (scripts/lib/*-native.mjs — pure node builtins, zero pcb-core deps, so this needs
 * NO node_modules) against REAL golden fixtures produced by the Docker pipeline:
 *   • freerouting: __fixtures__/dense.dsn        → must yield a real Specctra SES session
 *   • kicad DRC  : a clean board + a dirty board → boolean oracle + parsed report must AGREE with reality
 *   • kicad GLB  : a bodied board vs its bare form → --subst-models must materially grow the GLB
 *
 * Run:  docker run --rm -v <repo>:/repo -w /repo pcb-runtime:local node scripts/verify-native-pipeline.mjs
 * Exits non-zero on any failure — this is the M2 gate, mirroring test:layout's honesty rules.
 *
 * SCOPE (honest boundary): this proves the native runner PRIMITIVES against real golden fixtures in the real
 * image. The FULL native composition — layoutCircuit(router:'quality') driving these runners through the
 * mergeSes → assembleKicadPcb → margin-retry loop end-to-end — is proven in M3, where the worker image bakes
 * pcb-core + its tscircuit deps (they cannot resolve from a Windows-built, pnpm-symlinked node_modules mounted
 * into Linux). Here we deliberately stay dependency-free (node builtins only) so this gate needs no node_modules.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeNativeFreeroutingRunner } from './lib/freerouting-native.mjs';
import { makeNativeKicad } from './lib/kicad-native.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const fx = join(root, 'packages', 'pcb-core', '__fixtures__');
const lc = join(root, 'packages', 'pcb-core', '.layout-check');

let failures = 0;
const fail = (m) => { failures++; console.error(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);
const need = (p) => { if (!existsSync(p)) throw new Error(`fixture missing: ${p}`); return p; };

// ---------------------------------------------------------------- 1. native freerouting (java -jar)
console.log('── native freerouting: java -jar $FREEROUTING_JAR (headless, 30 passes) on the golden dense.dsn');
try {
    const dsn = readFileSync(need(join(fx, 'dense.dsn')), 'utf8');
    const freeroute = makeNativeFreeroutingRunner({ passes: 30 }); // full route so routedness is actually asserted, not deferred
    const t0 = Date.now();
    const ses = await freeroute(dsn);
    // Structure + SIZE is NOT routedness: a valid SES echoes the placement block + the (routes) scaffold even when
    // ZERO wires are laid (that alone exceeds 1KB). Assert actual copper — count (wire segments and routed nets.
    // Golden dense.ses = 54 wires / 20 nets; the native jar is deterministic here (measured 54/20 at 30 passes), so
    // a floor well below that catches an empty/partial route (a headless/font/JRE regression that still emits a SES).
    const wires = (ses.match(/\(wire\b/g) || []).length;
    const nets = (ses.match(/\(net\s/g) || []).length;
    if (ses.includes('(session') && wires >= 40 && nets >= 18) {
        ok(`freerouting routed real copper: ${wires} wires / ${nets} nets in a ${ses.length}-byte SES (${Date.now() - t0}ms)`);
    } else {
        fail(`freerouting laid too little copper — ${wires} wires / ${nets} nets (need ≥40 / ≥18; session=${ses.includes('(session')})`);
    }
} catch (e) {
    fail(`native freerouting threw — ${String(e).slice(0, 300)}`);
}

// ---------------------------------------------------------------- 2 & 3. native kicad-cli DRC + GLB
console.log('\n── native kicad-cli: DRC oracle + parsed report + GLB export');
const kicad = makeNativeKicad();

// Pick a clean board (quality route) and a dirty one (fast route) from a prior Docker run.
const clean = join(lc, 'opamp-mixed', 'board_quality.kicad_pcb');
const cleanPro = join(lc, 'opamp-mixed', 'board_quality.kicad_pro');
const dirty = join(lc, 'divider-led', 'board.kicad_pcb'); // fast route — not clearance-clean at 0.2mm
const dirtyPro = join(lc, 'divider-led', 'board.kicad_pro');
const bodied = join(lc, 'opamp-mixed', 'board_quality_bodies.kicad_pcb');

// 2a. notaryDrc boolean oracle — clean board → true
try {
    const proTxt = existsSync(cleanPro) ? readFileSync(cleanPro, 'utf8') : undefined;
    const verdict = await kicad.notaryDrc(readFileSync(need(clean), 'utf8'), proTxt);
    if (verdict === true) ok('notaryDrc(clean board) → true (exit 0)');
    else fail('notaryDrc(clean board) → false — expected the quality-routed board to be DRC-clean');
} catch (e) {
    fail(`notaryDrc(clean) threw — ${String(e).slice(0, 300)}`);
}

// 2b. drcReport parsed structure — clean board → empty violations + unconnected
try {
    const rep = await kicad.drcReport(readFileSync(clean, 'utf8'), existsSync(cleanPro) ? readFileSync(cleanPro, 'utf8') : undefined);
    const v = rep.violations ?? [], u = rep.unconnected_items ?? [];
    if (Array.isArray(v) && Array.isArray(u) && v.length === 0 && u.length === 0) {
        ok('drcReport(clean board) → 0 violations, 0 unconnected (parseable, agrees with oracle)');
    } else {
        fail(`drcReport(clean board) unexpected — violations=${v.length} unconnected=${u.length}`);
    }
} catch (e) {
    fail(`drcReport(clean) threw — ${String(e).slice(0, 300)}`);
}

// 2c. Anti-rubber-stamp differential — MANDATORY and FATAL. Sections 2a/2b only test the POSITIVE
// direction (clean board → clean), which an oracle that NEVER reports a violation (kicad-cli JSON schema
// drift, a mis-consumed --severity flag, DRC not evaluating rules) satisfies trivially. This is the only
// check that proves the native oracle can tell a bad board from a good one, so a missing fixture or a
// dirty board reading clean must HARD-FAIL — never a skipped block, never a warning.
if (!existsSync(dirty)) {
    fail(`no dirty fast-route fixture at ${dirty} — cannot prove the DRC oracle is not a rubber stamp (run \`pnpm test:layout\` to generate it)`);
} else {
    const dirtyProTxt = existsSync(dirtyPro) ? readFileSync(dirtyPro, 'utf8') : undefined;
    try {
        const rep = await kicad.drcReport(readFileSync(dirty, 'utf8'), dirtyProTxt);
        const total = (rep.violations?.length ?? 0) + (rep.unconnected_items?.length ?? 0);
        if (total > 0) ok(`drcReport(fast-route board) → ${rep.violations?.length ?? 0} violation(s) + ${rep.unconnected_items?.length ?? 0} unconnected (oracle discriminates)`);
        else fail('fast-route board read CLEAN — DRC oracle is a rubber stamp (never reports violations), or the fixture is no longer dirty');
    } catch (e) {
        fail(`drcReport(dirty) threw — ${String(e).slice(0, 300)}`);
    }
    // Reject path: notaryDrc's boolean-FALSE branch (kicad-cli exit 5 → false, kicad-native.mjs) is exactly
    // what the quality margin-retry accepts/rejects each candidate on. 2a proved only the true path; a broken
    // exit-code oracle that returns true for everything, or throws on violations instead of returning false,
    // would silently break the whole quality loop — prove the false path here too.
    try {
        const verdict = await kicad.notaryDrc(readFileSync(dirty, 'utf8'), dirtyProTxt);
        if (verdict === false) ok('notaryDrc(dirty board) → false (exit-5 reject path — the branch margin-retry depends on)');
        else fail('notaryDrc(dirty board) → true — reject path broken (the quality loop would accept a non-clean board)');
    } catch (e) {
        fail(`notaryDrc(dirty) threw instead of returning false — kicad-cli emitted a non-5 exit on violations (${String(e).slice(0, 200)})`);
    }
}

// 3. exportGlb — bodied board must produce a valid GLB, materially larger than the bare board (bodies resolved).
if (existsSync(bodied)) {
    try {
        const bodiedBuf = await kicad.exportGlb(readFileSync(bodied, 'utf8'));
        const bareBuf = await kicad.exportGlb(readFileSync(clean, 'utf8'));
        const magic = bodiedBuf.slice(0, 4).toString('ascii'); // glTF binary container magic
        const ratio = bodiedBuf.length / Math.max(bareBuf.length, 1);
        if (magic !== 'glTF') fail(`exportGlb produced non-GLB output (magic="${magic}")`);
        else if (ratio >= 1.3) ok(`exportGlb → valid GLB, bodies resolved: bodied ${Math.round(bodiedBuf.length / 1024)}KB vs bare ${Math.round(bareBuf.length / 1024)}KB (${ratio.toFixed(1)}×)`);
        else fail(`exportGlb: --subst-models did NOT add bodies — ${Math.round(bodiedBuf.length / 1024)}KB vs ${Math.round(bareBuf.length / 1024)}KB (${ratio.toFixed(2)}×)`);
    } catch (e) {
        fail(`exportGlb threw — ${String(e).slice(0, 300)}`);
    }
} else {
    fail(`no bodied board fixture at ${bodied} — run \`pnpm test:layout\` (Docker) once to generate it`);
}

// 4. exportGerbers — the DELIVERED fab bundle. It must be re-exported from the DRC'd board WITH the GND pour
//    refilled into the copper (checked == delivered), carry the full layer set + drill, and NOT leak the
//    Gerber Job File (.gbrjob) in as a bogus 'job' layer. This is the harness's live consumer of the runner's
//    exportGerbers — the exact path processor.ts delivers — so a pour-delivery regression turns the harness red.
try {
    const cleanTxt = readFileSync(need(clean), 'utf8');
    const hasZone = cleanTxt.includes('(zone ') && cleanTxt.includes('(net_name "GND")');
    const g = await kicad.exportGerbers(cleanTxt);
    const keys = Object.keys(g.layers);
    if (!keys.includes('F_Cu') || !keys.includes('B_Cu') || !keys.includes('Edge_Cuts') || !g.drill.length) {
        fail(`exportGerbers: incomplete bundle — layers=${keys.join(',')} drillBytes=${g.drill.length}`);
    } else {
        ok(`exportGerbers → ${keys.length} layers + drill (${g.drill.length}B)`);
    }
    if (keys.includes('job')) fail("exportGerbers: .gbrjob leaked into layers as 'job' — layers must be a pure layer→gerber map");
    else ok('exportGerbers: no .gbrjob pseudo-layer (layers stays a pure layer→gerber map)');
    if (hasZone) {
        if ((g.layers['B_Cu'] ?? '').includes('G36')) ok('exportGerbers: delivered B.Cu carries the GND pour (G36 region) — checked == delivered');
        else fail('exportGerbers: B.Cu has NO filled region despite an injected GND zone — pour missing from the DELIVERED gerbers');
    }
} catch (e) {
    fail(`exportGerbers threw — ${String(e).slice(0, 300)}`);
}

console.log(failures === 0 ? '\n✅ native-pipeline VERIFIED' : `\n❌ native-pipeline FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
