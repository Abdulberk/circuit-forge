/**
 * Does the part we are ORDERING match the pads we are DRAWING?
 *
 * Every other check in this pipeline compares two views of our own data: our netlist against our board,
 * our footprint string against the geometry built from that same string. Each can be internally perfect
 * while the board is wrong, because both sides descend from one decision. The failure that survives all
 * of them is the one that kills an AI-designed board in the real world:
 *
 *   the model chose MPN X, we drew package Y, and X does not come in package Y.
 *
 * The board is DRC-clean, parity-perfect, every oracle green — and the part does not fit its pads. This
 * module is the cheapest check that looks at something OUTSIDE our own chain of reasoning: the part
 * number itself, which names a real object in the world that we did not invent.
 *
 * TWO ANSWERS, DELIBERATELY SEPARATE, because collapsing them is how a check becomes noise:
 *
 *   • PROVABLY WRONG — the part number itself names a package that contradicts the pads we resolved.
 *     `…QFN…` against a SOIC footprint, `0805` against 0603 pads. We are not guessing that this is bad;
 *     the two statements cannot both be true. That is an error and it withholds the board.
 *
 *   • UNVERIFIED — a specific manufacturer part is being ordered and its package was taken from our
 *     house default because the catalogue never told us. That is not evidence of a mistake, it is the
 *     absence of evidence, and it is reported as such. Making it an error would block essentially every
 *     AI-authored board on the day it shipped; making it silent is how a wrong package reaches a fab.
 *
 * NO FUZZY MATCHING, matching the stance the footprint resolver already takes: an unreadable part number
 * yields no verdict at all rather than a similarity score. A guess about someone's package that happens
 * to be wrong is worse than an honest "not checked", because it is indistinguishable from a real answer.
 */
import type { Component } from '@circuit-forge/eda-core';

import type { LayoutDiagnostic } from './layoutability';

/**
 * Imperial chip case codes, the vocabulary of passive packages.
 *
 * Only compared when BOTH sides speak it — an MPN case code against a resolved passive footprint. A
 * part number like `LM1206` would otherwise read as a 1206 case, and it is not a passive at all; the
 * type restriction is what keeps this from firing on a coincidence of digits.
 */
const CASE_CODES = ['0201', '0402', '0603', '0805', '1206', '1210', '1812', '2010', '2512'];

/**
 * Package families whose name appearing in a part number is a positive statement about its body.
 *
 * These are checked against a resolved SOIC/SOP footprint only. Every entry here is physically
 * incompatible with a SOIC of the same pin count — a WSON-8 is 2×2 mm on 0.5 mm pitch, a SOIC-8 is
 * 4.9×3.9 mm on 1.27 mm; the part does not overhang its pads, it sits in the middle of them touching
 * nothing. Families that ARE compatible spellings of the same body (SO, SOIC, SOP) are deliberately
 * absent: this list may only contain contradictions.
 */
const INCOMPATIBLE_WITH_SOIC = ['qfn', 'dfn', 'wson', 'uson', 'tssop', 'msop', 'vssop', 'qfp', 'bga', 'csp', 'sot'];

/**
 * Spellings of the SOIC body itself. Finding one of these next to SOIC pads is CONFIRMATION, not a
 * contradiction — the distinction matters because a part number that agrees with us is evidence, and
 * reporting it as "unverified" would bury the cases where we really do not know.
 */
const CONFIRMS_SOIC = ['soic', 'sop'];

export interface PackageAgreement {
    /** A contradiction we can prove from the part number itself. */
    contradiction?: { claimed: string; resolved: string };
    /** The part number itself agrees with the pads — evidence, from outside our own reasoning. */
    confirmed?: boolean;
    /** A real part is being ordered and nothing anywhere states its package. */
    unverified?: boolean;
}

/**
 * Compare the part number against the footprint we resolved.
 *
 * `source` matters as much as the strings: an EXPLICIT footprint came from the catalogue or the author
 * and is itself the evidence, so a default is the only case where we supplied the package ourselves.
 */
export function checkPackageAgreement(
    component: Pick<Component, 'type' | 'mpn' | 'footprint'>,
    resolved: { footprint: string; source: 'override' | 'default' },
): PackageAgreement {
    const mpn = (component.mpn ?? '').toLowerCase();
    if (!mpn) return {}; // a generic part: the house default IS the specification, nothing to disagree with

    const isPassive = component.type === 'resistor' || component.type === 'capacitor' || component.type === 'inductor';

    // Passives: both sides speak case codes, so a comparison between them is a real statement.
    if (isPassive && CASE_CODES.includes(resolved.footprint)) {
        const claimed = CASE_CODES.filter((code) => mpn.includes(code));
        // Exactly one code, or the check cannot tell which is the case and which is a coincidence —
        // `CRCW08051K00FKEA` carries 0805 alone, but a part number holding two of them is telling us
        // nothing we can act on, and acting anyway is the guess this module refuses to make.
        if (claimed.length === 1) {
            return claimed[0] === resolved.footprint
                ? { confirmed: true }
                : { contradiction: { claimed: claimed[0]!, resolved: resolved.footprint } };
        }
    }

    // ICs: a family name inside the part number against SOIC pads from the pin-count ladder.
    if (/^soi?c?\d+$/.test(resolved.footprint) || /^sop\d+$/.test(resolved.footprint)) {
        const family = INCOMPATIBLE_WITH_SOIC.find((f) => mpn.includes(f));
        if (family) return { contradiction: { claimed: family.toUpperCase(), resolved: resolved.footprint } };
        if (CONFIRMS_SOIC.some((f) => mpn.includes(f))) return { confirmed: true };
    }

    // No evidence either way. If we nevertheless supplied the package ourselves for a part someone will
    // physically order, say so — that is the honest shape of "this was not checked". An explicit
    // footprint needs no note: that value IS the statement about the package.
    return resolved.source === 'default' ? { unverified: true } : {};
}

/** Turn the comparison into diagnostics, at the two different severities it deserves. */
export function reportPackageAgreement(
    component: Component,
    resolved: { footprint: string; source: 'override' | 'default' },
    diagnostics: LayoutDiagnostic[],
): void {
    const verdict = checkPackageAgreement(component, resolved);

    if (verdict.contradiction) {
        diagnostics.push({
            code: 'PCB015',
            severity: 'error',
            componentId: component.id,
            message:
                `${component.designator}: the ordered part ${component.mpn} names a ${verdict.contradiction.claimed} ` +
                `package, but the board draws "${verdict.contradiction.resolved}" pads. Those are different ` +
                `physical parts — the component would not fit what it is soldered to. Set component.footprint ` +
                `to the real package, or order a part that comes in this one.`,
        });
        return;
    }

    if (verdict.unverified) {
        diagnostics.push({
            code: 'PCB016',
            severity: 'warning',
            componentId: component.id,
            message:
                `${component.designator}: ${component.mpn} will be ordered, but its package was not supplied — ` +
                `the board uses our default "${resolved.footprint}". That default is a house convention, not a ` +
                `fact about this part, so the pads are UNVERIFIED against its datasheet. Set component.footprint ` +
                `to confirm the package.`,
        });
    }
}
