import { safeValidateCircuitJson } from '@circuit-forge/eda-core';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsObject,
    IsOptional,
    IsIn,
    IsUUID,
    IsNumber,
    IsPositive,
    IsBoolean,
    ValidateNested,
    Validate,
    ValidatorConstraint,
    type ValidatorConstraintInterface,
    type ValidationArguments,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/**
 * Every value of a `Record<string, number>` must be a positive finite number.
 *
 * `@IsObject()` alone checks the container and never looks inside, so a declared `Record<string, number>`
 * happily carried `"2A"`, `{}` or `-1` all the way to the sink. The consequence was not a crash but
 * something worse: the IPC-2221 sizing produced NaN, its envelope clamp could not fire (every comparison
 * with NaN is false), so no diagnostic was raised and the net simply routed at the board's signal-floor
 * width. A rail the caller declared at 2 A shipped as a 0.2 mm trace, and DRC could not object because the
 * board carries a single global minimum width that the trace meets.
 *
 * Rejecting at the edge is the cheap half; pcb-core also refuses the value defensively, for callers that
 * are not this HTTP endpoint (worker replays, rows written before this constraint existed).
 */
/**
 * Fixed placements, checked at the boundary for SHAPE only.
 *
 * Whether a pin is legal — on the grid, on the board, not on top of another — is geometry, and it is
 * decided by `validateFixedPlacements` in pcb-core against the profile's grid, margin and spacing. None of
 * those are known here, and re-deciding them at the edge would be a second authority that eventually
 * accepts what the engine refuses. So this rejects only what is not a placement at all.
 *
 * `side`/`layer` is rejected EXPLICITLY rather than stripped. Nothing in the chain can be told which side of
 * the board a part goes on — the placement output is `{x, y, rotation}` and the adapter emits no layer prop
 * — so accepting the key would be accepting a value we silently drop, which is the failure this codebase
 * keeps removing.
 */
@ValidatorConstraint({ name: 'fixedPlacementRecord', async: false })
export class FixedPlacementRecord implements ValidatorConstraintInterface {
    private static problems(value: unknown): string[] {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['must be an object'];
        const bad: string[] = [];
        for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
            if (typeof at !== 'object' || at === null || Array.isArray(at)) {
                bad.push(`${id}: not a placement`);
                continue;
            }
            const p = at as Record<string, unknown>;
            for (const axis of ['x', 'y']) {
                if (typeof p[axis] !== 'number' || !Number.isFinite(p[axis])) bad.push(`${id}.${axis}: not a number`);
            }
            if (p.rotation !== undefined && ![0, 90, 180, 270].includes(p.rotation as number))
                bad.push(`${id}.rotation: must be 0, 90, 180 or 270`);
            for (const unsupported of ['side', 'layer']) {
                if (p[unsupported] !== undefined)
                    bad.push(
                        `${id}.${unsupported}: not supported — the pipeline cannot be told which side a part goes on, so this would be accepted and dropped`,
                    );
            }
            for (const key of Object.keys(p)) {
                if (!['x', 'y', 'rotation'].includes(key) && !['side', 'layer'].includes(key))
                    bad.push(`${id}.${key}: unknown field`);
            }
        }
        return bad;
    }

    validate(value: unknown): boolean {
        return FixedPlacementRecord.problems(value).length === 0;
    }

    defaultMessage(args: ValidationArguments): string {
        const bad = FixedPlacementRecord.problems(args.value);
        return `${args.property} must map each componentId to {x, y, rotation?} in millimetres (${bad.join('; ')})`;
    }
}

@ValidatorConstraint({ name: 'positiveNumberRecord', async: false })
export class PositiveNumberRecord implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
        return Object.values(value as Record<string, unknown>).every(
            (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
        );
    }

    defaultMessage(args: ValidationArguments): string {
        const value = args.value as Record<string, unknown> | undefined;
        const bad =
            value && typeof value === 'object' && !Array.isArray(value)
                ? Object.entries(value)
                      .filter(([, v]) => typeof v !== 'number' || !Number.isFinite(v) || v <= 0)
                      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                : [];
        return `${args.property} must map each net to a positive finite number${bad.length ? ` (rejected: ${bad.join(', ')})` : ''}`;
    }
}

/**
 * Manufacturing overrides on top of a named fab tier.
 *
 * Closed on purpose. This used to be a free-form object, so an unknown key was accepted silently and a
 * value like `-1` or `"thin"` travelled all the way into the board's design rules — which are the rules
 * the DRC notary then judged the board against. Every field is bounded here, and pcb-core's resolver
 * completes and clamps whatever survives, so an override can only ever make the board EASIER to build
 * than the tier it names. Choosing a finer process is done by naming a finer `tier`, which carries a
 * price, not by typing a smaller number.
 */
