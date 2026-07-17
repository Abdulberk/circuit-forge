/**
 * The manufacturability gate — the single authority for whether a laid-out board may be delivered as
 * fab-ready and called "manufacturable".
 *
 * WHY this exists (17 Tem 2026): the pipeline used to mark EVERY completed job SUCCEEDED and ship the full
 * gerber/BOM/PnP bundle regardless of the DRC verdict — including the local-router fallback board whose
 * undersized vias fail KiCad's annular_width rule. A user could therefore download and fabricate a board
 * that KiCad DRC had already rejected. That directly falsifies the product's "verified / manufacturable"
 * claim. This gate closes both holes at the delivery boundary: the SUCCEEDED-regardless path AND the
 * local-router fallback, because both end at the same final DRC report.
 *
 * A board is manufacturable ONLY when the final KiCad DRC (run at --severity-error against the ordered fab
 * rules) finds zero rule violations AND zero unconnected nets. That is exactly `ParsedDrc.clean`; this
 * helper turns it into an explicit verdict + a human reason, kept pure so it is unit-testable on real DRC
 * reports without standing up the worker/DB/S3.
 *
 * NOTE ON STATUS: manufacturability is NOT the job status. A completed analysis of a flawed board is still
 * a completed job (status SUCCEEDED) — surfacing it as FAILED would conflate a legitimate design outcome
 * with a pipeline crash and pollute ops alerting. The verdict lives in `result.manufacturable`, and the
 * physical safety comes from withholding the fab bundle (there is nothing fab-ready to download).
 */
import type { ParsedDrc } from '@circuit-forge/pcb-core';

export interface ManufacturabilityVerdict {
    /** True only when the final DRC is clean (0 violations AND 0 unconnected) — the gate for the fab bundle. */
    manufacturable: boolean;
    violations: number;
    unrouted: number;
    /** Null when manufacturable; otherwise a one-line, user-facing explanation of why the bundle is withheld. */
    reason: string | null;
}

export function assessManufacturability(parsed: ParsedDrc): ManufacturabilityVerdict {
    const violations = parsed.violations.length;
    const unrouted = parsed.unconnected.length;
    const manufacturable = violations === 0 && unrouted === 0;
    const reason = manufacturable
        ? null
        : `Board is not manufacturable: ${violations} DRC violation(s)` +
          (unrouted ? ` and ${unrouted} unrouted net(s)` : '') +
          ' against the ordered fab rules — the fab-ready bundle is withheld until the board is DRC-clean.';
    return { manufacturable, violations, unrouted, reason };
}
