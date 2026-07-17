import { applyFabRulesToDsn, applyPerNetWidths, stripRouting, enlargeBoard, findFullyUnroutedNets, fixPlaceRotations } from './route';
import { JLC_FAB_PROFILE } from './fab-profile';

// applyFabRulesToDsn is a pure string transform (no ESM dsn-converter), so it lives in jest; exportDsn
// and mergeSes exercise dsn-converter and are covered by the `pnpm test:layout` harness instead.
describe('applyFabRulesToDsn — lift the DSN net class to the fab floor (freerouting honours it verbatim)', () => {
    // The exact shape dsn-converter emits: structure default 200 + a `kicad_default` class at 150/150,
    // plus a TYPED smd_smd clearance that MUST survive untouched.
    const dsn = [
        '(pcb x',
        '  (resolution um 10)(unit um)',
        '  (structure',
        '    (rule (width 200) (clearance 200) (clearance 50 (type smd_smd))))',
        '  (network',
        '    (class "kicad_default" ""',
        '      (rule (width 150) (clearance 150)))))',
    ].join('\n');

    it('raises the class width+clearance from 0.15mm to the 0.2mm profile floor', () => {
        const out = applyFabRulesToDsn(dsn, JLC_FAB_PROFILE);
        expect(out).not.toContain('(width 150)');
        expect(out).not.toContain('(clearance 150)');
        expect(out.match(/\(width 200\)/g)?.length).toBe(2); // structure default + lifted class
        expect(out.match(/\(clearance 200\)/g)?.length).toBe(2);
    });

    it('LEAVES a typed clearance (smd_smd pad spacing) untouched — only tracks are lifted', () => {
        const out = applyFabRulesToDsn(dsn, JLC_FAB_PROFILE);
        expect(out).toContain('(clearance 50 (type smd_smd))');
    });

    it('never SHRINKS a deliberately-wider class (max, not set)', () => {
        const wide = '(rule (width 500) (clearance 500))';
        const out = applyFabRulesToDsn(wide, JLC_FAB_PROFILE);
        expect(out).toContain('(width 500)'); // not shrunk to 200
        expect(out).toContain('(clearance 500)'); // not shrunk to 200
    });

    it('appends via clearance types at minClearance + guard (freerouting under-spaces vias)', () => {
        const out = applyFabRulesToDsn(dsn, JLC_FAB_PROFILE);
        expect(out).toContain('(clearance 300 (type via_via))'); // 0.2 + 0.1 guard = 0.3mm
        expect(out).toContain('(clearance 300 (type wire_via))');
        expect(out).toContain('(clearance 300 (type via_smd))');
    });

    it('honours an explicit viaClearanceMm override', () => {
        const out = applyFabRulesToDsn(dsn, { ...JLC_FAB_PROFILE, viaClearanceMm: 0.3 });
        expect(out).toContain('(clearance 300 (type via_via))');
    });

    it('scales the floor with the profile (a 0.3mm profile lifts to 300µm)', () => {
        const out = applyFabRulesToDsn(dsn, { ...JLC_FAB_PROFILE, minTraceWidthMm: 0.3, minClearanceMm: 0.25 });
        expect(out).toContain('(width 300)');
        expect(out).toContain('(clearance 250)');
    });

    it('is IDEMPOTENT — a second pass does not duplicate the via clearance types', () => {
        const once = applyFabRulesToDsn(dsn, JLC_FAB_PROFILE);
        const twice = applyFabRulesToDsn(once, JLC_FAB_PROFILE);
        expect(twice).toBe(once);
        expect((twice.match(/\(type via_via\)/g) ?? []).length).toBe((once.match(/\(type via_via\)/g) ?? []).length);
    });
});

