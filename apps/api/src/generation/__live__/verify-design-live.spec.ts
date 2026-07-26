/**
 * VerificationService end-to-end against REAL ngspice (offline, local binary). Proves the Verified
 * Designs evidence pack: ERC + ngspice + measured-vs-requested spec assertions → pass/fail verdict.
 * Skips when no ngspice binary is found (CI stays green). Run locally with:
 *
 *   NGSPICE_PATH="C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe" \
 *     pnpm --filter api exec jest verify-design-live
 */
import { existsSync } from 'fs';

import type { CircuitJson } from '@circuit-forge/eda-core';
import type { ConfigService } from '@nestjs/config';

import { CircuitSimulatorService } from '../circuit-simulator.service';
import type { AssertionDto } from '../dto';
import { VerificationService } from '../verification.service';

function resolveNgspice(): string {
    if (process.env.NGSPICE_PATH && existsSync(process.env.NGSPICE_PATH)) return process.env.NGSPICE_PATH;
    const candidates = [
        'C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe',
        '/usr/bin/ngspice',
        '/usr/local/bin/ngspice',
        '/opt/homebrew/bin/ngspice',
    ];
    return candidates.find((p) => existsSync(p)) ?? '';
}

const NGSPICE = resolveNgspice();
const makeConfig = (ngspice = NGSPICE): ConfigService =>
    ({ get: (k: string) => (({ NGSPICE_PATH: ngspice || undefined, SIM_TIMEOUT_MS: '8000' }) as Record<string, string | undefined>)[k] }) as unknown as ConfigService;

/** 10V DC across two equal 1k resistors → v(out) = 5.0V exactly at the operating point. */
const DIVIDER: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 10', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: 'gnd', name: 'gnd', isGround: true }],
};

const NO_GROUND: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'a' }, { pinId: '-', netId: 'b' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'a' }, { pinId: '2', netId: 'b' }] },
    ],
    nets: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }],
};

const A = (probe: string, metric: AssertionDto['metric'], op: AssertionDto['op'], value: number, tol?: number): AssertionDto =>
    ({ probe, metric, op, value, ...(tol !== undefined ? { tol } : {}) });

(NGSPICE ? describe : describe.skip)('VerificationService (real ngspice, offline)', () => {
    const svc = new VerificationService(new CircuitSimulatorService(makeConfig()));

    it('PASS: a 10V/1k/1k divider verified to settle at 5V with the right rails', async () => {
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [
            A('out', 'final', 'approx', 5.0, 0.1), // measured ~5V
            A('out', 'max', 'lte', 10), // never exceeds the rail
            A('out', 'min', 'gte', 0), // never below ground
        ]);
        expect(ev.simStatus).toBe('ok');
        expect(ev.verdict).toBe('pass');
        expect(ev.checks).toEqual({ total: 3, passed: 3, failed: 0 });
        const out = ev.measurements.find((m) => m.node.toLowerCase().includes('out'));
        expect(out!.final).toBeGreaterThan(4.9);
        expect(out!.final).toBeLessThan(5.1);
    });

    it('FAIL: the same real circuit fails a wrong spec (claimed 9V), with measured evidence attached', async () => {
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 9.0, 0.1)]);
        expect(ev.simStatus).toBe('ok'); // the sim ran fine...
        expect(ev.verdict).toBe('fail'); // ...but the design does not meet the (wrong) spec
        expect(ev.assertions[0]!.actual).toBeGreaterThan(4.9); // real measured value reported, not the target
        expect(ev.assertions[0]!.pass).toBe(false);
    });

    it('FAIL: a circuit with an ERC error (no ground) is not verified', async () => {
        const ev = await svc.verify(NO_GROUND, { type: 'op' }, []);
        expect(ev.verdict).toBe('fail');
        expect(ev.erc.errors.some((e) => e.code === 'ERC001')).toBe(true);
    });

    it('POWER: reports per-resistor dissipation from the real simulation (≈25mW each on the divider)', async () => {
        const ev = await svc.verify(DIVIDER, { type: 'op' }, []);
        // No assertions → 'inconclusive' (a spec-less run is not "verified"); the power report is independent.
        expect(ev.verdict).toBe('inconclusive');
        expect(ev.power).toBeDefined();
        expect(ev.power!.basis).toBe('operating-point');
        const r1 = ev.power!.components.find((c) => c.designator === 'R1')!;
        const r2 = ev.power!.components.find((c) => c.designator === 'R2')!;
        // 10V / 1k / 1k → 5V mid; each resistor drops 5V → P = 5²/1000 = 25 mW.
        expect(r1.dissipationW).toBeCloseTo(0.025, 3);
        expect(r2.dissipationW).toBeCloseTo(0.025, 3);
        expect(ev.power!.anyOverRating).toBe(false); // 25mW << 0.25W default
    });
});
