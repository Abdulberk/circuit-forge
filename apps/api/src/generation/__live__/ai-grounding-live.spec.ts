/**
 * LIVE end-to-end proof of the full Flux-style flow: a REAL prompt -> the REAL AI (LLM_API_KEY) ->
 * native tool-use against the REAL TME catalog -> a grounded circuit -> server-attached sourcing ->
 * a SIMULATABLE netlist (and, if an ngspice binary is provided, a clean ngspice run).
 *
 * OPT-IN: runs only when AI_LIVE=1 AND real LLM + TME credentials are available (repo-root .env).
 * Skipped by default (makes real, paid LLM calls + hits the network).
 *
 *   AI_LIVE=1 pnpm --filter api test -- --runInBand ai-grounding-live
 *
 * For the FULL proof that the generated circuit actually simulates, also point NGSPICE_BIN at the
 * ngspice console binary (otherwise the netlist is only asserted well-formed, not run):
 *
 *   AI_LIVE=1 NGSPICE_BIN="C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe" \
 *     pnpm --filter api test -- --runInBand ai-grounding-live
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { ConfigService } from '@nestjs/config';
import { generateNetlist, type CircuitJson, type AnalysisConfig } from '@circuit-forge/eda-core';
import { GenerationService } from '../generation.service';
import { CatalogGroundingService } from '../catalog-grounding.service';
import { CircuitSimulatorService } from '../circuit-simulator.service';
import { PartsService } from '../../parts/parts.service';
import { TtlCache } from '../../parts/cache/ttl-cache';
import { ComponentMapper } from '../../parts/mappers/component-mapper';
import { TmeClient } from '../../parts/tme/tme-client';
import { TmeTokenCache } from '../../parts/tme/tme-token-cache';
import { TmeProvider } from '../../parts/provider/tme.provider';

const LIVE = process.env.AI_LIVE === '1';
const NGSPICE_BIN = process.env.NGSPICE_BIN;

/** Load real LLM + TME creds from the repo-root .env (overriding the fake test stubs). */
function loadRealEnv(): boolean {
    const have = () => !!(process.env.LLM_API_KEY && process.env.TME_TOKEN && process.env.TME_TOKEN !== 'test-tme-token');
    if (have()) return true;
    for (const p of [resolve(process.cwd(), '../../.env'), resolve(__dirname, '../../../../../.env')]) {
        try {
            const txt = readFileSync(p, 'utf8');
            for (const key of ['LLM_API_KEY', 'LLM_PROTOCOL', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_USER_AGENT', 'TME_TOKEN', 'TME_SECRET']) {
                const m = txt.match(new RegExp(`^${key}=(.+)$`, 'm'));
                if (m && m[1]) process.env[key] = m[1].trim();
            }
            if (have()) return true;
        } catch {
            /* try next */
        }
    }
    return false;
}

/** Assert the generated circuit netlists cleanly, and (when NGSPICE_BIN is set) that ngspice runs it. */
function assertSimulatable(circuit: CircuitJson, analysis: AnalysisConfig, label: string): void {
    // 1) The grounded, server-assembled circuit must produce a netlist without throwing.
    const netlist = generateNetlist(circuit, analysis);
    expect(netlist).toContain('* Components');

    if (!NGSPICE_BIN) {
        // eslint-disable-next-line no-console
        console.log(`[${label}] NGSPICE_BIN not set — netlist asserted well-formed but NOT run. Netlist:\n${netlist}`);
        return;
    }
    // 2) Full proof: run it through ngspice and assert no fatal solver error.
    const dir = mkdtempSync(join(tmpdir(), 'ai-live-'));
    const cir = join(dir, `${label}.cir`);
    writeFileSync(cir, netlist);
    let out = '';
    try {
        out = execFileSync(NGSPICE_BIN, ['-b', cir], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
        const err = e as { stdout?: string; stderr?: string };
        out = (err.stdout ?? '') + (err.stderr ?? '');
    }
    // eslint-disable-next-line no-console
    console.log(`[${label}] ngspice output (tail):\n${out.split('\n').slice(-25).join('\n')}`);
    expect(/singular matrix|Timestep too small|aborted|doAnalyses:|Unable to find|no such vector/i.test(out)).toBe(false);
}

(LIVE ? describe : describe.skip)('AI grounding LIVE e2e (real LLM + real TME)', () => {
    let gen: GenerationService;

    beforeAll(() => {
        if (!loadRealEnv()) throw new Error('AI_LIVE=1 but LLM_API_KEY / TME creds not found in env or .env');
        const config = new ConfigService();
        const parts = new PartsService(
            new TmeProvider(new TmeClient(config, new TmeTokenCache(config))),
            new TtlCache(),
            config,
            new ComponentMapper(),
        );
        gen = new GenerationService(config, new CatalogGroundingService(config, parts, new CircuitSimulatorService(config)));
    });

    jest.setTimeout(240_000);

    /** Shared assertions: a non-trivial circuit came back grounded in real, server-sourced catalog parts. */
    function expectGrounded(circuit: CircuitJson, label: string): void {
        expect(circuit.components.length).toBeGreaterThan(0);
        expect(circuit.nets.length).toBeGreaterThan(0);
        const grounded = circuit.components.filter((c) => c.mpn && c.sourcing);
        const summary = circuit.components.map((c) => ({
            designator: c.designator, type: c.type, value: c.value, model: c.model, mpn: c.mpn, sourcing: c.sourcing,
        }));
        // eslint-disable-next-line no-console
        console.log(`[${label}] grounded circuit:`, JSON.stringify(summary, null, 2));
        expect(grounded.length).toBeGreaterThan(0); // >=1 component picked from the LIVE catalog
        for (const c of grounded) {
            expect(c.sourcing!.supplier).toBe('tme');
            expect(c.sourcing!.supplierId).toBeTruthy();
        }
    }

    it('passive: RC low-pass — grounded in real parts, server-sourced, and simulatable', async () => {
        const result = await gen.generate({
            prompt: 'An RC low-pass filter with a 1 kHz cutoff, driven by a 5V source. Use standard parts.',
        } as never);
        expectGrounded(result.circuit, 'rc-lowpass');
        assertSimulatable(result.circuit, result.analysisConfig, 'rc-lowpass');
    });

    it('active: NPN common-emitter amplifier — grounded, model attached by name, and simulatable', async () => {
        const result = await gen.generate({
            prompt:
                'A single-stage NPN bipolar transistor common-emitter audio amplifier from a 12V supply, ' +
                'with voltage-divider base bias and an emitter resistor. Use a standard small-signal NPN.',
        } as never);
        expectGrounded(result.circuit, 'npn-amp');

        // The active device is present and the server attached its generic SPICE model BODY by name
        // (the AI emits only a vetted model name; the body must be injected so the circuit is self-contained).
        const active = result.circuit.components.find((c) => c.type === 'bjt' || c.type === 'mosfet');
        expect(active).toBeTruthy();
        expect(active!.model).toBeTruthy();
        const injected = result.circuit.models?.find((m) => m.name === active!.model);
        expect(injected).toBeTruthy();
        expect(injected!.body).toMatch(/\.model\s+\S+\s+(NPN|PNP|NMOS|PMOS)\(/i);

        assertSimulatable(result.circuit, result.analysisConfig, 'npn-amp');
    });

    it('digital: ripple counter from D flip-flops — AI emits digital primitives and it simulates cleanly', async () => {
        const result = await gen.generate({
            prompt:
                'A 3-bit asynchronous (ripple) binary counter built from D flip-flops, clocked at 1 MHz. ' +
                'Each stage toggles by feeding its own Q-bar back to its D input, and each stage is clocked ' +
                "by the previous stage's Q. Show the three count bits over time.",
        } as never);
        const digital = result.circuit.components.filter((c) => c.type === 'dff' || String(c.type).startsWith('logic_'));
        // eslint-disable-next-line no-console
        console.log(`[ripple-counter] analysis=${result.analysisConfig.type}; digital parts:`,
            digital.map((c) => `${c.designator}:${c.type}`).join(', ') || '(none)');
        // The prompt teaching worked: the AI reached for the digital vocabulary it now knows about.
        expect(digital.length).toBeGreaterThan(0);
        expect(digital.some((c) => c.type === 'dff')).toBe(true);
        // Digital primitives carry no value/model — the host supplies the XSPICE timing model.
        for (const c of digital) expect(c.model).toBeFalsy();
        // And the whole thing produces a valid netlist that ngspice runs without a fatal solver error.
        assertSimulatable(result.circuit, result.analysisConfig, 'ripple-counter');
    });
});