describe('fixPlaceRotations — repair dsn-converter@0.0.91 `rotation % 90` place-rotation loss', () => {
    // The bug: dsn-converter emits EVERY place as `front 0` (rotation % 90 zeroes right angles), while
    // grouping same-bbox footprints into ONE image whose pins come from the FIRST member. A 180°-rotated
    // member then keeps the donor's pad frame → freerouting wires nets to the opposite pad (the 13-attempt
    // DRC-retry root cause, verified live 17 Tem 2026). The repair writes each place's rotation RELATIVE
    // to its image donor: dsnRot = (θ_member − θ_donor) mod 360 — dsn-converter emits coordinates verbatim
    // (no y mirror) and tscircuit + freerouting share the same math-CCW rotation convention on them.
    const circuit = [
        { type: 'pcb_component', source_component_id: 'source_component_0', rotation: 0 },
        { type: 'pcb_component', source_component_id: 'source_component_1', rotation: 180 },
        { type: 'pcb_component', source_component_id: 'source_component_2', rotation: 90 },
        { type: 'pcb_component', source_component_id: 'source_component_3', rotation: 270 },
        { type: 'pcb_component', source_component_id: 'source_component_4', rotation: 90 },
        { type: 'pcb_board' },
    ] as never[];
    const dsn = [
        '(pcb x',
        '  (placement',
        '    (component 0402_1x2mm', // donor rot 0 + a 180° member (the dominant shorting case)
        '      (place R1_source_component_0 10000 -20000 front 0)',
        '      (place R2_source_component_1 30000 -20000 front 0)',
        '    )',
        '    (component sot23', // donor itself rotated 90 — members must land RELATIVE to it
        '      (place Q1_source_component_2 50000 -20000 front 0)',
        '      (place Q2_source_component_3 70000 -20000 front 0)',
        '    )',
        '    (component square_pad', // square-footprint 90° sharing — locks the delta SIGN
        '      (place U1_source_component_0 90000 -20000 front 0)',
        '      (place U2_source_component_4 110000 -20000 front 0)',
        '    )',
        '    (component conn',
        '      (place J1_source_component_1 0 0 back 0)', // back side: mirror algebra differs — untouched
        '    )',
        '  )',
        ')',
    ].join('\n');

    it('writes each member rotation RELATIVE to its image donor (donor → 0, 180° member → 180)', () => {
        const out = fixPlaceRotations(dsn, circuit);
        expect(out).toContain('(place R1_source_component_0 10000 -20000 front 0)');
        expect(out).toContain('(place R2_source_component_1 30000 -20000 front 180)');
    });

    it('handles a rotated donor: 90° donor stays 0, its 270° partner becomes 180', () => {
        const out = fixPlaceRotations(dsn, circuit);
        expect(out).toContain('(place Q1_source_component_2 50000 -20000 front 0)');
        expect(out).toContain('(place Q2_source_component_3 70000 -20000 front 180)');
    });

    it('carries a +90 donor-relative delta straight through (same math-CCW convention on both sides)', () => {
        const out = fixPlaceRotations(dsn, circuit);
        expect(out).toContain('(place U2_source_component_4 110000 -20000 front 90)');
    });

    it('resets the donor at every (component …) block — groups never bleed into each other', () => {
        const out = fixPlaceRotations(dsn, circuit);
        // If donor state leaked across blocks, Q1 (rot 90) would inherit R1's donor (rot 0) and get 270.
        expect(out).toContain('(place Q1_source_component_2 50000 -20000 front 0)');
    });

    it('leaves back-side places untouched', () => {
        const out = fixPlaceRotations(dsn, circuit);
        expect(out).toContain('(place J1_source_component_1 0 0 back 0)');
    });

    it('is a no-op when the circuit has no pcb_component elements', () => {
        expect(fixPlaceRotations(dsn, [{ type: 'pcb_board' }] as never[])).toBe(dsn);
    });
});

