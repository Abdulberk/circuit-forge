import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    JLC_FAB_PROFILE,
    FAB_TIERS,
    boardExtraProps,
    kicadProjectJson,
    injectPlacementOrigin,
    injectZone,
    reportViaCompliance,
    resolveFabProfile,
} from './fab-profile';
import { ipc2221WidthMm } from './ipc2221';

const realPcb = readFileSync(join(__dirname, '..', '__fixtures__', 'small.kicad_pcb'), 'utf8');

describe('boardExtraProps', () => {
    it('pins the LOCAL router (network-free determinism) and the min trace width (verified knobs)', () => {
        expect(boardExtraProps(JLC_FAB_PROFILE)).toBe('autorouter={{ local: true }} minTraceWidth={0.2}');
    });
});

describe('kicadProjectJson — the notary judges by OUR rules (single source of truth)', () => {
    it('carries the profile as KiCad design rules, via diameter derived from drill + 2*annular', () => {
        const pro = JSON.parse(kicadProjectJson(JLC_FAB_PROFILE));
        const rules = pro.board.design_settings.rules;
        expect(rules.min_track_width).toBe(0.2);
        expect(rules.min_clearance).toBe(0.2);
        expect(rules.min_via_annular_width).toBe(0.15);
        expect(rules.min_via_diameter).toBeCloseTo(0.6); // 0.3 + 2*0.15
        expect(rules.min_through_hole_diameter).toBe(0.3);
    });

    it('sets the Default net class clearance/width to the profile (what DRC actually checks track↔pad)', () => {
        // A tighter tier must lower the Default netclass, not just min_clearance — else DRC false-fails at
        // KiCad's 0.2mm default netclass (found live 3 Tem 2026).
        const std = JSON.parse(kicadProjectJson(FAB_TIERS.standard));
        const def = std.net_settings.classes.find((c: { name: string }) => c.name === 'Default');
        expect(def.clearance).toBe(0.127);
        expect(def.track_width).toBe(0.127);
        expect(def.via_drill).toBe(0.25);
    });
});

