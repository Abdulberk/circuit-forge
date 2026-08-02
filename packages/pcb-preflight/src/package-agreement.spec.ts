/**
 * The only check in the pipeline that looks outside our own chain of reasoning.
 *
 * The scenario under test is the one that survives every other gate: the model names a real part, we draw
 * a package it does not come in, and the board is DRC-clean, parity-perfect and completely unbuildable.
 * The part numbers below are real ones — a TI WSON regulator, a YAGEO 0805 resistor — because the whole
 * value of this check is that it reads a string describing an object we did not invent.
 */
import type { Component } from '@circuit-forge/eda-core';

import type { LayoutDiagnostic } from './layoutability';
import { checkPackageAgreement, reportPackageAgreement } from './package-agreement';

const part = (over: Partial<Component>): Component =>
    ({ id: 'c1', designator: 'U1', type: 'subckt', pins: [], ...over }) as Component;

const report = (component: Component, footprint: string, source: 'override' | 'default'): LayoutDiagnostic[] => {
    const d: LayoutDiagnostic[] = [];
    reportPackageAgreement(component, { footprint, source }, d);
    return d;
};

describe('what we order versus what we draw', () => {
    it('CATCHES a QFN part number drawn on SOIC pads — the board nobody else would have caught', () => {
        // A WSON-8 is 2×2 mm on 0.5 mm pitch; a SOIC-8 is 4.9×3.9 mm on 1.27 mm. The part does not
        // overhang its pads — it sits in the middle of them touching nothing. Every other check passes.
        const d = report(part({ mpn: 'TPS62162DSGT-WSON', type: 'subckt' }), 'soic8', 'default');
        expect(d).toHaveLength(1);
        expect(d[0]!.code).toBe('PCB015');
        expect(d[0]!.severity).toBe('error'); // withholds the board — it cannot be assembled
        expect(d[0]!.message).toMatch(/WSON/);
        expect(d[0]!.message).toMatch(/soic8/);
    });

    it('catches an 0805 part number drawn on 0603 pads', () => {
        const d = report(part({ mpn: 'CRCW08051K00FKEA', type: 'resistor' }), '0603', 'default');
        expect(d[0]!.code).toBe('PCB015');
        expect(d[0]!.message).toMatch(/0805/);
    });

    it('says nothing when the part number and the pads agree', () => {
        expect(report(part({ mpn: 'RC0603FR-0710KL', type: 'resistor' }), '0603', 'default')).toEqual([]);
    });

    it('treats agreement as CONFIRMATION, not as an unchecked guess', () => {
        // The distinction the first version of this module got wrong. `RC0603FR-0710KL` on 0603 pads was
        // reported as "package unverified" because the footprint came from our default — but the part
        // number itself says 0603, which is evidence from outside our own reasoning. Calling that
        // unverified would bury the cases where we genuinely do not know under ones where we do.
        expect(
            checkPackageAgreement(
                { type: 'resistor', mpn: 'RC0603FR-0710KL' },
                { footprint: '0603', source: 'default' },
            ),
        ).toEqual({
            confirmed: true,
        });
        expect(
            checkPackageAgreement({ type: 'subckt', mpn: 'NE555-SOIC' }, { footprint: 'soic8', source: 'default' }),
        ).toEqual({
            confirmed: true,
        });
    });

    it('does not read a case code out of an IC part number — LM1206 is not a 1206 chip resistor', () => {
        // The restriction that makes this check safe: case codes are only compared when BOTH sides speak
        // that vocabulary. Without it, any part number containing four digits becomes a false failure.
        expect(
            checkPackageAgreement({ type: 'subckt', mpn: 'LM1206' }, { footprint: 'soic8', source: 'default' }),
        ).toEqual({ unverified: true });
    });

    it('refuses to decide when a part number carries TWO case codes', () => {
        // Telling which is the case and which is a coincidence would be a guess, and a guess that reads
        // like a verdict is worse than an honest silence.
        const v = checkPackageAgreement(
            { type: 'capacitor', mpn: 'GRM0603X7R1206K' },
            { footprint: '0603', source: 'default' },
        );
        expect(v.contradiction).toBeUndefined();
    });

    it('treats SOIC/SOP/SO as the SAME body, not a contradiction', () => {
        // The incompatible list may only contain contradictions. A part number saying SOIC on SOIC pads
        // must never fire, or the check gets switched off within a week.
        expect(report(part({ mpn: 'NE555-SOIC8', type: 'subckt' }), 'soic8', 'override')).toEqual([]);
    });
});

describe('ordering a specific part whose package we were never told', () => {
    it('reports the package as UNVERIFIED — evidence absent, not evidence of a fault', () => {
        const d = report(part({ mpn: 'NE555P', type: 'subckt' }), 'soic8', 'default');
        expect(d).toHaveLength(1);
        expect(d[0]!.code).toBe('PCB016');
        // Warning, NOT error. Every AI-authored board names parts, and few carry a package field yet;
        // an error here blocks the product on its first day, which is how a real check gets deleted.
        expect(d[0]!.severity).toBe('warning');
        expect(d[0]!.message).toMatch(/UNVERIFIED/);
        expect(d[0]!.message).toMatch(/NE555P/);
    });

    it('says nothing once the package IS supplied — that footprint is the evidence', () => {
        expect(report(part({ mpn: 'NE555P', footprint: 'SOIC-8', type: 'subckt' }), 'soic8', 'override')).toEqual([]);
    });

    it('says nothing about a generic part with no part number', () => {
        // A 10k resistor with no MPN is not ordered as a specific object — the house default IS the
        // specification, and there is nothing for it to disagree with.
        expect(report(part({ type: 'resistor' }), '0603', 'default')).toEqual([]);
    });

    it('reports a contradiction INSTEAD of the unverified note, never both', () => {
        // Two diagnostics for one fact would double-count in any summary that counts them.
        const d = report(part({ mpn: 'ADS1115IDGSR-MSOP', type: 'subckt' }), 'soic8', 'default');
        expect(d).toHaveLength(1);
        expect(d[0]!.code).toBe('PCB015');
    });
});
