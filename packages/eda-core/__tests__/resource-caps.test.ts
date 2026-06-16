/**
 * Resource-cap regression tests (#7): bound a single simulation's OUTPUT rows (analysis point budget)
 * and the auto-generated probe width, so a careless/huge request can't drive a memory/IO/time runaway.
 */
import { analysisToSpice, parseSpiceValue, MAX_SIM_POINTS } from '../src/types/analysis';
import type { TranAnalysis, AcAnalysis, DcAnalysis } from '../src/types/analysis';
import { generateNetlist } from '../src/netlist/generator';
import type { CircuitJson, Component, Net } from '../src/types/circuit';

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
            const points = parseSpiceValue('10') / parseSpiceValue(step);
            // Clamped to ~the budget (a small float tolerance on the formatted step), not the 1e10 runaway.
            expect(points).toBeLessThanOrEqual(MAX_SIM_POINTS * 1.001);
            expect(points).toBeGreaterThan(MAX_SIM_POINTS / 2); // clamped to the budget, not over-coarsened
        });

        it('passes an unparseable step through unchanged', () => {
            const a: TranAnalysis = { type: 'tran', stopTime: 'bogus', stepTime: 'alsobad' };
            expect(analysisToSpice(a)).toBe('.tran alsobad bogus 0');
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
            const points = parseSpiceValue('1000') / parseSpiceValue(inc);
            expect(points).toBeLessThanOrEqual(MAX_SIM_POINTS);
        });
    });

    describe('ac', () => {
        it('leaves a reasonable points-per-decade untouched', () => {
            const a: AcAnalysis = { type: 'ac', variation: 'dec', points: 20, startFreq: '1', stopFreq: '1MEG' };
            expect(analysisToSpice(a)).toBe('.ac dec 20 1 1MEG');
        });

        it('caps an absurd points-per-decade at the budget', () => {
            const a: AcAnalysis = { type: 'ac', variation: 'dec', points: 999_999_999, startFreq: '1', stopFreq: '1MEG' };
            const pts = Number(analysisToSpice(a).split(/\s+/)[2]!);
            expect(pts).toBe(MAX_SIM_POINTS);
        });
    });
});

describe('default probe-width cap', () => {
    // Build a resistor ladder gnd-(V1)-n1-R1-n2-R2-...-n(N) → N non-ground nets → N default voltage probes.
    function ladder(nodeCount: number): CircuitJson {
        const components: Component[] = [
            { id: 'V1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [
                { pinId: '+', netId: 'n1' },
                { pinId: '-', netId: '0' },
            ] },
        ];
        for (let i = 1; i < nodeCount; i++) {
            components.push({
                id: `R${i}`, type: 'resistor', designator: `R${i}`, value: '1k', pins: [
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