export class FabProfileDto {
    @ApiPropertyOptional({
        description: "Fab capability tier — the published limits overrides are judged against (default 'economy')",
        enum: ['economy', 'standard', 'advanced'],
    })
    @IsOptional()
    @IsIn(['economy', 'standard', 'advanced'])
    tier?: 'economy' | 'standard' | 'advanced';

    @ApiPropertyOptional({ description: 'Minimum trace width (mm); raised to the tier limit if finer' })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    minTraceWidthMm?: number;

    @ApiPropertyOptional({ description: 'Minimum copper clearance (mm); raised to the tier limit if finer' })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    minClearanceMm?: number;

    @ApiPropertyOptional({ description: 'Via drill diameter (mm); raised to the tier limit if finer' })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    viaDrillMm?: number;

    @ApiPropertyOptional({ description: 'Via annular ring width (mm); raised to the tier limit if finer' })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    viaAnnularMm?: number;

    @ApiPropertyOptional({ description: 'Copper weight (oz) for IPC-2221 trace-width sizing (default 1)' })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    copperOz?: number;

    @ApiPropertyOptional({ description: 'Allowed trace temperature rise (°C) for IPC-2221 sizing (default 10)' })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    deltaTC?: number;

    @ApiPropertyOptional({ description: 'Pour a ground plane on the bottom layer when a GND net exists' })
    @IsOptional()
    @IsBoolean()
    gndPour?: boolean;

    @ApiPropertyOptional({ description: 'Placement grid (mm, default 0.5)' })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    placementGridMm?: number;

    @ApiPropertyOptional({ description: 'Keep-back from the board edge for part courtyards (mm, default 4)' })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    placementMarginMm?: number;

    /**
     * These six were built in pcb-core and had no door.
     *
     * The global pipe runs `forbidNonWhitelisted`, so a field absent from this class is a 400 rather than a
     * silently ignored option — which is the right default and the reason the gap was invisible: pcb-core's
     * tests passed, its harness passed, and `{"fabProfile":{"layers":4}}` came back
     * `property layers should not exist`. A capability nobody can reach is not a capability, and this is the
     * third time in a week that shape has been shipped.
     */
    @ApiPropertyOptional({
        description:
            'Copper layers: 1, 2 or 4. Any other count is REFUSED rather than delivered — the board toolchain ' +
            'silently produces 2 for anything it does not recognise, so an 8-layer request would return a ' +
            '2-layer board and someone would order the wrong stackup.',
        enum: [1, 2, 4],
    })
    @IsOptional()
    @IsIn([1, 2, 4])
    layers?: 1 | 2 | 4;

    @ApiPropertyOptional({
        description:
            'Narrowest silkscreen stroke the fab will PRINT (mm, default 0.15). Below its floor a fab DELETES ' +
            'the legend rather than rejecting the board, so a board can arrive with no reference designators.',
    })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    minSilkWidthMm?: number;

    @ApiPropertyOptional({
        description:
            'Shortest silkscreen character worth printing (mm, default 0.8). Raised automatically when the ' +
            'requested stroke needs a taller glyph to render at that width.',
    })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    minSilkTextHeightMm?: number;

    @ApiPropertyOptional({ description: 'Explicit clearance around vias (mm). Normally omit — it is derived.' })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    viaClearanceMm?: number;

    @ApiPropertyOptional({
        description:
            'Fixed guard added to the minimum clearance for vias (mm, default 0.10). Raise it if a dense board ' +
            'still trips a via↔track clearance.',
    })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    viaClearanceGuardMm?: number;

    @ApiPropertyOptional({
        description:
            'Minimum trace width per EMITTED net name (mm). Merged with the widths computed from netCurrentsA; ' +
            'the wider of the two wins. Every value must be a positive finite number.',
        type: 'object',
        additionalProperties: { type: 'number' },
    })
    @IsOptional()
    @IsObject()
    @Validate(PositiveNumberRecord)
    perNetMinWidthMm?: Record<string, number>;
}

/**
 * The circuit really is OUR CircuitJson — checked, not asserted by the type annotation.
 *
 * `@IsObject()` accepts any JSON, so the space this endpoint quantified over was "any object", not
 * CircuitJson. The consequence was measured: `{"components": null}` reached pcb-core and died as
 * `circuit.nets is not iterable`, and that internal TypeError became the customer-visible `errorMessage`
 * on a FAILED job — a job that was queued, dispatched to a worker and charged against a quota before
 * anyone looked at the payload.
 *
 * The schema already existed (`CircuitJsonSchema`, with its own caps: ≤1000 components, 1..64 pins,
 * footprint ≤50 chars) and simply was not applied anywhere server-side — ERC runs client-side only. This
 * applies it at the edge, where a bad payload costs a 400 instead of a worker slot.
 */
