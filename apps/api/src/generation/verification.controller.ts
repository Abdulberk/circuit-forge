/**
 * Verified Designs controller — deterministic, simulation-backed circuit verification.
 */
import { Controller, Post, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { safeValidateCircuitJson, safeValidateAnalysisConfig, type AnalysisConfig } from '@circuit-forge/eda-core';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { VerificationService, isCurrentProbe, type DesignEvidence } from './verification.service';
import { VerifyDesignDto } from './dto';

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class VerificationController {
    constructor(private readonly verification: VerificationService) {}

    @Post('verify-design')
    // ERC + ngspice (delegated to the worker queue) + spec assertions. Server-side-polls the job so the
    // response stays synchronous. Throttled like the AI generate route.
    @Throttle({ default: { limit: 10, ttl: 60000 } })
    @ApiOperation({
        summary: 'Verify a circuit by simulation: ERC + ngspice + spec assertions → a pass/fail evidence pack',
    })
    @ApiResponse({ status: 200, description: 'DesignEvidence (verdict pass/fail/inconclusive + measurements + ERC + per-assertion results)' })
    @ApiResponse({ status: 400, description: 'Invalid circuit or analysis config' })
    async verifyDesign(@Body() dto: VerifyDesignDto, @CurrentUser() user: { id: string }): Promise<DesignEvidence> {
        // A malformed circuit/analysis is a CLIENT error (400) — distinct from a valid circuit that
        // simply fails to verify (which returns a 200 evidence pack with verdict "fail").
        const circuit = safeValidateCircuitJson(dto.circuit);
        if (!circuit.success) {
            const issues = circuit.error.errors.slice(0, 5).map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
            throw new BadRequestException(`Invalid circuit: ${issues}`);
        }

        // The default simulation measures node VOLTAGES only — a current/power probe would silently
        // never match and report a spurious failure. Reject it up front with a clear message rather
        // than mis-verify. (Current/power assertions are a planned follow-up.)
        const current = (dto.assertions ?? []).find((a) => isCurrentProbe(a.probe));
        if (current) {
            throw new BadRequestException(
                `Current-probe assertions ("${current.probe}") aren't supported yet — assert on a node voltage (e.g. "out"). Current/power specs are coming in a later release.`,
            );
        }

        let analysis: AnalysisConfig | undefined;
        if (dto.analysisConfig) {
            const a = safeValidateAnalysisConfig(dto.analysisConfig);
            if (!a.success) {
                const issues = a.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
                throw new BadRequestException(`Invalid analysis config: ${issues}`);
            }
            analysis = a.data as AnalysisConfig;
        }

        return this.verification.verify(circuit.data, analysis, dto.assertions ?? [], user.id);
    }
}
