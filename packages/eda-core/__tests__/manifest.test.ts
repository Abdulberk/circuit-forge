/**
 * Scope manifest — the disclosure primitive. These tests lock the INVARIANT that an owned check is never
 * silently absent (it is always run / not-run / excluded), and that each producer fragment discloses exactly
 * its own checks with honest defaults. Pure functions — no mocks.
 */
import {
    buildManifest,
    buildElectricalScope,
    buildLayoutScope,
    CHECK_IDS,
    CHECK_LABELS,
    type CheckId,
} from '../src/verification/manifest';

const byId = (m: { checks: { id: CheckId; status: string; gradation?: string; detail?: string }[] }) =>
    new Map(m.checks.map((c) => [c.id, c]));

describe('buildManifest — the disclosure invariant', () => {
    it('emits EVERY owned check; ones not determined default to not-run (never silently absent)', () => {
        const m = buildManifest(['sim', 'erc', 'decoupling'], { sim: { status: 'run' } });
        const g = byId(m);
        expect(m.checks).toHaveLength(3);
        expect(g.get('sim')!.status).toBe('run');
        expect(g.get('erc')!.status).toBe('not-run'); // owned but undetermined → disclosed as not-run
        expect(g.get('decoupling')!.status).toBe('not-run');
    });

    it('only lists the OWNED checks — a fragment never claims checks it does not own', () => {
        const m = buildManifest(['drc'], { drc: { status: 'run' } });
        expect(m.checks.map((c) => c.id)).toEqual(['drc']);
    });

    it('carries gradation + detail through when determined', () => {
        const m = buildManifest(['decoupling'], {
            decoupling: { status: 'run', gradation: 'presence', detail: 'cap present' },
        });
        expect(byId(m).get('decoupling')).toEqual({
            id: 'decoupling',
            status: 'run',
            gradation: 'presence',
            detail: 'cap present',
        });
    });

    it('every CheckId has a human label (registry + labels can never drift)', () => {
        for (const id of CHECK_IDS) expect(CHECK_LABELS[id]).toBeTruthy();
    });
});

describe('buildElectricalScope — the /verify-design fragment', () => {
    it('discloses assertion COVERAGE per dimension and marks the rest not-run', () => {
        const m = buildElectricalScope({ simRan: true, coveredDimensions: ['voltage', 'current'] });
        const g = byId(m);
        expect(g.get('sim')!.status).toBe('run');
        expect(g.get('erc')!.status).toBe('run');
        expect(g.get('assertion.voltage')!.status).toBe('run');
        expect(g.get('assertion.current')!.status).toBe('run');
        expect(g.get('assertion.frequency')!.status).toBe('not-run'); // not covered
        expect(g.get('assertion.thd')!.status).toBe('not-run');
    });

    it('discloses decoupling as not-run with the DEFERRAL reason (no power-rail marking), polarity not-run by default', () => {
        const g = byId(buildElectricalScope({ simRan: true, coveredDimensions: [] }));
        expect(g.get('decoupling')!.status).toBe('not-run');
        expect(g.get('decoupling')!.detail).toMatch(/deferred|power-rail marking/i);
        expect(g.get('polarity')!.status).toBe('not-run');
    });

    it('discloses the derating + robustness reviews (checks that actually run must not be dropped)', () => {
        // default (no reports) → not-run, disclosed not omitted
        const off = byId(buildElectricalScope({ simRan: true, coveredDimensions: [] }));
        expect(off.get('derating')!.status).toBe('not-run');
        expect(off.get('robustness')!.status).toBe('not-run');
        // when they produced a result → run
        const on = byId(
            buildElectricalScope({
                simRan: true,
                coveredDimensions: [],
                derating: { status: 'run', detail: 'resistor power vs rating' },
                robustness: { status: 'run', detail: 'corner robustness' },
            }),
        );
        expect(on.get('derating')!.status).toBe('run');
        expect(on.get('robustness')!.status).toBe('run');
    });

    it('a skipped simulation is disclosed as sim not-run (never implies it ran)', () => {
        expect(byId(buildElectricalScope({ simRan: false, coveredDimensions: [] })).get('sim')!.status).toBe('not-run');
    });

    it('accepts a determined decoupling entry (forward-compat with the detector slice)', () => {
        const g = byId(
            buildElectricalScope({
                simRan: true,
                coveredDimensions: [],
                decoupling: { status: 'run', gradation: 'presence' },
            }),
        );
        expect(g.get('decoupling')).toMatchObject({ status: 'run', gradation: 'presence' });
    });

    it('does NOT list layout-only checks (drc/manufacturability) — those belong to the layout fragment', () => {
        const ids = buildElectricalScope({ simRan: true, coveredDimensions: [] }).checks.map((c) => c.id);
        expect(ids).not.toContain('drc');
        expect(ids).not.toContain('manufacturability');
        expect(ids).not.toContain('connectivity-parity');
    });
});

describe('buildLayoutScope — the /layouts fragment', () => {
    it('reports drc + manufacturability + connectivity with clean detail', () => {
        const g = byId(
            buildLayoutScope({
                parityPins: { checked: 17, expected: 17 },
                drcClean: true,
                drcViolations: 0,
                manufacturable: true,
            }),
        );
        expect(g.get('drc')).toMatchObject({ status: 'run' });
        expect(g.get('drc')!.detail).toMatch(/DRC-clean/);
        expect(g.get('manufacturability')!.detail).toMatch(/delivered/);
        expect(g.get('connectivity-parity')!.detail).toBe('17/17 pins isomorphic');
    });

    it('an un-manufacturable board discloses the withheld bundle + violation count', () => {
        const g = byId(buildLayoutScope({ drcClean: false, drcViolations: 27, manufacturable: false }));
        expect(g.get('drc')!.detail).toMatch(/27 rule violation/);
        expect(g.get('manufacturability')!.detail).toMatch(/withheld/);
    });

    it('lists exactly its three owned checks (no decoupling/polarity leakage)', () => {
        const ids = buildLayoutScope({ drcClean: true, drcViolations: 0, manufacturable: true })
            .checks.map((c) => c.id)
            .sort();
        expect(ids).toEqual(['connectivity-parity', 'drc', 'manufacturability']);
    });
});
