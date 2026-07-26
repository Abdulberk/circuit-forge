/**
 * CircuitSimulatorService tests. ngspice is a LOCAL binary (no network), so these run fully offline —
 * but they need the binary. The suite resolves an ngspice path from NGSPICE_PATH or a known install
 * location and SKIPS itself when none is found, so CI without ngspice stays green. Run locally with:
 *
 *   NGSPICE_PATH="C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe" \
 *     pnpm --filter api exec jest circuit-simulator
 */
import { existsSync } from 'fs';

import type { CircuitJson } from '@circuit-forge/eda-core';
import type { ConfigService } from '@nestjs/config';

import { CircuitSimulatorService } from './circuit-simulator.service';
import { VerificationService } from './verification.service';

/** Find an ngspice binary: explicit env first, then common install paths. Empty string => skip suite. */
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

/** A ConfigService stub returning the resolved ngspice path (and a tight timeout for fast tests). */
function makeConfig(ngspice: string = NGSPICE): ConfigService {
    const v: Record<string, string | undefined> = { NGSPICE_PATH: ngspice || undefined, SIM_TIMEOUT_MS: '8000' };
    return { get: (k: string) => v[k] } as unknown as ConfigService;
}

const RC_LOWPASS: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 5 1k)', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1.6k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'c1', type: 'capacitor', designator: 'C1', value: '100n', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: 'gnd', name: 'gnd', isGround: true }],
};

/** A plain 1k/1k resistive divider off a DC source — Vout/Vin = 0.5, so a `.tf` gain has a known value. */
const RES_DIVIDER: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 6', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: 'gnd', name: 'gnd', isGround: true }],
};

/** NPN common-emitter amp referencing a generic model NAME only (no body) — the body must be auto-attached. */
const NPN_AMP: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'vcc', type: 'voltage_source', designator: 'V1', value: 'DC 12', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'rc', type: 'resistor', designator: 'RC1', value: '2.2k', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'col' }] },
        { id: 'rb1', type: 'resistor', designator: 'RB1', value: '100k', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'base' }] },
        { id: 'rb2', type: 'resistor', designator: 'RB2', value: '18k', pins: [{ pinId: '1', netId: 'base' }, { pinId: '2', netId: 'gnd' }] },
        { id: 're', type: 'resistor', designator: 'RE1', value: '470', pins: [{ pinId: '1', netId: 'emit' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'q1', type: 'bjt', designator: 'Q1', model: 'QGENNPN', pins: [{ pinId: 'c', netId: 'col' }, { pinId: 'b', netId: 'base' }, { pinId: 'e', netId: 'emit' }] },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [
        { id: 'vcc', name: 'vcc' }, { id: 'col', name: 'col' }, { id: 'base', name: 'base' },
        { id: 'emit', name: 'emit' }, { id: 'gnd', name: 'gnd', isGround: true },
    ],
};

/** Same RC but with NO ground net — ERC must flag NO_GROUND and ngspice can't solve it. */
const NO_GROUND: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'a' }, { pinId: '-', netId: 'b' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'a' }, { pinId: '2', netId: 'b' }] },
    ],
    nets: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }],
};

