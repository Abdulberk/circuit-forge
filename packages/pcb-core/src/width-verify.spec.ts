/**
 * The post-route width check, which until 2 Aug 2026 could not fail for the reason it exists.
 *
 * It compared each net's WIDEST point against the IPC-2221 target. A 2 A trace that runs 0.8 mm for most
 * of its length and necks to 0.2 mm squeezing past one pad reported 0.8 mm and passed — and the neck is
 * precisely the part that overheats. KiCad cannot catch it either: a board carries one global minimum
 * width, and the narrow segment satisfies it, so nothing anywhere would have objected.
 *
 * The first test below is that case. It fails against the old implementation and passes against the new
 * one, which is the only thing that makes this file worth having.
 */
import type { LayoutDiagnostic } from '@circuit-forge/pcb-preflight';

import type { TscElement } from './parity';

import { verifyPerNetWidths } from './index';

/** A board carrying one net whose trace has the given per-point widths. */
const boardWith = (netName: string, widths: number[]): TscElement[] =>
    [
        { type: 'source_net', source_net_id: 'net1', name: netName },
        { type: 'source_trace', source_trace_id: 'st1', connected_source_net_ids: ['net1'] },
        {
            type: 'pcb_trace',
            source_trace_id: 'st1',
            route: widths.map((width, i) => ({ x: i, y: 0, width })),
        },
    ] as unknown as TscElement[];

const run = (board: TscElement[], targets: Record<string, number>): LayoutDiagnostic[] => {
    const diagnostics: LayoutDiagnostic[] = [];
    verifyPerNetWidths(board, targets, diagnostics);
    return diagnostics;
};

describe('a net is only as wide as its narrowest point', () => {
    it('CATCHES a trace that is wide almost everywhere and necks down once', () => {
        // 19 points at 0.8 mm and one at 0.2 mm: the old max-based check reported 0.80 and passed.
        const widths = [...Array<number>(19).fill(0.8), 0.2];
        const d = run(boardWith('GND', widths), { GND: 0.8 });
        expect(d).toHaveLength(1);
        expect(d[0]!.code).toBe('PCB042');
        expect(d[0]!.message).toMatch(/0\.20mm/);
        // The message must point at the neck, or the reader goes looking at the wrong part of the trace.
        expect(d[0]!.message).toMatch(/narrowest point/i);
    });

    it('passes a trace that meets the target along its whole length', () => {
        expect(run(boardWith('GND', [0.8, 0.8, 0.8]), { GND: 0.8 })).toEqual([]);
    });

    it('allows the 5% measurement band, and only that', () => {
        expect(run(boardWith('GND', [0.77]), { GND: 0.8 })).toEqual([]); // 96% — within tolerance
        expect(run(boardWith('GND', [0.75]), { GND: 0.8 })).toHaveLength(1); // 94% — outside it
    });

    it('takes the narrowest across ALL of a net’s traces, not just within one', () => {
        const board = [
            { type: 'source_net', source_net_id: 'net1', name: 'VBUS' },
            { type: 'source_trace', source_trace_id: 'a', connected_source_net_ids: ['net1'] },
            { type: 'source_trace', source_trace_id: 'b', connected_source_net_ids: ['net1'] },
            { type: 'pcb_trace', source_trace_id: 'a', route: [{ x: 0, y: 0, width: 1.0 }] },
            { type: 'pcb_trace', source_trace_id: 'b', route: [{ x: 1, y: 0, width: 0.3 }] },
        ] as unknown as TscElement[];
        const d = run(board, { VBUS: 1.0 });
        expect(d).toHaveLength(1);
        expect(d[0]!.message).toMatch(/0\.30mm/);
    });

    it('says nothing about a net that is not on this board', () => {
        // Absence of a net is not evidence of a thin one — a board without VBUS must not be reported as
        // having routed it at zero.
        expect(run(boardWith('GND', [0.8]), { VBUS: 1.5 })).toEqual([]);
    });

    it('ignores a trace with NO routed geometry rather than calling it infinitely thin', () => {
        // An unrouted trace is the connectivity check's business. Folding it in here would report every
        // open net as a width violation and bury the real ones.
        expect(run(boardWith('GND', []), { GND: 0.8 })).toEqual([]);
    });

    it('ignores non-numeric or zero widths instead of treating them as a zero-width neck', () => {
        const board = boardWith('GND', [0.8, 0.8]);
        (board[2] as unknown as { route: Array<{ width?: unknown }> }).route[1]!.width = undefined;
        expect(run(board, { GND: 0.8 })).toEqual([]);
    });

    it('does nothing at all when no net has a target', () => {
        expect(run(boardWith('GND', [0.01]), {})).toEqual([]);
        expect(run(boardWith('GND', [0.01]), { GND: 0 })).toEqual([]);
    });
});
