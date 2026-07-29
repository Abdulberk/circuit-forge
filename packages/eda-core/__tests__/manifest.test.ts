/**
 * Scope manifest — the disclosure primitive. These tests lock the INVARIANT that an owned check is never
 * silently absent (it is always run / not-run / excluded), and that each producer fragment discloses exactly
 * its own checks with honest defaults. Pure functions — no mocks.
 */
import {
    buildManifest,
    buildElectricalScope,
    EXCLUDED_CHECKS,
    excludedEntries,
    buildLayoutScope,
    withCheck,
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

describe('withCheck — restating one check a later stage actually ran', () => {
    it('replaces exactly one entry, keeps the rest and the order untouched', () => {
        const m = buildManifest(['sim', 'erc', 'robustness'], { sim: { status: 'run' } });
        const after = withCheck(m, 'robustness', { status: 'run', detail: 'MC on the winner' });
        expect(after.checks.map((c) => c.id)).toEqual(['sim', 'erc', 'robustness']);
        expect(byId(after).get('robustness')).toEqual({
            id: 'robustness',
            status: 'run',
            detail: 'MC on the winner',
        });
        expect(byId(after).get('sim')!.status).toBe('run');
        expect(byId(after).get('erc')!.status).toBe('not-run');
        expect(byId(m).get('robustness')!.status).toBe('not-run'); // the input is not mutated
    });

    it('refuses a check the manifest does not own (a fragment cannot grow a foreign claim)', () => {
        const m = buildManifest(['sim'], { sim: { status: 'run' } });
        expect(() => withCheck(m, 'drc', { status: 'run' })).toThrow(/does not own/);
    });

    it('refuses to mark a check excluded with no registered reason', () => {
        // "excluded" with an empty detail reads as a considered decision while saying nothing — a more
        // convincing form of silence than silence. It must be impossible to emit by accident.
        expect(() => excludedEntries('drc')).toThrow(/no exclusion reason/);
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

    it('discloses the resistor-power + robustness reviews (checks that actually run must not be dropped)', () => {
        // default (no reports) → not-run, disclosed not omitted
        const off = byId(buildElectricalScope({ simRan: true, coveredDimensions: [] }));
        expect(off.get('stress.resistor-power')!.status).toBe('not-run');
        expect(off.get('robustness')!.status).toBe('not-run');
        // when they produced a result → run
        const on = byId(
            buildElectricalScope({
                simRan: true,
                coveredDimensions: [],
                resistorPower: { status: 'run', detail: 'resistor power vs rating' },
                robustness: { status: 'run', detail: 'corner robustness' },
            }),
        );
        expect(on.get('stress.resistor-power')!.status).toBe('run');
        expect(on.get('robustness')!.status).toBe('run');
    });

    it('the resistor-power check never speaks for the other two stress axes', () => {
        // The regression this pins: one id called "derating" that only measured resistor dissipation, whose
        // label promised capacitor voltage margin and current headroom too. Running it must not silence the
        // two axes nobody checks — they stay separately listed and separately not-run.
        const g = byId(
            buildElectricalScope({
                simRan: true,
                coveredDimensions: [],
                resistorPower: { status: 'run', detail: 'resistor power vs rating' },
            }),
        );
        expect(g.get('stress.voltage')!.status).toBe('not-run');
        expect(g.get('stress.current')!.status).toBe('not-run');
    });

    it('lists the domains we do not analyse as EXCLUDED with a stated reason', () => {
        // Absent is indistinguishable from passed. Thermal, EMI and compliance are out of scope by decision,
        // so they carry the decision and its reason instead of being left out of the list.
        const g = byId(buildElectricalScope({ simRan: true, coveredDimensions: [] }));
        for (const id of ['thermal', 'emi', 'compliance'] as const) {
            expect(g.get(id)!.status).toBe('excluded');
            expect(g.get(id)!.detail).toBeTruthy();
            expect(EXCLUDED_CHECKS[id]).toBeTruthy();
        }
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
