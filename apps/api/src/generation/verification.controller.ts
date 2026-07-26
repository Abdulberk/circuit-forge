/**
 * Verified Designs controller — deterministic, simulation-backed circuit verification.
 */
import { safeValidateCircuitJson, safeValidateAnalysisConfig, type AnalysisConfig } from '@circuit-forge/eda-core';
import { Controller, Post, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

import { isCurrentProbe, isObservableCurrentProbe } from './assertions';
import { VerifyDesignDto } from './dto';
import { VerificationService, type DesignEvidence } from './verification.service';

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

        // Branch currents on R/C/V/L/E/H are now measured (saved via extraProbes → @<dev>[i] / native i()).
        // But a diode/transistor/subckt terminal current has no branch-current vector — the generator would
        // silently drop it and the assertion would read "probe not found" (a spurious fail). Reject THAT
        // up front with an actionable message instead (probe a series sense resistor's current).
        const badCurrent = (dto.assertions ?? []).find((a) => isCurrentProbe(a.probe) && !isObservableCurrentProbe(a.probe));
        if (badCurrent) {
            throw new BadRequestException(
                `Current probe "${badCurrent.probe}" can't be measured directly — a diode/transistor/subckt terminal current has no branch-current vector in ngspice. Probe a SERIES RESISTOR's current instead (e.g. "i(R1)").`,
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

        return this.verification.verify(circuit.data, analysis, dto.assertions ?? [], user.id, dto.robustness);
    }
}
