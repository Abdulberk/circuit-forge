/**
 * Resource-cap regression tests (#7): bound a single simulation's OUTPUT rows (analysis point budget)
 * and the auto-generated probe width, so a careless/huge request can't drive a memory/IO/time runaway.
 */
import { generateNetlist } from '../src/netlist/generator';
import { analysisToSpice, MAX_SIM_POINTS } from '../src/types/analysis';
import type { TranAnalysis, AcAnalysis, DcAnalysis } from '../src/types/analysis';
// analysisToSpice now shares the ONE tolerant parser (utils/unit-parser); the file's old private throwing parser
// is gone. Read the numeric value the same way the generator does so the point-count assertions stay honest.
import type { CircuitJson, Component, Net } from '../src/types/circuit';
import { parseSpiceValue } from '../src/utils/unit-parser';

const num = (v: string) => parseSpiceValue(v).value;

describe('analysisToSpice point-budget clamping', () => {
    describe('tran', () => {
        it('leaves a reasonable transient untouched (100 points)', () => {
            const a: TranAnalysis = { type: 'tran', stopTime: '5m', stepTime: '50u' };
            expect(analysisToSpice(a)).toBe('.tran 50u 5m 0');
        });

        it('clamps a runaway tiny-step-over-long-stop to the point budget', () => {
            // 10s / 1ns = 1e10 points → step floored to ~10s / MAX_SIM_POINTS.
            const a: TranAnalysis = { type: 'tran', stopTime: '10', stepTime: '1n' };
            const step = analysisToSpice(a).split(/\s+/)[1]!;
            const points = num('10') / num(step);
            // Clamped to ~the budget (a small float tolerance on the formatted step), not the 1e10 runaway.
            expect(points).toBeLessThanOrEqual(MAX_SIM_POINTS * 1.001);
            expect(points).toBeGreaterThan(MAX_SIM_POINTS / 2); // clamped to the budget, not over-coarsened
        });

        it('passes an unparseable step through unchanged', () => {
            const a: TranAnalysis = { type: 'tran', stopTime: 'bogus', stepTime: 'alsobad' };
            expect(analysisToSpice(a)).toBe('.tran alsobad bogus 0');
        });

        // REGRESSION (arch-review debt #2): the file's OLD private parser THREW on any multiplier+unit token
        // ("10ms", "1ns") — values SpiceValueSchema accepts. Two concrete failures that are now fixed:
        it('does NOT crash on a unit-suffixed stopTime with no stepTime (derives a default step)', () => {
            // Before: calculateDefaultStep("10ms") → throwing parser → "Unknown SPICE suffix: ms" → generateNetlist
            // threw and verify reported "netlist generation failed". Now the default step is derived (stop/1000).
            const a: TranAnalysis = { type: 'tran', stopTime: '10ms' };
            expect(() => analysisToSpice(a)).not.toThrow();
            expect(analysisToSpice(a)).toBe('.tran 10u 10ms 0'); // 10ms/1000 = 10µs
        });

        it('actually CLAMPS a unit-suffixed runaway (guard was silently skipped when the parser threw)', () => {
            // Before: clampStepToPointBudget parsed "1ns"/"10ms" → threw → the catch swallowed it → step returned
            // UNCHANGED ("1ns") → 10ms/1ns = 1e7 rows sailed past the 1e6 budget. Now the guard fires.
            const a: TranAnalysis = { type: 'tran', stopTime: '10ms', stepTime: '1ns' };
            const step = analysisToSpice(a).split(/\s+/)[1]!;
            expect(step).not.toBe('1ns'); // the runaway step was floored, not emitted as-authored
            const points = num('10ms') / num(step);
            expect(points).toBeLessThanOrEqual(MAX_SIM_POINTS * 1.001);
            expect(points).toBeGreaterThan(MAX_SIM_POINTS / 2);
        });

        // Two concrete guard-bypass scenarios the adversarial review surfaced (both schema-valid):
        it('clamps a runaway whose step uses scientific-notation + a scale letter ("1e-4m")', () => {
            // "1e-4m" = 1e-7 s. Over stop 1 s that is 1e7 rows. The tolerant parser must parse it (superset of
            // the schema) so the clamp fires; a parser that rejected it would emit ".tran 1e-4m 1 0" (guard bypassed).
            const a: TranAnalysis = { type: 'tran', startTime: '0', stopTime: '1', stepTime: '1e-4m' };
            const step = analysisToSpice(a).split(/\s+/)[1]!;
            expect(step).not.toBe('1e-4m');
            expect(num('1') / num(step)).toBeLessThanOrEqual(MAX_SIM_POINTS * 1.001);
        });

        it('does not emit a 1000x-too-small clamped step when the floored mantissa rounds to 1000 ("999.99"/"1n")', () => {
            // 999.99 / MAX_SIM_POINTS ≈ 9.9999e-4 → formatSpiceValue mantissa 999.99 rounds to "1000". A buggy
            // strip made that "1u" (1e-6) → ~1e9 rows. The step must keep its value so the budget actually holds.
            const a: TranAnalysis = { type: 'tran', stopTime: '999.99', stepTime: '1n' };
            const step = analysisToSpice(a).split(/\s+/)[1]!;
            const points = num('999.99') / num(step);
            expect(points).toBeLessThanOrEqual(MAX_SIM_POINTS * 1.001);
            expect(points).toBeGreaterThan(MAX_SIM_POINTS / 2);
        });
    });

    describe('dc', () => {
        it('leaves a reasonable sweep untouched (50 points)', () => {
            const a: DcAnalysis = { type: 'dc', source: 'V1', startVal: '0', stopVal: '5', increment: '0.1' };
            expect(analysisToSpice(a)).toBe('.dc V1 0 5 0.1');
        });

        it('clamps a runaway tiny increment over a wide range', () => {
            // 0..1000 by 1u = 1e9 points → increment floored to bound rows.
            const a: DcAnalysis = { type: 'dc', source: 'V1', startVal: '0', stopVal: '1000', increment: '1u' };
            const inc = analysisToSpice(a).split(/\s+/)[4]!;
            const points = num('1000') / num(inc);
            expect(points).toBeLessThanOrEqual(MAX_SIM_POINTS);
        });
    });

    describe('ac', () => {
        it('leaves a reasonable points-per-decade untouched', () => {
            const a: AcAnalysis = { type: 'ac', variation: 'dec', points: 20, startFreq: '1', stopFreq: '1MEG' };
            expect(analysisToSpice(a)).toBe('.ac dec 20 1 1MEG');
        });

        it('caps an absurd points-per-decade at the budget', () => {
            const a: AcAnalysis = {
                type: 'ac',
                variation: 'dec',
                points: 999_999_999,
                startFreq: '1',
                stopFreq: '1MEG',
            };
            const pts = Number(analysisToSpice(a).split(/\s+/)[2]!);
            expect(pts).toBe(MAX_SIM_POINTS);
        });
    });
});

