/**
 * No-op catalog grounding for the worker's design loop.
 *
 * The API's CatalogGroundingService pulls in PartsService + TmeClient + the TME token cache + the whole NestJS
 * DI graph to (a) hand the LLM a `circuitGrounding` tool (real MPNs from the TME catalog) and (b) enrich the
 * final BOM with sourcing data. None of that is framework-free, so the worker injects this no-op until a
 * standalone TME tool-executor is extracted (a later slice). `runDesignLoop` already guards every grounding
 * use on a truthy `grounding()`, so a no-op simply yields an UNGROUNDED design — generic part values, no
 * catalog MPNs, no sourcing enrichment — which is exactly what the API produces today whenever grounding is
 * unavailable. `enrichSourcing` leaves the BOM untouched.
 */
import type { DesignGround } from '@circuitforge/llm-core';

export const noopGround: DesignGround = {
    grounding: () => undefined,
    enrichSourcing: async () => undefined,
};