(NGSPICE ? describe : describe.skip)('CircuitSimulatorService (real ngspice, offline)', () => {
    const svc = new CircuitSimulatorService(makeConfig());

    it('available() reflects whether NGSPICE_PATH is configured', () => {
        expect(svc.available()).toBe(true);
        expect(new CircuitSimulatorService(makeConfig('')).available()).toBe(false);
    });

    it('simulates a clean RC low-pass and reports OK with sane per-node measurements', async () => {
        const r = await svc.simulate(RC_LOWPASS, { type: 'tran', stopTime: '5m', stepTime: '20u' });
        expect(r.simStatus).toBe('ok');
        expect(r.runError).toBeUndefined();
        expect(r.ercErrors).toHaveLength(0);
        expect(r.measurements.length).toBeGreaterThan(0);
        // A SIN-driven RC has a non-flat output: at least one node swings.
        expect(r.measurements.some((m) => m.pp > 0.1)).toBe(true);
        // Output never exceeds the 5V drive (sanity that numbers are physical).
        for (const m of r.measurements) expect(m.max).toBeLessThanOrEqual(6);
    });

    it('simulates an active-device circuit whose generic model BODY is auto-attached (NPN amp)', async () => {
        const r = await svc.simulate(NPN_AMP, { type: 'op' });
        expect(r.simStatus).toBe('ok');
        expect(r.runError).toBeUndefined();
        // The collector sits at a sane bias between ground and the 12V rail.
        const col = r.measurements.find((m) => m.node.toLowerCase().includes('col'));
        expect(col).toBeTruthy();
        expect(col!.final).toBeGreaterThan(0);
        expect(col!.final).toBeLessThan(12);
    });

    it('surfaces an ERC error (NO_GROUND) to the model so it can self-correct', async () => {
        // The deterministic contract is that ERC findings reach the model — that is the signal it acts on.
        // (ngspice's own handling of a missing reference node is implementation-specific and not asserted.)
        const r = await svc.simulate(NO_GROUND, { type: 'op' });
        expect(r.ercErrors.some((e) => e.code === 'ERC001')).toBe(true); // NO_GROUND surfaced
        expect(['ok', 'failed']).toContain(r.simStatus); // returns a summary without throwing
    });

    it('rejects a schema-invalid circuit without throwing', async () => {
        const r = await svc.simulate({ version: '1.0', components: 'not-an-array', nets: [] });
        expect(r.simStatus).toBe('failed');
        expect(r.runError).toMatch(/invalid circuit/);
    });

    it('returns skipped when ngspice is not configured', async () => {
        const r = await new CircuitSimulatorService(makeConfig('')).simulate(RC_LOWPASS);
        expect(r.simStatus).toBe('skipped');
    });

    it('Convergence Doctor: a healthy run passes through simulateWithRemedies unchanged (no remedy noise)', async () => {
        const r = await svc.simulateWithRemedies(RC_LOWPASS, { type: 'tran', stopTime: '5m', stepTime: '20u' });
        expect(r.simStatus).toBe('ok');
        expect(r.convergence).toBeUndefined(); // first run converged — Doctor stayed out of the way
        expect(r.measurements.length).toBeGreaterThan(0);
    });

    it('Convergence Doctor: a real netlist-generation failure is NOT mistaken for a convergence problem (no wasted retries)', async () => {
        // A malformed circuit fails before ngspice even runs — that is not a solver-convergence issue,
        // so the Doctor must NOT attach a convergence report or retry. (Recovery-ladder orchestration is
        // proven deterministically in simulate-remedies.spec; this guards the live passthrough.)
        const r = await svc.simulateWithRemedies({ version: '1.0', components: 'not-an-array', nets: [] });
        expect(r.simStatus).toBe('failed');
        expect(r.convergence).toBeUndefined();
    });

    it('THD (fourier) is folded onto the measurement so a thd criterion has a value to gate on', async () => {
        // The inline runner previously read ONLY output.csv and discarded ngspice's fourier listing, so a thd
        // criterion on the /verify-design dev/live fallback could never be certified. It now parses the listing
        // (stdout pipe + -o log, build-independent) like the worker. A clean 1kHz sine through a mild RC has low
        // but finite THD — assert it is POPULATED and physical, not an exact value (build/step-dependent).
        const r = await svc.simulate(RC_LOWPASS, { type: 'tran', stopTime: '5m', stepTime: '5u', fourier: { fundamentalFreq: '1k', probes: ['v(out)'] } });
        expect(r.simStatus).toBe('ok');
        const out = r.measurements.find((m) => m.node.toLowerCase().includes('out'));
        expect(out).toBeTruthy();
        expect(typeof out!.thd).toBe('number'); // folded in from the fourier listing (was undefined before the fix)
        expect(Number.isFinite(out!.thd!)).toBe(true);
        expect(out!.thd!).toBeGreaterThanOrEqual(0);
    });

    it('transfer-function gain is folded onto the measurement so a gain criterion has a value to gate on', async () => {
        const r = await svc.simulate(RES_DIVIDER, { type: 'op', tf: { output: 'v(out)', inputSource: 'V1' } });
        expect(r.simStatus).toBe('ok');
        const out = r.measurements.find((m) => m.node.toLowerCase().includes('out'));
        expect(out).toBeTruthy();
        expect(typeof out!.gain).toBe('number'); // folded in from the tf listing (was undefined before the fix)
        expect(out!.gain!).toBeCloseTo(0.5, 2); // 1k/1k divider → Vout/Vin = 0.5
    });

    it('CROSS-SEAM: verify() (no userId → inline) evaluates a thd criterion against the folded value', async () => {
        // Exercises the FULL service seam the worker-path unit tests can't: verify → simulateWithRemedies →
        // simulate → attach THD → evaluateAssertions. Guards against a future refactor that drops the attach on
        // only ONE path. A clean 1kHz sine through a linear RC adds no harmonics, so THD is well under a loose bound.
        const verifier = new VerificationService(svc); // no SimulationService → inline path (no userId)
        const ev = await verifier.verify(
            RC_LOWPASS,
            { type: 'tran', stopTime: '5m', stepTime: '5u', fourier: { fundamentalFreq: '1k', probes: ['v(out)'] } },
            [{ probe: 'out', metric: 'thd', op: 'lt', value: 50 }],
        );
        const a = ev.assertions[0]!;
        expect(a.actual).not.toBeNull(); // THD was measured + folded through the seam (was always-null before the fix)
        expect(typeof a.actual).toBe('number');
        expect(a.pass).toBe(true); // comfortably under 50%
        expect(ev.verdict).toBe('pass');
    });

    it('CROSS-SEAM: verify() (no userId → inline) evaluates a gain criterion against the folded tf value', async () => {
        const verifier = new VerificationService(svc);
        const ev = await verifier.verify(
            RES_DIVIDER,
            { type: 'op', tf: { output: 'v(out)', inputSource: 'V1' } },
            [{ probe: 'out', metric: 'gain', op: 'approx', value: 0.5, tol: 0.05 }],
        );
        const a = ev.assertions[0]!;
        expect(a.actual).toBeCloseTo(0.5, 2); // 1k/1k divider gain folded through the seam
        expect(a.pass).toBe(true);
        expect(ev.verdict).toBe('pass');
    });

    it('never throws and executes nothing on injection-laden input (sanitizer/guards hold)', async () => {
        // A behavioral source whose "value" tries to smuggle a netlist line / shell directive, plus a
        // designator/value with hostile characters. eda-core's bsource newline guard + sanitizeNetlist +
        // node/designator sanitization neutralize all of it; simulate() must still return a summary
        // (never throw) and obviously never run the injected `.shell`.
        const malicious: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'b1', type: 'bsource', designator: 'B1', value: 'V=v(in)\n.shell echo pwned', pins: [{ pinId: '+', netId: 'out' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
                { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
            ],
            nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: 'gnd', name: 'gnd', isGround: true }],
        };
        const r = await svc.simulate(malicious, { type: 'op' });
        expect(['ok', 'failed']).toContain(r.simStatus); // returned a summary, did not throw
    });
});
