/**
 * Honest standalone A/B benchmark: existing TypeScript placement kernel versus
 * the additive Rust candidate. No pcb-core index/layout API is used here.
 *
 * Metrics:
 *   - median wall latency (Rust includes process + JSON-file ABI overhead)
 *   - HPWL and board area
 *   - placement contract invariants and repeatability
 *
 * Run after both release artifacts exist:
 *   pnpm --filter @circuit-forge/pcb-core build
 *   cargo build --release --manifest-path crates/pcb-placement-rs/Cargo.toml
 *   node scripts/rust-placement-bench.mjs
 *
 * Optional env:
 *   RUST_PLACER_PATH, BENCH_REPS=5, BENCH_WARMUPS=1,
 *   BENCH_SIZES=25,50,100,200,400,800, BENCH_JSON_OUT=<path>
 */
import { existsSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRustPlacerBinary, runRustPlacement } from './lib/rust-placement.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const tsModulePath = join(repoRoot, 'packages', 'pcb-core', 'dist', 'placement.js');

if (!existsSync(tsModulePath)) {
    console.error(`Missing ${tsModulePath}. Run: pnpm --filter @circuit-forge/pcb-core build`);
    process.exit(2);
}

const { placeParts, computeHpwl } = await import(pathToFileURL(tsModulePath).href);
let binary;
try {
    binary = resolveRustPlacerBinary();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
}
const sizes = String(process.env.BENCH_SIZES ?? '25,50,100,200,400,800')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v >= 2);
const reps = positiveInt(process.env.BENCH_REPS, 5);
const warmups = nonNegativeInt(process.env.BENCH_WARMUPS, 1);
const requestedStarts =
    process.env.RUST_PLACER_STARTS === undefined ? undefined : positiveInt(process.env.RUST_PLACER_STARTS, 4);

if (sizes.length === 0) {
    console.error('BENCH_SIZES did not contain a valid component count');
    process.exit(2);
}

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function roundToGrid(value, grid) {
    return Math.ceil(value / grid) * grid;
}

function perimeterPad(index, count, w, h, net) {
    const side = index % 4;
    const slot = Math.floor(index / 4);
    const slots = Math.max(1, Math.ceil(count / 4));
    const t = slots === 1 ? 0 : -0.8 + (1.6 * slot) / (slots - 1);
    if (side === 0) return { x: -w / 2, y: (h / 2) * t, net };
    if (side === 1) return { x: (w / 2) * t, y: -h / 2, net };
    if (side === 2) return { x: w / 2, y: (h / 2) * t, net };
    return { x: (w / 2) * t, y: h / 2, net };
}

/**
 * Deterministic mixed-topology corpus. Each 24-part neighbourhood has an IC
 * hub, a power connector, passives/small packages, local chains and a
 * cross-cluster backbone. It stresses high-pin hubs, sparse signals, shared
 * power nets, rotation, heterogeneous courtyards and connector edge-pull.
 */
