/**
 * The cheap checks, as HTTP.
 *
 * `runErc` has existed in eda-core since the beginning and has had exactly one caller: the AI design loop.
 * An editor could not ask it anything. So the only way for a user to learn that R5's second pin is connected
 * to nothing was to save a version, start a simulation or a layout, wait, and read the failure — or for the
 * client to assert its own answer, which is a second authority and therefore a wrong one.
 *
 * These are PURE and FAST: no database row, no queue, no job, no quota unit. That is the whole point. An
 * editor should be able to ask "is this sound?" on every pause in typing, and the answer must cost the same
 * as a keystroke or it will not be asked.
 *
 * WHY THE CIRCUIT IS IN THE BODY rather than a project id. The editor is asking about what is ON SCREEN,
 * which is by definition not what is saved — that is the state the user needs checked. Requiring a saved
 * version first would make the check useless exactly when it matters.
 */
import { type ErcResult } from '@circuit-forge/eda-core';
import { type LayoutabilityResult } from '@circuit-forge/pcb-preflight';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

import { DesignChecksService } from './design-checks.service';
import { CheckCircuitDto } from './dto';

@ApiTags('design')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class DesignChecksController {
    constructor(private readonly checks: DesignChecksService) {}

    @Post('design-checks/erc')
    @HttpCode(200)
    /**
     * Looser than the LRO routes and tighter than nothing. This is synchronous CPU on the API process, so a
     * caller cannot be allowed to spin it without bound — but an editor asking on every idle pause is the
     * intended usage, and a limit that made that impossible would push the client back to guessing.
     */
    @Throttle({ default: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Run ERC on a circuit, synchronously. No job, no quota, no saved version required.',
        description:
            'Answers with the SAME result the AI design loop is judged against — one authority, not a ' +
            'client-side approximation. A circuit that has not been laid out or saved is a valid input; ' +
            'this is what an editor asks about the document currently on screen.',
    })
    @ApiResponse({ status: 200, description: 'The ERC verdict: passed, issues, and the severity summary.' })
    @ApiResponse({ status: 400, description: 'The body is not a valid CircuitJson (per-field messages).' })
    erc(@Body() dto: CheckCircuitDto): ErcResult {
        return this.checks.erc(dto.circuit);
    }

    @Post('design-checks/preflight')
    @HttpCode(200)
    @Throttle({ default: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Can this circuit become a board? Synchronously, with no job and no quota unit.',
        description:
            'Answers what each part would become on a board and what would block it — a missing footprint, ' +
            'a part with no defensible physical mapping. This is the FAST check: pad accounting needs the ' +
            'footprint oracle, which runs in the layout job, and its absence is reported (PCB006) rather ' +
            'than passed over. Before this route existed the only way to learn "U3 has no footprint" was to ' +
            'spend a multi-minute layout job and a quota unit on it.',
    })
    @ApiResponse({ status: 200, description: 'Per-component plans, diagnostics, completeness and a verdict.' })
    @ApiResponse({ status: 400, description: 'The body is not a valid CircuitJson (per-field messages).' })
    preflight(@Body() dto: CheckCircuitDto): LayoutabilityResult {
        return this.checks.preflight(dto.circuit);
    }
}
