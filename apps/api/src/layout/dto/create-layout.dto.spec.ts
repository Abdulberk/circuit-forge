/**
 * The fab-profile boundary, tested at the edge that actually runs in production.
 *
 * `fabProfile` used to be a free-form object: any key, any type, any value went straight into the job row,
 * out to the worker, and into the design rules the DRC notary judges the board against. A negative
 * clearance or a string width is not a slightly-wrong board — it is a board checked by a rulebook made of
 * nonsense, then shipped to a fab.
 *
 * These run the REAL global pipe configuration from main.ts (whitelist + forbidNonWhitelisted + transform),
 * not a hand-rolled validator, because the strictness is what is under test. A pipe configured differently
 * here would prove nothing about the deployed API.
 */
import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';

import { CreateLayoutDto } from './index';

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const meta: ArgumentMetadata = { type: 'body', metatype: CreateLayoutDto };

const circuit = { version: '1.0', components: [], nets: [] };
const run = (body: Record<string, unknown>) => pipe.transform({ circuit, ...body }, meta) as Promise<CreateLayoutDto>;

describe('CreateLayoutDto.fabProfile — accepts a real manufacturing choice', () => {
    it('takes a tier plus overrides and hands back a typed instance', async () => {
        const dto = await run({ fabProfile: { tier: 'standard', minTraceWidthMm: 0.3, gndPour: false } });
        expect(dto.fabProfile).toMatchObject({ tier: 'standard', minTraceWidthMm: 0.3, gndPour: false });
    });

    it('is optional — the overwhelmingly common request names no profile at all', async () => {
        const dto = await run({});
        expect(dto.fabProfile).toBeUndefined();
    });
});

describe('CreateLayoutDto.fabProfile — rejects what cannot be manufactured or understood', () => {
    // Each of these previously travelled all the way to the board's design rules.
    it.each([
        ['a negative clearance', { minClearanceMm: -0.2 }],
        ['a zero trace width', { minTraceWidthMm: 0 }],
        ['a numeric string', { minTraceWidthMm: '0.2' }],
        ['a boolean where a number belongs', { viaDrillMm: true }],
        ['a non-boolean pour flag', { gndPour: 'yes' }],
        ['an unknown fab tier', { tier: 'hdi-6-layer' }],
        ['an unknown key (a silent typo is worse than a 400)', { minTraceWidhtMm: 0.3 }],
    ])('rejects %s', async (_label, fabProfile) => {
        await expect(run({ fabProfile })).rejects.toThrow();
    });

    it('rejects a nested object rather than accepting it as a number', async () => {
        await expect(run({ fabProfile: { minClearanceMm: { mm: 0.2 } } })).rejects.toThrow();
    });

    it('rejects a scalar where the profile object belongs', async () => {
        await expect(run({ fabProfile: 'economy' })).rejects.toThrow();
    });
});

/**
 * netCurrentsA drives IPC-2221 per-net trace width. A value that is not a positive number does not fail
 * loudly downstream — it produces NaN, the envelope clamp cannot fire on NaN, no diagnostic is raised, and
 * the net simply routes at the board's signal-floor width. A rail declared at 2A would ship as a 0.2mm
 * trace, and DRC cannot object because the board carries one global minimum width that the trace meets.
 * So the only place this can be caught cheaply is here, at the edge, before it is ever persisted.
 */
describe('CreateLayoutDto.netCurrentsA — a current must be a current', () => {
    it('accepts a well-formed map', async () => {
        const dto = await run({ netCurrentsA: { GND: 2, VBUS: 1.5 } });
        expect(dto.netCurrentsA).toEqual({ GND: 2, VBUS: 1.5 });
    });

    it('is optional — most requests state no currents at all', async () => {
        await expect(run({})).resolves.toMatchObject({});
    });

    it.each([
        ['a unit-suffixed string', { VBUS: '2A' }],
        ['a numeric string', { VBUS: '2' }],
        ['a negative current', { VBUS: -1 }],
        ['zero', { VBUS: 0 }],
        ['null', { VBUS: null }],
        ['a nested object', { VBUS: {} }],
        ['a boolean', { VBUS: true }],
        ['an array value', { VBUS: [2] }],
        ['one bad entry among good ones', { GND: 2, VBUS: 'lots' }],
    ])('rejects %s', async (_label, netCurrentsA) => {
        await expect(run({ netCurrentsA })).rejects.toThrow();
    });

    it('rejects an array where the map belongs', async () => {
        await expect(run({ netCurrentsA: [2, 3] })).rejects.toThrow();
    });

    it('names the offending net in the error, so the caller can fix it', async () => {
        // The 400's detail lives on the exception's response payload, not its message — a caller staring at
        // "netCurrentsA is invalid" would have to guess which of twenty nets was wrong.
        const err = await run({ netCurrentsA: { GND: 2, VBUS: '2A' } }).then(
            () => null,
            (e: { response?: { message?: string[] } }) => e,
        );
        expect(JSON.stringify(err?.response?.message)).toMatch(/VBUS/);
    });
});