export function makeSyntheticPlacementInput(count) {
    const gridMm = 0.5;
    const marginMm = 4;
    const spacingMm = 2.4;
    const clusterSize = 24;
    const clusterCount = Math.ceil(count / clusterSize);
    const parts = [];
    const extraEdges = [];
    const netWeights = { GND: 0.05, VCC: 0.3 };
    const addWeight = (net, weight = 1) => {
        if (!(net in netWeights)) netWeights[net] = weight;
    };

    for (let cluster = 0; cluster < clusterCount; cluster++) {
        const first = cluster * clusterSize;
        const length = Math.min(clusterSize, count - first);
        if (length <= 0) break;

        const hubId = `U${String(cluster + 1).padStart(3, '0')}`;
        const leafNets = Array.from({ length: Math.max(0, length - 1) }, (_, i) => `C${cluster}_L${i + 1}`);
        const backboneLeft = cluster > 0 ? `BACKBONE_${cluster - 1}` : null;
        const backboneRight = cluster + 1 < clusterCount ? `BACKBONE_${cluster}` : null;
        if (backboneLeft) addWeight(backboneLeft, 1.5);
        if (backboneRight) addWeight(backboneRight, 1.5);
        for (const net of leafNets) addWeight(net);

        const hubW = 8 + (cluster % 3) * 1.5;
        const hubH = 8 + ((cluster + 1) % 3) * 1.5;
        const hubNets = ['VCC', 'GND', ...leafNets];
        if (backboneLeft) hubNets.push(backboneLeft);
        if (backboneRight) hubNets.push(backboneRight);
        parts.push({
            id: hubId,
            w: hubW,
            h: hubH,
            role: 'part',
            pads: hubNets.map((net, i) => perimeterPad(i, hubNets.length, hubW, hubH, net)),
        });

        for (let local = 1; local < length; local++) {
            const global = first + local;
            const signal = leafNets[local - 1];
            const previous = local > 1 ? leafNets[local - 2] : 'GND';
            const next = local < length - 1 ? leafNets[local] : 'VCC';
            const id =
                local === 1 ? `J${String(cluster + 1).padStart(3, '0')}` : `P${String(global + 1).padStart(4, '0')}`;

            if (local === 1) {
                parts.push({
                    id,
                    w: 5.1,
                    h: 2.54,
                    role: 'connector',
                    pads: [
                        { x: -1.27, y: 0, net: 'VCC' },
                        { x: 1.27, y: 0, net: signal },
                    ],
                });
            } else if (local % 7 === 0) {
                parts.push({
                    id,
                    w: 4.8,
                    h: 3.4,
                    role: 'part',
                    pads: [
                        { x: -2.1, y: -1.1, net: signal },
                        { x: -2.1, y: 1.1, net: previous },
                        { x: 2.1, y: -1.1, net: next },
                        { x: 2.1, y: 1.1, net: local % 14 === 0 ? 'VCC' : 'GND' },
                    ],
                });
            } else {
                const wide = local % 5 === 0;
                const w = wide ? 3.2 : 1.6;
                const h = wide ? 1.8 : 0.8;
                parts.push({
                    id,
                    w,
                    h,
                    role: 'part',
                    pads: [
                        { x: -w / 2, y: 0, net: signal },
                        { x: w / 2, y: 0, net: local % 3 === 0 ? previous : local % 3 === 1 ? next : 'GND' },
                    ],
                });
            }

            if (local > 1 && local % 6 === 0) {
                extraEdges.push({ a: hubId, b: id, weight: 4 });
            }
        }
    }

    const inflatedArea = parts.reduce((sum, p) => sum + (p.w + spacingMm) * (p.h + spacingMm), 0);
    const usableSide = Math.sqrt(inflatedArea / 0.38);
    const boardW = roundToGrid((usableSide + 2 * marginMm) * 1.12, gridMm);
    const boardH = roundToGrid((usableSide + 2 * marginMm) / 1.12, gridMm);
    const input = { parts, netWeights, extraEdges, boardW, boardH, gridMm, marginMm, spacingMm };
    if (requestedStarts !== undefined) input.options = { starts: requestedStarts };
    return input;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function timed(fn) {
    const start = performance.now();
    const value = fn();
    return { value, ms: performance.now() - start };
}

function halfExtents(part, rotation) {
    return rotation === 90 || rotation === 270 ? [part.h / 2, part.w / 2] : [part.w / 2, part.h / 2];
}

function canonicalPlacement(output) {
    const positions = {};
    for (const id of Object.keys(output?.positions ?? {}).sort()) {
        const p = output.positions[id];
        positions[id] = { x: p.x, y: p.y, rotation: p.rotation };
    }
    return JSON.stringify({
        ok: output?.ok,
        boardW: output?.boardW,
        boardH: output?.boardH,
        hpwl: output?.hpwl,
        positions,
    });
}

function checkInvariants(input, output) {
    const errors = [];
    const positions = output?.positions;
    if (!output || output.ok !== true) errors.push('output.ok is not true');
    if (!positions || typeof positions !== 'object') errors.push('positions missing');
    if (!Number.isFinite(output?.boardW) || output.boardW <= 0) errors.push('invalid boardW');
    if (!Number.isFinite(output?.boardH) || output.boardH <= 0) errors.push('invalid boardH');
    if (!Number.isFinite(output?.hpwl) || output.hpwl < 0) errors.push('invalid hpwl');
    if (errors.length) return { ok: false, errors, recomputedHpwl: NaN };

    const ids = new Set(input.parts.map((p) => p.id));
    const outputIds = Object.keys(positions);
    if (outputIds.length !== ids.size) errors.push(`position count ${outputIds.length} != ${ids.size}`);
    for (const id of outputIds) if (!ids.has(id)) errors.push(`unknown position ${id}`);

    const tolerance = 0.011; // output coordinates are rounded to 0.01mm by the TS contract
    for (const part of input.parts) {
        const pos = positions[part.id];
        if (!pos) {
            errors.push(`missing ${part.id}`);
            continue;
        }
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) errors.push(`${part.id} has non-finite coordinates`);
        if (![0, 90, 180, 270].includes(pos.rotation)) errors.push(`${part.id} has invalid rotation ${pos.rotation}`);
        if (Math.abs(pos.x / input.gridMm - Math.round(pos.x / input.gridMm)) > 1e-6)
            errors.push(`${part.id} x is off-grid`);
        if (Math.abs(pos.y / input.gridMm - Math.round(pos.y / input.gridMm)) > 1e-6)
            errors.push(`${part.id} y is off-grid`);
        const [hx, hy] = halfExtents(part, pos.rotation);
        if (Math.abs(pos.x) + hx > output.boardW / 2 - input.marginMm + tolerance)
            errors.push(`${part.id} exceeds board x bound`);
        if (Math.abs(pos.y) + hy > output.boardH / 2 - input.marginMm + tolerance)
            errors.push(`${part.id} exceeds board y bound`);
    }

    for (let i = 0; i < input.parts.length; i++) {
        const a = input.parts[i];
        const pa = positions[a.id];
        if (!pa) continue;
        const [aw, ah] = halfExtents(a, pa.rotation);
        for (let j = i + 1; j < input.parts.length; j++) {
            const b = input.parts[j];
            const pb = positions[b.id];
            if (!pb) continue;
            const [bw, bh] = halfExtents(b, pb.rotation);
            const separatedX = Math.abs(pb.x - pa.x) + tolerance >= aw + bw + input.spacingMm;
            const separatedY = Math.abs(pb.y - pa.y) + tolerance >= ah + bh + input.spacingMm;
            if (!separatedX && !separatedY) {
                errors.push(`${a.id}/${b.id} overlap spacing-inflated courtyards`);
                if (errors.length >= 20) break;
            }
        }
        if (errors.length >= 20) break;
    }

    const recomputedHpwl = computeHpwl(input.parts, positions);
    if (Math.abs(recomputedHpwl - output.hpwl) > 0.02) {
        errors.push(`reported hpwl ${output.hpwl} != recomputed ${recomputedHpwl}`);
    }
    return { ok: errors.length === 0, errors, recomputedHpwl };
}

