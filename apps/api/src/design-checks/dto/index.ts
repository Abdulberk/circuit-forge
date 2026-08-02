import { safeValidateCircuitJson } from '@circuit-forge/eda-core';
import { ApiProperty } from '@nestjs/swagger';
import {
    IsObject,
    Validate,
    ValidatorConstraint,
    type ValidationArguments,
    type ValidatorConstraintInterface,
} from 'class-validator';

/**
 * The FULL circuit schema, not the draft's shape check — and the difference is deliberate.
 *
 * The working copy validates shape only, because a half-finished design is what an editor holds most of the
 * time and rejecting it would make typing impossible. A CHECK is different: ERC's answer about a circuit it
 * could not parse would be meaningless, and returning "passed: false, 0 issues" for a malformed body is the
 * worst possible outcome — it reads as a design verdict when it is a parse failure.
 *
 * So this is the same constraint POST /layouts uses. Refusing loudly, with the field named, is the only
 * honest response to input the checker cannot read.
 */
@ValidatorConstraint({ name: 'checkableCircuit', async: false })
export class IsCheckableCircuit implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        return safeValidateCircuitJson(value).success;
    }

    /**
     * STATELESS — class-validator reuses one instance across every request, so keeping the last failure on
     * `this` would let two concurrent callers read each other's field names.
     */
    defaultMessage(args: ValidationArguments): string {
        const parsed = safeValidateCircuitJson(args.value);
        const issues = parsed.success
            ? ''
            : parsed.error.issues
                  .slice(0, 5)
                  .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                  .join('; ');
        return `circuit is not a valid CircuitJson${issues ? ` — ${issues}` : ''}`;
    }
}

/** The document to check. Named `circuit` to match POST /layouts rather than inventing a third spelling. */
export class CheckCircuitDto {
    @ApiProperty({
        description: 'OUR CircuitJson — the design to check, saved or not',
        type: 'object',
        additionalProperties: true,
    })
    @IsObject()
    @Validate(IsCheckableCircuit)
    circuit!: Record<string, unknown>;
}