@ValidatorConstraint({ name: 'isCircuitJson', async: false })
export class IsCircuitJson implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        return safeValidateCircuitJson(value).success;
    }

    /**
     * STATELESS, like PositiveNumberRecord beside it. class-validator reuses one constraint instance
     * across every request, so stashing the last failure on `this` would let two concurrent callers see
     * each other's field names. Re-validating here costs one parse on the error path only.
     */
    defaultMessage(args: ValidationArguments): string {
        const parsed = safeValidateCircuitJson(args.value);
        const issues = parsed.success
            ? ''
            : parsed.error.issues
                  .slice(0, 5)
                  .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                  .join('; ');
        // Naming the field is the whole reason this beats the crash it replaces: the old failure mode was
        // an internal TypeError persisted as the customer's errorMessage.
        return `circuit is not a valid CircuitJson${issues ? ` — ${issues}` : ''}`;
    }
}

/**
 * Start a PCB layout job. `circuit` is OUR CircuitJson (topology: components + nets) — the same shape
 * pcb-core's layoutCircuit consumes. Layout options are optional and default to pcb-core's own defaults.
 */
export class CreateLayoutDto {
    @ApiProperty({
        description: 'OUR CircuitJson (components + nets) to lay out',
        type: 'object',
        additionalProperties: true,
    })
    @IsObject()
    @Validate(IsCircuitJson)
    circuit!: Record<string, unknown>;

    @ApiPropertyOptional({
        description:
            "Tag this layout to a saved circuit version. When set, the job is created under that version's org, " +
            'stores its project + version, and can be re-found via GET /layouts?versionId= after a reload. Omit for an ad-hoc layout of an unsaved circuit.',
        format: 'uuid',
    })
    @IsOptional()
    @IsUUID()
    versionId?: string;

    @ApiPropertyOptional({
        description:
            'Organization this layout belongs to. Only for ad-hoc layouts (no versionId) — with a versionId ' +
            "the org comes authoritatively from that version's project, and supplying a conflicting one is " +
            'rejected. Omit to use your first organization, which is echoed back in the response.',
        format: 'uuid',
    })
    @IsOptional()
    @IsUUID()
    orgId?: string;

    @ApiPropertyOptional({
        description:
            "Placement engine. Omit for the default: 'auto' (connectivity-aware, floor-guaranteed — it is only adopted when it beats the grid). 'grid' forces the deterministic connectivity-blind grid; 'rust' uses the out-of-process optimized engine.",
        enum: ['grid', 'auto', 'rust'],
    })
    @IsOptional()
    @IsIn(['grid', 'auto', 'rust'])
    placer?: 'grid' | 'auto' | 'rust';

    @ApiPropertyOptional({ description: 'Fab tier + manufacturing overrides', type: FabProfileDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => FabProfileDto)
    fabProfile?: FabProfileDto;

    @ApiPropertyOptional({
        description:
            'RMS current (A) per emitted net name → IPC-2221 per-net trace width. Every value must be a positive finite number.',
        type: 'object',
        additionalProperties: { type: 'number' },
    })
    @IsOptional()
    @IsObject()
    @Validate(PositiveNumberRecord)
    netCurrentsA?: Record<string, number>;

    @ApiPropertyOptional({
        description:
            'Component positions to KEEP, keyed by componentId, in millimetres in the design frame — the same ' +
            'frame `result.layout.components[].x/y` reports, so reading a layout out and sending edited ' +
            'positions back in is the identity. Rotation is optional and quarter-turn only; omitting it means ' +
            '"stay here, orient however routes best". Fixed means fixed: a set that cannot all be honoured ' +
            '(off-grid, past the board edge, or two pinned courtyards overlapping) is refused with the remedy ' +
            'named, rather than partly applied. Positions are NOT relative to the board edge — the outline is ' +
            're-centred on its content between runs, so compute an edge distance against the board you are ' +
            'showing. A `side`/`layer` key is rejected: nothing in the pipeline can be told which side a part ' +
            'goes on, and accepting one would be accepting a value we silently drop.',
        type: 'object',
        additionalProperties: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' }, rotation: { enum: [0, 90, 180, 270] } },
            required: ['x', 'y'],
        },
    })
    @IsOptional()
    @IsObject()
    @Validate(FixedPlacementRecord)
    fixedPlacements?: Record<string, { x: number; y: number; rotation?: 0 | 90 | 180 | 270 }>;
}

/**
 * List layout jobs for the caller's org(s), newest first, optionally narrowed to one version or project.
 * The client uses `?versionId=` to re-hydrate the PCB tab for a saved circuit after a page reload.
 */
export class ListLayoutsQueryDto extends PaginationQueryDto {
    @ApiPropertyOptional({ description: 'Only layouts tagged to this saved circuit version', format: 'uuid' })
    @IsOptional()
    @IsUUID()
    versionId?: string;

    @ApiPropertyOptional({ description: 'Only layouts tagged to this project', format: 'uuid' })
    @IsOptional()
    @IsUUID()
    projectId?: string;
}