function percentDelta(candidate, baseline) {
    return baseline === 0 ? 0 : ((candidate - baseline) / baseline) * 100;
}

function fixed(value, digits = 1) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

console.log('Rust placement A/B benchmark');
console.log(
    JSON.stringify({
        node: process.version,
        platform: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model ?? 'unknown',
        binary,
        sizes,
        reps,
        warmups,
        rustStarts: requestedStarts ?? 'binary-default',
        rustTiming: 'wall clock including JSON files + process startup',
    }),
);

const results = [];
let failed = false;

for (const size of sizes) {
    const input = makeSyntheticPlacementInput(size);

    for (let i = 0; i < warmups; i++) {
        placeParts(input);
        runRustPlacement(input, { binary });
    }

    const tsRuns = [];
    const rustRuns = [];
    for (let i = 0; i < reps; i++) {
        // Alternate order to avoid systematically favouring one engine under thermal/load drift.
        if (i % 2 === 0) {
            tsRuns.push(timed(() => placeParts(input)));
            rustRuns.push(timed(() => runRustPlacement(input, { binary })));
        } else {
            rustRuns.push(timed(() => runRustPlacement(input, { binary })));
            tsRuns.push(timed(() => placeParts(input)));
        }
    }

    const tsOutput = tsRuns[0].value;
    const rustOutput = rustRuns[0].value;
    const tsInvariant = checkInvariants(input, tsOutput);
    const rustInvariant = checkInvariants(input, rustOutput);
    const tsCanonical = canonicalPlacement(tsOutput);
    const rustCanonical = canonicalPlacement(rustOutput);
    const tsDeterministic = tsRuns.every((r) => canonicalPlacement(r.value) === tsCanonical);
    const rustDeterministic = rustRuns.every((r) => canonicalPlacement(r.value) === rustCanonical);
    const tsMs = median(tsRuns.map((r) => r.ms));
    const rustMs = median(rustRuns.map((r) => r.ms));
    const tsArea = tsOutput.boardW * tsOutput.boardH;
    const rustArea = rustOutput.boardW * rustOutput.boardH;
    const invariantOk = tsInvariant.ok && rustInvariant.ok && tsDeterministic && rustDeterministic;
    if (!invariantOk) failed = true;

    results.push({
        size,
        parts: input.parts.length,
        pads: input.parts.reduce((sum, p) => sum + p.pads.length, 0),
        ts: {
            medianMs: tsMs,
            samplesMs: tsRuns.map((r) => r.ms),
            hpwl: tsOutput.hpwl,
            boardAreaMm2: tsArea,
            invariant: tsInvariant,
            deterministic: tsDeterministic,
        },
        rust: {
            medianCliMs: rustMs,
            samplesCliMs: rustRuns.map((r) => r.ms),
            hpwl: rustOutput.hpwl,
            weightedHpwl: rustOutput.weightedHpwl,
            boardAreaMm2: rustArea,
            invariant: rustInvariant,
            deterministic: rustDeterministic,
            engine: rustOutput.engine,
            algorithm: rustOutput.algorithm,
            stats: rustOutput.stats,
        },
        comparison: {
            speedup: tsMs / rustMs,
            hpwlDeltaPct: percentDelta(rustOutput.hpwl, tsOutput.hpwl),
            areaDeltaPct: percentDelta(rustArea, tsArea),
        },
    });
}