describe('applyPerNetWidths — split kicad_default into IPC width classes (freerouting per-net width)', () => {
    const dsn = [
        '(pcb x (network',
        '    (class "kicad_default" "" "GND_source_net_1" "IN_source_net_5" "VCC_source_net_3"',
        '      (circuit',
        '        (use_via "Via[0-1]_600:300_um")',
        '      )',
        '      (rule',
        '        (width 200)',
        '        (clearance 200) (clearance 250 (type via_via))',
        '      )',
        '    )',
        '  )',
        '  (wiring',
        '  )',
        ')',
    ].join('\n');

    it('moves a widened net into its own class WITHOUT mangling the net list (the [^"]* quote fix)', () => {
        const out = applyPerNetWidths(dsn, { VCC: 1.0 }, JLC_FAB_PROFILE);
        // kicad_default keeps the two signal nets with their REAL names (the [^"]+ bug turned these into
        // single-space tokens; the positive match below fails if that regression returns).
        expect(out).toMatch(/\(class "kicad_default" "GND_source_net_1" "IN_source_net_5"/);
        expect(out).not.toMatch(/"kicad_default" " "/); // the specific cross-paired-quote corruption
        // VCC lands in a 1000µm class
        expect(out).toMatch(/\(class "w1000" "VCC_source_net_3"/);
        expect(out).toMatch(/w1000[\s\S]*\(width 1000\)/);
    });

    it('leaves the DSN untouched when no net exceeds the floor width', () => {
        const out = applyPerNetWidths(dsn, { VCC: 0.2 }, JLC_FAB_PROFILE); // 0.2mm == floor → no split
        expect(out).toContain('"GND_source_net_1" "IN_source_net_5" "VCC_source_net_3"');
        expect(out).not.toContain('(class "w');
    });
});

describe('findFullyUnroutedNets — the fast Docker-free "whole net dropped" pre-check', () => {
    const dsn = [
        '(pcb x (network',
        '  (net "GND_source_net_1" (pins A-1 B-1 C-1))',
        '  (net "OUT_source_net_0" (pins U1-1 R2-2))',
        '  (net "unconnected-(U1-Pad8)" (pins U1-8)))', // single-pin pseudo-net — not routable
    ].join('\n');

    it('flags a routable net that has NO wires in the SES', () => {
        // SES routed GND but dropped OUT entirely (no OUT group under network_out)
        const ses = '(session (routes (network_out (net "GND_source_net_1" (wire (path F.Cu 200 0 0 1 1))))))';
        expect(findFullyUnroutedNets(dsn, ses)).toEqual(['OUT_source_net_0']);
    });

    it('reports none when every routable net has at least one wire (single-pin pseudo-nets ignored)', () => {
        const ses = '(session (routes (network_out (net "GND_source_net_1" (wire ...)) (net "OUT_source_net_0" (wire ...)))))';
        expect(findFullyUnroutedNets(dsn, ses)).toEqual([]);
    });
});

describe('stripRouting — drop copper geometry so an external router starts from placement', () => {
    it('removes pcb_trace + pcb_via, keeps everything else (components, pads, board)', () => {
        const board = [
            { type: 'pcb_board' },
            { type: 'pcb_component' },
            { type: 'pcb_smtpad' },
            { type: 'pcb_trace' },
            { type: 'pcb_via' },
        ] as never[];
        const out = stripRouting(board);
        expect(out.map((e: { type: string }) => e.type)).toEqual(['pcb_board', 'pcb_component', 'pcb_smtpad']);
    });
});

describe('enlargeBoard — symmetric routing headroom without moving the placement', () => {
    it('grows the rectangular pcb_board by 2×margin on each dimension, keeps center', () => {
        const board = [{ type: 'pcb_board', width: 38, height: 28, center: { x: 0, y: 0 } }, { type: 'pcb_smtpad', x: 5 }] as never[];
        const out = enlargeBoard(board, 6) as Array<{ type: string; width?: number; height?: number; x?: number }>;
        expect(out[0]).toMatchObject({ width: 50, height: 40, center: { x: 0, y: 0 } });
        expect(out[1]).toMatchObject({ type: 'pcb_smtpad', x: 5 }); // pads untouched
    });

    it('is a no-op for marginMm ≤ 0 and leaves a custom outline untouched (honest)', () => {
        const board = [{ type: 'pcb_board', width: 38, height: 28 }] as never[];
        expect(enlargeBoard(board, 0)).toBe(board);
        const outlined = [{ type: 'pcb_board', width: 38, height: 28, outline: [{ x: 0, y: 0 }] }] as never[];
        expect((enlargeBoard(outlined, 6)[0] as unknown as { width: number }).width).toBe(38); // outline board not grown
    });
});
