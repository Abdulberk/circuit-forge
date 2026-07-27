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
