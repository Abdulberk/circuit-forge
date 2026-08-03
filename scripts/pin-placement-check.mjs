/**
 * Caller-owned placements, through the WHOLE pipeline.
 *
 * WHY THIS IS A SCRIPT AND NOT A SPEC. `layoutCircuit` reaches the ESM-only footprinter through a dynamic
 * import, and pcb-core's jest runs a flat CommonJS transpile — the same split documented in its jest
 * config. So the entry function can only be exercised against the BUILT output, which is what this does.
 *
 * WHY IT EXISTS AT ALL. Both defects it guards were found by running one real circuit AFTER a green engine
 * suite, and neither was visible from inside `placeParts`:
 *
 *   1. The pins were honoured by the engine and then thrown away by the caller. `attemptAutoPlacement` is
 *      HPWL-gated — a placement that does not beat the connectivity-blind grid is rejected in favour of it
 *      — and a constrained solve loses that comparison easily. The board came back looking perfectly fine,
 *      placed by the grid, silently un-pinned.
 *   2. An impossible pin set was DETECTED, reported as an error, and shipped anyway. `ok` is computed once
 *      near the top of the pipeline, before placement runs, so an error raised afterwards changed nothing.
 *
 * Run: node scripts/pin-placement-check.mjs [--verbose]
 * Exits non-zero on the first failed assertion, so it is usable as a gate.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { layoutCircuit } = require('../packages/pcb-core/dist/index.js');

const verbose = process.argv.includes('--verbose');

/** A divider with a decoupling cap — five parts, enough for the placement engine to have opinions. */
const CIRCUIT = {
    version: '1.0',
    components: [
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: 'DC 5',
            pins: [
                { pinId: '+', netId: 'vin' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '1k',
            pins: [
                { pinId: '1', netId: 'vin' },
                { pinId: '2', netId: 'mid' },
            ],
        },
        {
            id: 'r2',
            type: 'resistor',
            designator: 'R2',
            value: '2k',
            pins: [
                { pinId: '1', netId: 'mid' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
        {
            id: 'c1',
            type: 'capacitor',
            designator: 'C1',
            value: '100n',
            pins: [
                { pinId: '1', netId: 'mid' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
        { id: 'g1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [
        { id: 'vin', name: 'VIN' },
        { id: 'mid', name: 'MID' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
};

/**
 * Where the emitted source actually puts each part.
 *
 * The generated tscircuit code is the artifact that carries the placement to the board, so it is what is
 * asserted on — not an intermediate the pipeline could still discard.
 */
function emitted(code) {
    const out = {};
    for (const line of (code ?? '').split('\n')) {
        const m = /name="(\w+)"[^>]*pcbX=\{(-?[\d.]+)\} pcbY=\{(-?[\d.]+)\}(?: pcbRotation=\{(\d+)\})?/.exec(line);
        if (m) out[m[1]] = { x: Number(m[2]), y: Number(m[3]), rotation: Number(m[4] ?? 0) };
    }
    return out;
}

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
    if (!ok) failures++;
}

const errorsOf = (r) => (r.diagnostics ?? []).filter((d) => d.severity === 'error');

async function main() {
    // ---- honoured ------------------------------------------------------------------------------------
    {
        const r = await layoutCircuit(CIRCUIT, {
            placer: 'auto',
            fixedPlacements: { r1: { x: -8, y: 6 }, c1: { x: 8, y: -6, rotation: 90 } },
        });
        const at = emitted(r.code);
        if (verbose) console.log(JSON.stringify(at, null, 2));
        check(
            'a pinned part is emitted at exactly the requested millimetres',
            r.ok && at.R1?.x === -8 && at.R1?.y === 6,
            `R1 = ${JSON.stringify(at.R1)}`,
        );
        check(
            'a pinned ROTATION is emitted too, and not dropped when it is 0-adjacent',
            at.C1?.x === 8 && at.C1?.y === -6 && at.C1?.rotation === 90,
            `C1 = ${JSON.stringify(at.C1)}`,
        );
    }

    // ---- not traded away for a metric nobody asked about ----------------------------------------------
    {
        // The first defect, verbatim. The pinned solve loses the HPWL comparison against the grid; if the
        // gate still applies, the grid wins and R1 comes back somewhere else entirely.
        const r = await layoutCircuit(CIRCUIT, { placer: 'auto', fixedPlacements: { r1: { x: -8, y: 6 } } });
        const at = emitted(r.code);
        check(
            'pins are NOT traded for a shorter wirelength — the grid is not a comparable alternative',
            at.R1?.x === -8 && at.R1?.y === 6,
            `R1 = ${JSON.stringify(at.R1)} (the grid placement was adopted and the pin was lost)`,
        );
        check(
            'a part whose rotation was not pinned is still free to rotate',
            [0, 90, 180, 270].includes(at.R1?.rotation),
            `R1 rotation = ${at.R1?.rotation}`,
        );
    }

    // ---- refused, and the board withheld --------------------------------------------------------------
    {
        // The second defect: detected, reported, and shipped anyway.
        const r = await layoutCircuit(CIRCUIT, {
            placer: 'auto',
            fixedPlacements: { r1: { x: 0, y: 0 }, c1: { x: 0.5, y: 0 } },
        });
        const e = errorsOf(r);
        check(
            'overlapping pinned courtyards WITHHOLD the board',
            r.ok === false && r.outputs === null,
            `ok=${r.ok} outputs=${r.outputs ? 'present' : 'null'}`,
        );
        check(
            '…and the message names the remedy as a number',
            e[0]?.code === 'PCB052' && /move one by at least [\d.]+mm/.test(e[0]?.message ?? ''),
            e[0]?.message,
        );
    }
    {
        const r = await layoutCircuit(CIRCUIT, { placer: 'auto', fixedPlacements: { r1: { x: 7.48, y: 0 } } });
        check(
            'an off-grid pin is REFUSED rather than snapped, naming the nearest legal value',
            r.ok === false && r.outputs === null && /nearest legal value is 7\.5mm/.test(errorsOf(r)[0]?.message ?? ''),
            errorsOf(r)[0]?.message,
        );
    }
    {
        const r = await layoutCircuit(CIRCUIT, { placer: 'auto', fixedPlacements: { nope: { x: 0, y: 0 } } });
        check(
            'a pin naming a component that is not on this board WITHHOLDS it',
            r.ok === false && r.outputs === null && errorsOf(r)[0]?.code === 'PCB051',
            `${r.ok} / ${errorsOf(r)[0]?.code}`,
        );
    }

    // ---- costs nothing when unused --------------------------------------------------------------------
    {
        const r = await layoutCircuit(CIRCUIT, { placer: 'auto' });
        const pinDiags = (r.diagnostics ?? []).filter((d) => /PCB05[123]/.test(d.code));
        check(
            'an unpinned board behaves exactly as it did before this existed',
            r.ok === true && r.outputs !== null && pinDiags.length === 0,
            `ok=${r.ok} outputs=${r.outputs ? 'present' : 'null'} pinDiags=${pinDiags.length}`,
        );
    }

    console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('pin-placement-check crashed:', e);
    process.exit(1);
});
