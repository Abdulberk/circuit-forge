/**
 * SPICE netlist import/export — the deterministic round-trip between CircuitJson and standard
 * SPICE text (the engineer persona's interchange format with LTspice/KiCad/ngspice decks).
 *
 * Import: eda-core's parseNetlist (standard SPICE elements; XSPICE/A-devices are out of its scope)
 * plus a schema validation of the parsed result, so the caller knows whether the circuit can be
 * loaded straight into the editor or needs review (warnings list what was skipped/approximated).
 *
 * Export: schema-validate -> attach vetted generic model bodies (QGENNPN, OPAMPGEN, the LED models,
 * etc. resolved by name, mirroring the simulation path) -> generateNetlist. The result is a
 * SELF-CONTAINED deck (models inlined) that runs in any ngspice.
 */
import {
    generateNetlist,
    parseNetlist,
    resolveGenericModels,
    safeValidateCircuitJson,
    safeValidateAnalysisConfig,
    type AnalysisConfig,
    type CircuitJson,
} from '@circuit-forge/eda-core';
import { BadRequestException, Injectable } from '@nestjs/common';

export interface ImportResult {
    circuit: CircuitJson;
    /** Analysis found in the deck (.tran/.ac/.dc/.op), when present. */
    analysis?: AnalysisConfig;
    title?: string;
    /** True when the parsed circuit passes the full CircuitJson schema (editor-loadable as-is). */
    schemaValid: boolean;
    /** Schema issues when schemaValid is false (path: message). */
    schemaIssues: string[];
    errors: string[];
    warnings: string[];
}

@Injectable()
export class NetlistService {
    import(netlist: string): ImportResult {
        const parsed = parseNetlist(netlist);
        const v = safeValidateCircuitJson(parsed.circuit);
        return {
            circuit: parsed.circuit,
            analysis: parsed.analysis,
            title: parsed.title,
            schemaValid: v.success,
            schemaIssues: v.success ? [] : v.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`),
            errors: parsed.errors,
            warnings: parsed.warnings,
        };
    }

    export(circuitJson: unknown, analysisConfig?: unknown, probes?: string[]): string {
        const v = safeValidateCircuitJson(circuitJson);
        if (!v.success) {
            const issues = v.error.errors
                .slice(0, 5)
                .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
                .join('; ');
            throw new BadRequestException(`circuitJson is not a valid circuit: ${issues}`);
        }
        const circuit = v.data as CircuitJson;
        if (circuit.components.length === 0) {
            throw new BadRequestException('circuitJson has no components — nothing to export.');
        }

        let analysis: AnalysisConfig = { type: 'op' };
        if (analysisConfig !== undefined) {
            const a = safeValidateAnalysisConfig(analysisConfig);
            if (!a.success) {
                throw new BadRequestException(
                    `analysisConfig is not a valid AnalysisConfig: ${a.error.errors[0]?.message ?? 'invalid'}`,
                );
            }
            analysis = a.data as AnalysisConfig;
        }

        // Self-contained deck: inline the vetted generic bodies referenced by name (same as the sim path).
        const extra = resolveGenericModels(circuit);
        if (extra.length > 0) circuit.models = [...(circuit.models ?? []), ...extra];

        try {
            return generateNetlist(circuit, analysis, probes && probes.length ? { probes } : undefined);
        } catch (e) {
            // generateNetlist fails loud on real authoring errors (unknown type, node collisions, no AC
            // source on an AC analysis, …) — surface them as a 400, they're caller-fixable.
            throw new BadRequestException(e instanceof Error ? e.message : String(e));
        }
    }
}