console.table(
    results.map((r) => ({
        parts: r.parts,
        pads: r.pads,
        'TS p50 ms': fixed(r.ts.medianMs),
        'Rust CLI p50 ms': fixed(r.rust.medianCliMs),
        'speedup x': fixed(r.comparison.speedup, 2),
        'TS HPWL': fixed(r.ts.hpwl),
        'Rust HPWL': fixed(r.rust.hpwl),
        'HPWL delta %': fixed(r.comparison.hpwlDeltaPct),
        'TS area mm2': fixed(r.ts.boardAreaMm2, 0),
        'Rust area mm2': fixed(r.rust.boardAreaMm2, 0),
        'area delta %': fixed(r.comparison.areaDeltaPct),
        invariants: r.ts.invariant.ok && r.rust.invariant.ok ? 'PASS' : 'FAIL',
        deterministic: r.ts.deterministic && r.rust.deterministic ? 'PASS' : 'FAIL',
    })),
);

for (const row of results) {
    const problems = [
        ...row.ts.invariant.errors.map((e) => `TS: ${e}`),
        ...row.rust.invariant.errors.map((e) => `Rust: ${e}`),
        ...(row.ts.deterministic ? [] : ['TS: non-deterministic across measured runs']),
        ...(row.rust.deterministic ? [] : ['Rust: non-deterministic across measured runs']),
    ];
    if (problems.length) console.error(`${row.size} parts invariant failure:\n  ${problems.join('\n  ')}`);
}

const report = {
    generatedAt: new Date().toISOString(),
    environment: {
        node: process.version,
        platform: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model ?? 'unknown',
        binary,
        reps,
        warmups,
        rustStarts: requestedStarts ?? 'binary-default',
    },
    results,
    passed: !failed,
};

if (process.env.BENCH_JSON_OUT) {
    const output = resolve(process.cwd(), process.env.BENCH_JSON_OUT);
    writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(`JSON report: ${output}`);
}

console.log(`BENCH_RESULT=${JSON.stringify(report)}`);
process.exitCode = failed ? 1 : 0;
