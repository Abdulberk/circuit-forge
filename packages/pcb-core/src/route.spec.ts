import { applyFabRulesToDsn, stripRouting, enlargeBoard, findFullyUnroutedNets } from './route';
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

    it('appends via clearance types (freerouting under-spaces vias without them) at 1.25× clearance', () => {
        const out = applyFabRulesToDsn(dsn, JLC_FAB_PROFILE);
        expect(out).toContain('(clearance 250 (type via_via))'); // 0.2 * 1.25 = 0.25mm
        expect(out).toContain('(clearance 250 (type wire_via))');
        expect(out).toContain('(clearance 250 (type via_smd))');
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