describe('default probe-width cap', () => {
    // Build a resistor ladder gnd-(V1)-n1-R1-n2-R2-...-n(N) → N non-ground nets → N default voltage probes.
    function ladder(nodeCount: number): CircuitJson {
        const components: Component[] = [
            {
                id: 'V1',
                type: 'voltage_source',
                designator: 'V1',
                value: 'DC 5',
                pins: [
                    { pinId: '+', netId: 'n1' },
                    { pinId: '-', netId: '0' },
                ],
            },
        ];
        for (let i = 1; i < nodeCount; i++) {
            components.push({
                id: `R${i}`,
                type: 'resistor',
                designator: `R${i}`,
                value: '1k',
                pins: [
                    { pinId: '1', netId: `n${i}` },
                    { pinId: '2', netId: `n${i + 1}` },
                ],
            });
        }
        const nets: Net[] = [{ id: '0', name: '0', isGround: true }];
        for (let i = 1; i <= nodeCount; i++) nets.push({ id: `n${i}`, name: `n${i}` });
        return { version: '1.0', components, nets };
    }

    function wrdataProbeCount(netlist: string): number {
        const line = netlist.split('\n').find((l) => l.includes('wrdata')) ?? '';
        return (line.match(/v\(/gi) ?? []).length;
    }

    const tran: TranAnalysis = { type: 'tran', stopTime: '1m', stepTime: '10u' };

    it('does not cap a normal circuit (probes all of a handful of nodes)', () => {
        const netlist = generateNetlist(ladder(8), tran); // 8 non-ground nets
        expect(wrdataProbeCount(netlist)).toBe(8);
    });

    it('caps the auto-probe width on a huge circuit', () => {
        const netlist = generateNetlist(ladder(120), tran); // 120 non-ground nets → capped
        expect(wrdataProbeCount(netlist)).toBe(64);
    });

    it('explicit/extra probes are NOT subject to the default cap', () => {
        // A caller-supplied probe list bypasses the auto-sweep cap entirely (verification is never starved).
        const explicit = Array.from({ length: 80 }, (_, i) => `v(n${i + 1})`);
        const netlist = generateNetlist(ladder(120), tran, { probes: explicit });
        expect(wrdataProbeCount(netlist)).toBe(80);
    });
});