describe('injectZone — the PROVEN pour mechanism (Faz-0 spike) with the un-netted-copper safety gate', () => {
    it('pours onto the REAL converter board (its segments DO carry nets) — polygon + closed document', () => {
        const net = realPcb.match(/\(net \d+ "([^"]+)"\)/)?.[1];
        expect(net).toBeTruthy();
        const out = injectZone(realPcb, net!, 'B.Cu');
        expect(out.kind).toBe('ok');
        const pcb = (out as { kind: 'ok'; kicadPcb: string }).kicadPcb;
        expect(pcb).toContain(`(net_name "${net}")`);
        expect(pcb.trimEnd().endsWith(')')).toBe(true);
    });

    it('REFUSES to pour when copper segments carry no net (safety gate against false shorts)', () => {
        const unnetted = [
            '(kicad_pcb',
            '  (net 1 "GND")',
            '  (gr_line (start 0 0) (end 20 0) (layer "Edge.Cuts")',
            '  )',
            '  (segment (start 1 1) (end 2 2) (width 0.2) (layer "F.Cu")',
            '  )',
            ')',
        ].join('\n');
        expect(injectZone(unnetted, 'GND', 'B.Cu')).toEqual({ kind: 'unsafe-unnetted-copper' });
    });

    it('injects a zone into a NETTED board (polygon from Edge.Cuts bbox, document stays closed)', () => {
        const netted = [
            '(kicad_pcb',
            '  (net 0 "")',
            '  (net 1 "GND")',
            '  (gr_line (start 0 0) (end 20 0) (layer "Edge.Cuts"))',
            '  (gr_line (start 20 0) (end 20 15) (layer "Edge.Cuts")',
            '  )',
            '  (segment (start 1 1) (end 2 2) (width 0.2) (layer "F.Cu") (net 1)',
            '  )',
            ')',
        ].join('\n');
        const out = injectZone(netted, 'GND', 'B.Cu');
        expect(out.kind).toBe('ok');
        const pcb = (out as { kind: 'ok'; kicadPcb: string }).kicadPcb;
        expect(pcb).toContain('(net_name "GND")');
        expect(pcb).toContain('(layer "B.Cu")');
        expect(pcb).toMatch(/\(polygon \(pts \(xy 0 0\) \(xy 20 0\)/); // Edge.Cuts bbox
        expect(pcb.trimEnd().endsWith(')')).toBe(true);
    });

    it("reports 'no-net' for a net that does not exist (caller diagnoses; never a silent no-op)", () => {
        expect(injectZone(realPcb, 'NO_SUCH_NET')).toEqual({ kind: 'no-net' });
    });
});

describe('reportViaCompliance — NON-mutating (post-route enlargement manufactures shorts, proven live)', () => {
    it('counts undersized vias against the profile and NEVER mutates geometry', () => {
        const evaluated = [
            { type: 'pcb_via', hole_diameter: 0.2, outer_diameter: 0.3 }, // tscircuit default (annular 0.05)
            { type: 'pcb_via', hole_diameter: 0.4, outer_diameter: 0.8 }, // compliant
            { type: 'pcb_trace' },
        ];
        const r = reportViaCompliance(evaluated, JLC_FAB_PROFILE);
        expect(r).toEqual({ total: 2, undersized: 1 });
        expect(evaluated[0]).toMatchObject({ hole_diameter: 0.2, outer_diameter: 0.3 }); // untouched
    });
});

/**
 * resolveFabProfile is the boundary between "what a caller typed" and "the rules a physical board is built
 * and judged by". Everything here is a failure that reached the manufacturing outputs before it existed.
 */
describe('resolveFabProfile — a partial override must never leave the board half-specified', () => {
    it('completes a single-field override from the tier instead of replacing the whole profile', () => {
        // The original bug: `{minTraceWidthMm: 0.25}` became the ENTIRE profile, so via geometry was
        // undefined and the KiCad rules — computed as drill + 2*annular — shipped as NaN.
        const { profile } = resolveFabProfile({ minTraceWidthMm: 0.25 });
        expect(profile.minTraceWidthMm).toBe(0.25);
        expect(profile.viaDrillMm).toBe(FAB_TIERS.economy.viaDrillMm);
        expect(profile.viaAnnularMm).toBe(FAB_TIERS.economy.viaAnnularMm);
        expect(profile.minClearanceMm).toBe(FAB_TIERS.economy.minClearanceMm);
    });

    it('the completed profile produces FINITE KiCad design rules (the NaN rulebook regression)', () => {
        const { profile } = resolveFabProfile({ minTraceWidthMm: 0.25 });
        const rules = JSON.parse(kicadProjectJson(profile)).board.design_settings.rules;
        for (const value of Object.values(rules)) {
            if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
        }
        expect(rules.min_via_diameter).toBeCloseTo(0.6); // 0.3 + 2*0.15, not NaN
    });

    it('keeps the ground pour ON when the override simply does not mention it', () => {
        // An absent gndPour used to be indistinguishable from a deliberate false, so any override
        // silently deleted the ground plane.
        expect(resolveFabProfile({ minClearanceMm: 0.3 }).profile.gndPour).toBe(true);
        expect(resolveFabProfile({}).profile.gndPour).toBe(true);
        expect(resolveFabProfile().profile.gndPour).toBe(true);
    });

    it('an EXPLICIT gndPour:false is still honoured — the fix must not take the choice away', () => {
        expect(resolveFabProfile({ gndPour: false }).profile.gndPour).toBe(false);
    });
});

describe('resolveFabProfile — overrides may only make a board easier to manufacture', () => {
    it('raises a below-limit value to the tier floor and says so', () => {
        const { profile, adjustments } = resolveFabProfile({ minTraceWidthMm: 0.05 });
        expect(profile.minTraceWidthMm).toBe(0.2); // economy limit, not the unmanufacturable 0.05
        expect(adjustments.join(' ')).toMatch(/minTraceWidthMm.*0\.2/);
    });

    it('accepts a MORE conservative value untouched (a wider trace is always buildable)', () => {
        const { profile, adjustments } = resolveFabProfile({ minTraceWidthMm: 0.4 });
        expect(profile.minTraceWidthMm).toBe(0.4);
        expect(adjustments).toEqual([]);
    });

    it('a finer process is reached by naming a finer tier, and its floors then apply', () => {
        const { profile, tier } = resolveFabProfile({ tier: 'advanced', minTraceWidthMm: 0.1 });
        expect(tier).toBe('advanced');
        expect(profile.minTraceWidthMm).toBe(0.1); // above the 0.0889 advanced limit → kept
        expect(profile.viaDrillMm).toBe(FAB_TIERS.advanced.viaDrillMm);
    });

    it('clamps every floor field, not just the one that was noticed', () => {
        const { profile } = resolveFabProfile({
            minTraceWidthMm: 0.01,
            minClearanceMm: 0.01,
            viaDrillMm: 0.01,
            viaAnnularMm: 0.01,
        });
        expect(profile).toMatchObject(FAB_TIERS.economy);
    });
});

describe('resolveFabProfile — hostile and malformed input', () => {
    it.each([
        ['a negative number', -1],
        ['zero', 0],
        ['a string', '0.15'],
        ['null', null],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['an object', { mm: 0.15 }],
    ])('ignores %s for a numeric field and keeps the tier value', (_label, bad) => {
        const { profile, adjustments } = resolveFabProfile({ minClearanceMm: bad });
        expect(profile.minClearanceMm).toBe(FAB_TIERS.economy.minClearanceMm);
        expect(adjustments).toHaveLength(1);
    });

    it('falls back to economy on an unknown tier rather than producing an undefined base', () => {
        const { profile, tier, adjustments } = resolveFabProfile({ tier: 'hdi-6-layer' as never });
        expect(tier).toBe('economy');
        expect(profile).toMatchObject(FAB_TIERS.economy);
        expect(adjustments.join(' ')).toMatch(/unknown fab tier/);
    });

    it('refuses an inherited key as a tier — a name off the wire cannot reach Object.prototype', () => {
        for (const name of ['constructor', '__proto__', 'toString']) {
            const { tier, profile } = resolveFabProfile({ tier: name as never });
            expect(tier).toBe('economy');
            expect(profile.minTraceWidthMm).toBe(0.2);
        }
    });

    it('never mutates the shared tier constants (a resolved profile is a fresh object)', () => {
        const { profile } = resolveFabProfile({ minTraceWidthMm: 0.9 });
        expect(profile).not.toBe(FAB_TIERS.economy);
        expect(FAB_TIERS.economy.minTraceWidthMm).toBe(0.2);
    });

    it('drops a non-boolean gndPour instead of coercing it', () => {
        const { profile, adjustments } = resolveFabProfile({ gndPour: 'yes' });
        expect(profile.gndPour).toBe(true); // the tier default, not a truthy string
        expect(adjustments.join(' ')).toMatch(/gndPour/);
    });
});

describe('resolveFabProfile — per-net widths', () => {
    it('raises a per-net width below the board minimum (an unroutable rule, not a width)', () => {
        const { profile, adjustments } = resolveFabProfile({ perNetMinWidthMm: { GND: 0.05, VBUS: 0.8 } });
        expect(profile.perNetMinWidthMm).toEqual({ GND: 0.2, VBUS: 0.8 });
        expect(adjustments.join(' ')).toMatch(/GND/);
    });

    it('drops individually bad entries and keeps the good ones', () => {
        const { profile } = resolveFabProfile({ perNetMinWidthMm: { GND: 'wide', VBUS: 0.8 } });
        expect(profile.perNetMinWidthMm).toEqual({ VBUS: 0.8 });
    });

    it('ignores a non-object entirely rather than half-reading it', () => {
        const { profile, adjustments } = resolveFabProfile({ perNetMinWidthMm: [0.3] });
        expect(profile.perNetMinWidthMm).toBeUndefined();
        expect(adjustments).toHaveLength(1);
    });
});

describe('resolveFabProfile — the default caller', () => {
    it('an absent profile resolves to the documented economy default, complete', () => {
        const { profile, tier, adjustments } = resolveFabProfile();
        expect(tier).toBe('economy');
        expect(profile).toEqual(JLC_FAB_PROFILE);
        expect(adjustments).toEqual([]);
    });
});

/**
 * The IPC-2221 sizing boundary. A current that is not a positive finite number does NOT fail loudly — it
 * produces NaN, the envelope clamp cannot fire (every comparison with NaN is false), so `clamped` stays
 * false, no diagnostic is raised, and the net silently drops to the board's signal-floor width. A rail
 * declared at 2 A would ship as a 0.2 mm trace with nothing anywhere saying so, and KiCad DRC cannot
 * object because the board carries one global minimum width that the trace meets.
 */
describe('ipc2221WidthMm — what happens when the current is not a current', () => {
    it('sizes a real current above the signal floor', () => {
        const r = ipc2221WidthMm({ currentA: 2, copperOz: 1, deltaTC: 10 });
        expect(r.widthMm).toBeGreaterThan(0.2);
        expect(Number.isFinite(r.widthMm)).toBe(true);
    });

    it('produces a NaN width from a NaN current WITHOUT reporting it as clamped', () => {
        // This is the mechanism, pinned so it cannot be mistaken for safe behaviour: the function itself
        // cannot defend here (its clamp is numeric), which is exactly why the callers must refuse first.
        const r = ipc2221WidthMm({ currentA: Number.NaN, copperOz: 1, deltaTC: 10 });
        expect(Number.isNaN(r.widthMm)).toBe(true);
        expect(r.clamped).toBe(false);
        expect(r.notes).toEqual([]);
    });
});

/**
 * The shared measuring corner. Without it the gerbers and the position file each fell back to their own
 * default, which is how a delivered bundle came to have its placements exactly (+100, −100) mm from its
 * own copper — every board, every time, and nothing said a word.
 */
describe('marking one origin every exporter can read', () => {
    /** A board whose outline runs x 10…50, y 20…60 in KiCad coordinates (Y grows DOWNWARD). */
    const board = (extra = '') => `(kicad_pcb
  (setup
    (pad_to_mask_clearance 0)
  )${extra}
  (net 0 "")
  (gr_line (start 10 20) (end 50 20) (layer Edge.Cuts))
  (gr_line (start 50 20) (end 50 60) (layer Edge.Cuts))
  (gr_line (start 50 60) (end 10 60) (layer Edge.Cuts))
  (gr_line (start 10 60) (end 10 20) (layer Edge.Cuts))
)`;

    it('puts the origin at the board’s VISUAL lower-left, which is (minX, maxY) in board coordinates', () => {
        // The sign that matters. KiCad's Y grows downward while the gerber and position frames grow
        // upward, so the visually-bottom edge is the LARGEST y. Getting this backwards mirrors the board
        // about its own centre — a placement that still looks plausible and assembles wrong.
        const r = injectPlacementOrigin(board());
        expect(r.kind).toBe('ok');
        if (r.kind !== 'ok') throw new Error('unreachable');
        expect(r.originMm).toEqual({ x: 10, y: 60 });
        expect(r.kicadPcb).toContain('(aux_axis_origin 10 60)');
    });

    it('replaces an existing marker rather than adding a second one', () => {
        // Two origins is a file whose meaning depends on which one the reader picks up first.
        const once = injectPlacementOrigin(board());
        if (once.kind !== 'ok') throw new Error('unreachable');
        const twice = injectPlacementOrigin(once.kicadPcb);
        if (twice.kind !== 'ok') throw new Error('unreachable');
        expect(twice.kicadPcb.match(/aux_axis_origin/g)).toHaveLength(1);
        expect(twice.kicadPcb).toBe(once.kicadPcb);
    });

    it('opens a setup block when the board has none', () => {
        const noSetup = '(kicad_pcb\n  (net 0 "")\n  (gr_line (start 1 2) (end 3 4) (layer Edge.Cuts))\n)';
        const r = injectPlacementOrigin(noSetup);
        expect(r.kind).toBe('ok');
        if (r.kind !== 'ok') throw new Error('unreachable');
        expect(r.kicadPcb).toMatch(/\(setup\s+\(aux_axis_origin 1 4\)\s*\)/);
        expect(r.kicadPcb).toContain('(net 0 "")');
    });

    it('REFUSES rather than guessing when there is no outline', () => {
        // injectZone falls back to every coordinate in the file, which is safe for a pour (the filler
        // clips to the outline anyway). An origin derived from stray copper would silently move every
        // delivered coordinate instead — the exact failure this function exists to end.
        const noEdge =
            '(kicad_pcb\n  (setup\n  )\n  (net 0 "")\n  (segment (start 1 1) (end 2 2) (layer F.Cu) (net 1))\n)';
        expect(injectPlacementOrigin(noEdge).kind).toBe('no-outline');
    });

    it('leaves the rest of the board untouched', () => {
        const src = board();
        const r = injectPlacementOrigin(src);
        if (r.kind !== 'ok') throw new Error('unreachable');
        expect(r.kicadPcb.replace(/\n\s*\(aux_axis_origin [^)]*\)/, '')).toBe(src);
    });
});
