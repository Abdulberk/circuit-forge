import { JLC_FAB_PROFILE } from './fab-profile';
import {
    applyFabRulesToDsn,
    applyPerNetWidths,
    stripRouting,
    enlargeBoard,
    shrinkBoardToContent,
    findFullyUnroutedNets,
    fixPlaceRotations,
} from './route';

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
        const ses =
            '(session (routes (network_out (net "GND_source_net_1" (wire ...)) (net "OUT_source_net_0" (wire ...)))))';
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
        const board = [
            { type: 'pcb_board', width: 38, height: 28, center: { x: 0, y: 0 } },
            { type: 'pcb_smtpad', x: 5 },
        ] as never[];
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

describe('shrinkBoardToContent — hand the routing headroom back once routing is finished', () => {
    const board = (w: number, h: number, center = { x: 0, y: 0 }, extra: object = {}) => ({
        type: 'pcb_board',
        width: w,
        height: h,
        center,
        ...extra,
    });
    const pad = (x: number, y: number, w = 1, h = 1) => ({ type: 'pcb_smtpad', x, y, width: w, height: h });
    const boardOf = (els: object[]) => els.find((e) => (e as { type: string }).type === 'pcb_board') as
        | { width: number; height: number; center: { x: number; y: number } }
        | undefined;

    it('shrinks a 30mm board around 10mm of content, leaving exactly the edge keep-out', () => {
        const out = shrinkBoardToContent([board(30, 30), pad(-5, -5), pad(5, 5)] as never, 0.3);
        // content spans -5.5..5.5 on both axes (pads are 1mm wide) → 11mm + 2×0.3 keep-out
        expect(boardOf(out)!.width).toBeCloseTo(11.6, 6);
        expect(boardOf(out)!.height).toBeCloseTo(11.6, 6);
    });

    it('re-centres on the CONTENT — an off-centre layout must not be clipped by the shrink', () => {
        const out = shrinkBoardToContent([board(40, 40), pad(8, 8), pad(12, 12)] as never, 0.5);
        expect(boardOf(out)!.center).toEqual({ x: 10, y: 10 });
    });

    it('keeps every element that is not the board, untouched', () => {
        const els = [board(30, 30), pad(1, 1), { type: 'pcb_trace', route: [{ x: 0, y: 0, width: 0.2 }] }];
        const out = shrinkBoardToContent(els as never, 0.3);
        expect(out).toHaveLength(3);
        expect(out.filter((e) => e.type !== 'pcb_board')).toEqual(els.slice(1));
    });

    it('counts traces, vias, through-holes and courtyards as content — none of them may fall off the edge', () => {
        const out = shrinkBoardToContent(
            [
                board(60, 60),
                pad(0, 0),
                { type: 'pcb_trace', route: [{ x: 9, y: 0, width: 0.4 }] },
                { type: 'pcb_via', x: 0, y: -8, outer_diameter: 0.6 },
                { type: 'pcb_plated_hole', x: -7, y: 0, outer_diameter: 1.2 },
                { type: 'pcb_courtyard_outline', outline: [{ x: 0, y: 11 }] },
            ] as never,
            0,
        );
        expect(boardOf(out)!.width).toBeCloseTo(9.2 + 7.6, 6); // trace right edge 9.2, hole left edge -7.6
        expect(boardOf(out)!.height).toBeCloseTo(11 + 8.3, 6); // courtyard top 11, via bottom -8.3
    });

    it('IGNORES silkscreen — a wide designator must not be able to veto the shrink', () => {
        const out = shrinkBoardToContent(
            [board(30, 30), pad(0, 0), { type: 'pcb_silkscreen_text', anchor_position: { x: 14, y: 14 } }] as never,
            0.3,
        );
        expect(boardOf(out)!.width).toBeCloseTo(1.6, 6);
    });

    it.each([
        ['a custom outline — that shape belongs to the designer, not to our headroom', [board(30, 30, { x: 0, y: 0 }, { outline: [{ x: 0, y: 0 }] }), pad(0, 0)]],
        ['a board with no measurable content', [board(30, 30)]],
        ['no board element at all', [pad(0, 0)]],
    ])('returns the input UNCHANGED for %s', (_label: string, els: object[]) => {
        expect(shrinkBoardToContent(els as never, 0.3)).toBe(els);
    });

    it('never GROWS a board whose content already overflows it — DRC reports that, we do not hide it', () => {
        const els = [board(5, 5), pad(-20, -20), pad(20, 20)];
        expect(shrinkBoardToContent(els as never, 0.3)).toBe(els);
    });

    it('shrinks only the axis that has slack when the other is already tight', () => {
        const out = shrinkBoardToContent([board(40, 4), pad(0, -1.5), pad(0, 1.5)] as never, 0.3);
        expect(boardOf(out)!.width).toBeCloseTo(1.6, 6); // 1mm of pad + 2×0.3 keep-out
        expect(boardOf(out)!.height).toBe(4); // no slack (4mm of content needs 4.6mm) — left exactly as it was
    });
});
