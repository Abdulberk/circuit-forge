/**
 * Versions DTOs
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsObject, Validate } from 'class-validator';

import { HasCircuitShape, IsUiJson } from '../../working-copy/dto';

export class CreateVersionDto {
    /**
     * The permanent record was the weakest-validated write in the application.
     *
     * `@IsObject()` alone accepted `{"nope": true}` with a 201 and stored it verbatim — and there is no
     * DELETE route for a version, so it stayed. The THROWAWAY draft beside it was stricter, which is exactly
     * backwards: a draft is overwritten on the next keystroke, a version is history that other things point
     * at. The same shape check now guards both.
     */
    @ApiProperty({ description: 'Circuit JSON (canonical format)' })
    @IsObject()
    @Validate(HasCircuitShape)
    circuitJson!: Record<string, unknown>;

    @ApiProperty({ description: 'UI JSON (layout information)' })
    @IsObject()
    @Validate(IsUiJson)
    uiJson!: Record<string, unknown>;
}
