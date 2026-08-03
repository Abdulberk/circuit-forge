/**
 * The boundary check for caller-owned placements.
 *
 * SHAPE ONLY, deliberately. Whether a pin is legal — on the grid, on the board, not on top of another — is
 * geometry decided against the resolved fab profile, and none of that is known here. Re-deciding it at the
 * edge would be a second authority that eventually accepts what the engine refuses, which is the class of
 * defect this codebase keeps removing. So these tests are about the difference between "not a placement"
 * and "a placement we cannot evaluate yet", and about the one key that must be REJECTED rather than dropped.
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { FabProfileDto, FixedPlacementRecord } from './index';

const v = new FixedPlacementRecord();
const message = (value: unknown): string => v.defaultMessage({ value, property: 'fixedPlacements' } as never);

describe('what counts as a placement', () => {
    it('accepts a position with no rotation — "stay here, orient however routes best"', () => {
        expect(v.validate({ r1: { x: 12, y: -4 } })).toBe(true);
    });

    it('accepts every quarter turn and nothing else', () => {
        for (const rotation of [0, 90, 180, 270]) expect(v.validate({ r1: { x: 0, y: 0, rotation } })).toBe(true);
        expect(v.validate({ r1: { x: 0, y: 0, rotation: 45 } })).toBe(false);
        expect(message({ r1: { x: 0, y: 0, rotation: 45 } })).toMatch(/rotation: must be 0, 90, 180 or 270/);
    });

    it('accepts negative and fractional millimetres — the design frame has an origin in the middle', () => {
        expect(v.validate({ r1: { x: -7.5, y: 0.25 } })).toBe(true);
    });

    it('rejects a coordinate that is not a finite number, naming which one', () => {
        expect(v.validate({ r1: { x: '12', y: 0 } })).toBe(false);
        expect(message({ r1: { x: '12', y: 0 } })).toMatch(/r1\.x: not a number/);
        expect(v.validate({ r1: { x: Number.NaN, y: 0 } })).toBe(false);
        expect(v.validate({ r1: { y: 0 } })).toBe(false); // missing entirely
    });

    it('REJECTS side/layer rather than dropping it', () => {
        // Nothing in the chain can be told which side of the board a part goes on — the placement output is
        // {x, y, rotation} and the adapter emits no layer prop. Accepting the key would be accepting a value
        // we silently discard, and the caller would believe they had flipped a part.
        expect(v.validate({ r1: { x: 0, y: 0, side: 'bottom' } })).toBe(false);
        expect(message({ r1: { x: 0, y: 0, side: 'bottom' } })).toMatch(/cannot be told which side/);
        expect(v.validate({ r1: { x: 0, y: 0, layer: 'B.Cu' } })).toBe(false);
    });

    it('rejects an unknown field instead of ignoring it', () => {
        expect(v.validate({ r1: { x: 0, y: 0, locked: true } })).toBe(false);
        expect(message({ r1: { x: 0, y: 0, locked: true } })).toMatch(/r1\.locked: unknown field/);
    });

    it('rejects a value that is not a placement at all', () => {
        expect(v.validate({ r1: 12 })).toBe(false);
        expect(v.validate({ r1: [0, 0] })).toBe(false);
        expect(v.validate([{ x: 0, y: 0 }])).toBe(false);
        expect(v.validate('nope')).toBe(false);
    });

    it('accepts an empty record — pinning nothing is a legitimate request', () => {
        expect(v.validate({})).toBe(true);
    });

    it('does NOT judge geometry, which is the engine’s job', () => {
        // Off-grid, off-board and overlapping pins all pass here. They are refused by pcb-core against the
        // resolved profile's grid, margin and spacing — values this layer does not have. A shape check that
        // guessed at them would be a second authority.
        expect(v.validate({ r1: { x: 7.48, y: 99999 }, c1: { x: 7.48, y: 99999 } })).toBe(true);
    });

    it('names every problem at once, not just the first', () => {
        const bad = message({ r1: { x: 'a', y: 'b' }, c1: { x: 0, y: 0, rotation: 45 } });
        expect(bad).toMatch(/r1\.x/);
        expect(bad).toMatch(/r1\.y/);
        expect(bad).toMatch(/c1\.rotation/);
    });
});

/**
 * The fab-profile fields that were built and had no door.
 *
 * The global pipe runs `forbidNonWhitelisted`, so a field absent from `FabProfileDto` is a 400 rather than a
 * silently ignored option. That is the right default, and it is exactly why the gap was invisible: pcb-core
 * shipped 1/2/4 copper layers with 215 green tests and a passing harness, and `{"fabProfile":{"layers":4}}`
 * came back `property layers should not exist`. Measured against the running API, not assumed.
 *
 * These assertions run the REAL validation pipeline over the real DTO, so a field removed from the class
 * fails here rather than in production.
 */
describe('the fab profile options a caller can actually send', () => {
    const validate = async (fabProfile: Record<string, unknown>) => {
        const dto = plainToInstance(FabProfileDto, fabProfile);
        return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
    };

    it('accepts every layer count the toolchain builds, and refuses the rest', async () => {
        for (const layers of [1, 2, 4]) expect(await validate({ layers })).toEqual([]);
        for (const layers of [3, 6, 8]) {
            const errs = await validate({ layers });
            expect(errs).toHaveLength(1);
            // The message must name the allowed set — "invalid" alone leaves the caller guessing.
            expect(JSON.stringify(errs[0]!.constraints)).toMatch(/1, 2, 4/);
        }
    });

    it('accepts the silkscreen and via-clearance knobs pcb-core already honours', async () => {
        for (const field of ['minSilkWidthMm', 'minSilkTextHeightMm', 'viaClearanceMm', 'viaClearanceGuardMm']) {
            expect(await validate({ [field]: 0.15 })).toEqual([]);
            // …and still refuses a nonsense value rather than passing it to the design rules.
            expect(await validate({ [field]: -1 })).not.toEqual([]);
        }
    });

    it('accepts per-net minimum widths, and rejects a non-positive one', async () => {
        expect(await validate({ perNetMinWidthMm: { GND: 0.8 } })).toEqual([]);
        expect(await validate({ perNetMinWidthMm: { GND: 0 } })).not.toEqual([]);
    });

    it('still refuses a field nobody implemented, rather than accepting and dropping it', async () => {
        // The guard that made this gap visible in the first place, kept pointed the other way.
        expect(await validate({ stackupMaterial: 'FR4' })).not.toEqual([]);
    });
});
