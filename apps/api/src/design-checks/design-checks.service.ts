/**
 * Thin on purpose: the checks live in eda-core, and this is only the seam that lets HTTP reach them.
 *
 * Nothing here reshapes the result. A verdict that was renamed or summarised on the way out would become a
 * second contract to keep in step with the first, and the day they drift the client shows a different answer
 * from the one the design loop was judged against — which is exactly the class of defect this endpoint
 * exists to remove.
 */
import { runErc, validateCircuitJson, type CircuitJson, type ErcResult } from '@circuit-forge/eda-core';
import { classifyCircuit, type LayoutabilityResult } from '@circuit-forge/pcb-preflight';
import { Injectable } from '@nestjs/common';

@Injectable()
export class DesignChecksService {
    /**
     * Run ERC.
     *
     * The DTO has already refused anything the schema cannot read, so this parse is the narrowing rather
     * than a second gate — and it is a parse rather than a cast, because a cast would let a body that
     * changed shape between validation and use reach `runErc` unchecked.
     */
    erc(circuit: Record<string, unknown>): ErcResult {
        return runErc(validateCircuitJson(circuit) as CircuitJson);
    }

    /**
     * Can this become a board, and what would each part become?
     *
     * Run WITHOUT the pad-count oracle, deliberately and always — see preflight.md. The short version: the
     * oracle is an optional peer the API does not install, and more importantly a hopeful load would succeed
     * in a pnpm workspace and fail in the Docker image, giving development a different answer from
     * production. An endpoint that answers differently in the two is worse than one that answers less.
     *
     * `classifyCircuit` handles the absence honestly — it reports PCB006, "the check did not run", instead of
     * declaring a board accounted-for by a check that never happened. So this is a FAST check, not a
     * complete one, and the result says which.
     */
    preflight(circuit: Record<string, unknown>): LayoutabilityResult {
        return classifyCircuit(validateCircuitJson(circuit) as CircuitJson);
    }
}
