/**
 * Conservation laws — the PURE half.
 *
 * The rule every one of them shares: NOTHING IS LOST OR INVENTED SILENTLY. A pin either reaches a pad or
 * its loss is declared at error severity; a footprint pad is either wired or declared not-connected; a
 * claim's denominator is the input's pin count, never a set that has already lost members.
 *
 * WHY ONLY HALF LIVES HERE. Most of these laws need the real pad-count oracle, and that is footprinter —
 * an ESM-only package this package's jest transpiles to CommonJS and cannot load. That is not a gap: it is
 * the split jest.config.js already documents ("tests exercise the PURE modules; the live eval/route
 * integration runs in the script harness instead"). The oracle-dependent cases are LOCKED, with the real
 * library, in `scripts/pcb-invariants.mjs --assert`, which also enumerates the whole (component type ×
 * footprint string) product at ~0.09 ms per case. Both run in CI.
 *
 * What is left here needs no oracle at all — and is no less load-bearing for it.
 */
import type { CircuitJson } from '@circuit-forge/eda-core';
import { classifyCircuit } from '@circuit-forge/pcb-preflight';

describe('I-IDENTITY — the delivered bundle must be assemblable', () => {
    /**
     * Two parts both called R1 produce a BOM listing R1 twice and a pick-and-place file listing R1 and
     * R1_2 — the adapter uniquifies the emitted name while the BOM writes the raw designator. An assembly
     * house receives a bundle whose two files disagree about what to place.
     *
     * Measured before this check existed: ok=true, zero diagnostics. Nothing in the pipeline looked —
     * ERC is client-side only, and the API stores the circuit without applying its own schema.
     */
    const twoR1 = {
        version: '1.0',
        components: [
            {
                id: 'a',
                type: 'resistor',
                designator: 'R1',
                value: '1k',
                footprint: '0603',
                pins: [
                    { pinId: '1', netId: 'n0' },
                    { pinId: '2', netId: 'gnd' },
                ],
            },
            {
                id: 'b',
                type: 'resistor',
                designator: 'R1',
                value: '2k',
                footprint: '0603',
                pins: [
                    { pinId: '1', netId: 'n0' },
                    { pinId: '2', netId: 'gnd' },
                ],
            },
            { id: 'gnd1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
        ],
        nets: [
            { id: 'gnd', name: 'GND', isGround: true },
            { id: 'n0', name: 'N0' },
        ],
    } as unknown as CircuitJson;

    it('a duplicate designator is an error, not a silent rename', () => {
        const result = classifyCircuit(twoR1);
        expect(result.diagnostics.some((d) => d.code === 'PCB014' && d.severity === 'error')).toBe(true);
        expect(result.layoutable).toBe(false);
    });

    it('distinct designators pass — the check is about collision, not about count', () => {
        const ok = {
            ...twoR1,
            components: [twoR1.components[0]!, { ...twoR1.components[1]!, designator: 'R2' }, twoR1.components[2]!],
        } as CircuitJson;
        const result = classifyCircuit(ok);
        expect(result.diagnostics.some((d) => d.code === 'PCB014')).toBe(false);
    });
});

describe('the pad-accounting checks announce themselves when they cannot run', () => {
    /**
     * Without an injected oracle the accounting cannot happen — and the one thing it must not do is pass
     * quietly. A board that was never accounted for and a board that accounts perfectly must not produce
     * the same result, which is the failure mode this whole family of checks exists to end.
     */
    it('no oracle -> an explicit "did not run" diagnostic, and no NC number invented', () => {
        const circuit = {
            version: '1.0',
            components: [
                {
                    id: 'u1',
                    type: 'resistor',
                    designator: 'R1',
                    value: '1k',
                    footprint: 'SOIC-8',
                    pins: [
                        { pinId: '1', netId: 'n0' },
                        { pinId: '2', netId: 'gnd' },
                    ],
                },
                { id: 'gnd1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
            ],
            nets: [
                { id: 'gnd', name: 'GND', isGround: true },
                { id: 'n0', name: 'N0' },
            ],
        } as unknown as CircuitJson;
        const result = classifyCircuit(circuit); // deliberately no padCount
        expect(result.plans.find((p) => p.component.id === 'u1')!.ncPinCount).toBeUndefined();
        expect(result.diagnostics.some((d) => d.code === 'PCB006' && /did not run/i.test(d.message))).toBe(true);
    });
});
