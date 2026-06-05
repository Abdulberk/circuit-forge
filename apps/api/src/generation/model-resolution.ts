/**
 * Inject the bodies of any built-in generic models the circuit references by name (e.g. a bjt with
 * model="QGENNPN"). The AI/mapper only ever picks a vetted model NAME — never invents a body — so the
 * server attaches the actual `.model` card here, before the netlist is generated. Idempotent.
 */
import { resolveGenericModels, type CircuitJson } from '@circuit-forge/eda-core';

export function attachGenericModels(circuit: CircuitJson): void {
    const extra = resolveGenericModels(circuit);
    if (extra.length > 0) {
        circuit.models = [...(circuit.models ?? []), ...extra];
    }
}
