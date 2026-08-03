/**
 * The API surface the studio uses, as functions with names an engineer would use.
 *
 * These are thin ON PURPOSE. Every type below is transcribed from the API's own response — the Prisma model
 * or the service's return — and nothing is reshaped on the way through. A client layer that renames fields
 * or invents a nicer shape becomes a second contract to keep in step with the first, and the day they drift
 * the mismatch surfaces as a blank panel with no error anywhere.
 *
 * `openapi-typescript` against the live `/docs-json` would remove the transcription entirely, and is the
 * right move once the surface stops moving. Until then these are hand-written and each one names the route
 * it mirrors, so a reader can check it in one grep.
 */
import type { CircuitJson, ErcResult, UiJson } from '@circuit-forge/eda-core';
import type { LayoutGeometry } from '@circuit-forge/pcb-contract';
import type { LayoutabilityResult } from '@circuit-forge/pcb-preflight';

import type { ApiClient } from './client';
import { ApiError } from './errors';
import { pollUntilSettled, type PollOptions } from './poll';

/** Every list endpoint answers in this envelope. */
export interface Paginated<T> {
    items: T[];
    total: number;
    limit: number;
    offset: number;
    /** Whether another page exists — cheaper for the caller than comparing offset + items.length to total. */
    hasMore: boolean;
}

/**
 * GET /orgs — the caller's organizations, each carrying THEIR role in it.
 *
 * There is no `slug`: an earlier version of this interface declared one, transcribed from nothing. The model
 * has no such column, so every read of it would have been `undefined` — the exact silent-drift failure these
 * types exist to avoid, and one my own e2e missed because it asserted `id` and `name` and stopped.
 */
export interface Org {
    id: string;
    name: string;
    /** The signed-in user's role here — OWNER, ADMIN, MEMBER. Present because the list is user-scoped. */
    role: string;
    createdAt: string;
    updatedAt: string;
    /** Set when a platform admin has suspended the org; writes are refused while it is. */
    suspendedAt: string | null;
    suspendReason: string | null;
}

export interface Project {
    id: string;
    orgId: string;
    name: string;
    description: string | null;
    createdAt: string;
    updatedAt: string;
}

/**
 * What a SAVE answers with — the server-owned fields only, deliberately not the blobs.
 *
 * PUT is the app's highest-frequency write and the client already holds the circuit it just uploaded, so the
 * API returns `select: {projectId, baseVersionId, updatedByUserId, updatedAt}` and nothing else. This was
 * typed as the full row, which made `saved.circuitJson` compile and be `undefined` forever — the same
 * silent-drift failure as the phantom `Org.slug`, on the one call an editor makes most.
 *
 * `updatedAt` is not decoration: it is the concurrency token. Send it back as `expectedUpdatedAt` and the
 * API refuses the next write if anyone else saved in between.
 */
export interface WorkingCopySaved {
    projectId: string;
    baseVersionId: string | null;
    updatedByUserId: string;
    updatedAt: string;
}

/** What a LOAD answers with — the full row, blobs included. GET is not on the hot path. */
export interface WorkingCopy extends WorkingCopySaved {
    circuitJson: CircuitJson;
    uiJson: unknown;
    createdAt: string;
}

/**
 * A row from GET /layouts — the LIGHT shape, and not the same type as the detail row.
 *
 * The list selects nine columns and derives one verdict; it carries no `result`, no `glbUrl` and no
 * `gerbersUrl`, because a list view that had to fetch tens of kilobytes of geometry per row to render a badge
 * would be unusable. Typed separately for the same reason `VersionSummary` is separate from `Version`:
 * declaring the rich shape here would make `row.result.layout` compile and be `undefined` forever.
 */
export interface LayoutJobSummary {
    id: string;
    orgId: string;
    projectId: string | null;
    versionId: string | null;
    status: string;
    errorMessage: string | null;
    /**
     * Whether KiCad certified the board. `null` while the question has no answer yet — a queued, running or
     * failed job is not "unmanufacturable", it is unjudged, and rendering those the same way would tell a
     * user their design failed when it has not been looked at.
     */
    manufacturable: boolean | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}

/**
 * GET /layouts/:id — status while pending, plus the full result and presigned artifacts once finished.
 *
 * `result.layout` is the geometry, NOT `result.geometry`. An earlier version of this interface declared the
 * latter, and it is worth being precise about why that was dangerous rather than merely wrong: the worker
 * writes `{ layout: geo, checks, airwires, … }` (pcb-worker/src/layout/processor.ts:235) and the service
 * passes the blob through verbatim, so `job.result?.geometry` COMPILES and is `undefined` on every real
 * board, while `job.result?.layout` would have been a type error. The board panel would have rendered blank
 * with nothing anywhere reporting a problem — exactly the failure this file's header warns about.
 */
export interface LayoutJob extends Omit<LayoutJobSummary, 'manufacturable'> {
    result: {
        layout?: LayoutGeometry;
        /** Categorised DRC findings — the notary's verdict on the delivered copper. */
        checks?: unknown[];
        /** Connections the router could not complete. Non-empty means the board is not finished. */
        airwires?: unknown[];
        drcClean?: boolean;
        manufacturing?: unknown;
        completeness?: unknown;
        parity?: unknown;
        stats?: unknown;
        bodies?: unknown;
        render?: unknown;
    } | null;
    glbUrl?: string;
    gerbersUrl?: string;
}

export interface SimulationJob {
    id: string;
    status: string;
    errorMessage?: string | null;
}

/**
 * A row from GET /projects/:id/versions.
 *
 * Deliberately blob-free — the list endpoint selects four columns and nothing else, so a project with a long
 * history costs one small response instead of shipping every circuit that was ever saved. The blob comes from
 * the detail route, for the one version actually being opened.
 */
export interface VersionSummary {
    id: string;
    versionNumber: number;
    createdAt: string;
    createdByUserId: string;
}

/** GET /versions/:id — the saved circuit itself. */
export interface Version extends VersionSummary {
    projectId: string;
    circuitJson: CircuitJson;
    uiJson: unknown;
}

/**
 * What a project actually opens as.
 *
 * `source` is not decoration — it is the difference between a DRAFT the user owns and a SAVED VERSION that is
 * already history, and the two demand different behaviour on the next keystroke. Editing a draft continues
 * where they left off; editing what came from v12 starts a new draft descending from it. A screen that showed
 * the circuit without saying which one it had is the silent-wrong-state failure: the user believes they are
 * editing their draft, and they are looking at something else.
 */
/**
 * A catalogue part, transcribed from the API's own `CatalogPart`.
 *
 * `unavailable` is the field that matters and the one a careless transcription drops: it names the
 * enrichment lookups that DID NOT ANSWER on this fetch. Without it a supplier blip returns a part with no
 * price and no stock, which reads exactly like a part the supplier genuinely does not price — and the
 * consequences are concrete, because tolerance and footprint both come from the same call.
 */
export interface CatalogPart {
    mpn: string;
    manufacturer: string;
    description: string;
    category?: string;
    footprint?: string;
    photo?: string;
    datasheetUrl?: string;
    stock?: number;
    unitCost?: number;
    currency?: string;
    supplier: string;
    supplierId: string;
    unavailable?: string[];
}

export interface PartSearchResult {
    items: CatalogPart[];
    page: number;
    /** How many THIS page returned — not the page capacity. A short page is not the end of the results. */
    returned: number;
    total?: number;
}

/** What the catalogue part becomes in a document, plus the server's honest verdict on simulating it. */
export interface MappedPart {
    simulatable: boolean;
    /** Why not, when it is not. Present exactly when `simulatable` is false. */
    reason?: string;
    component?: {
        type: string;
        value?: string;
        model?: string;
        mpn?: string;
        manufacturer?: string;
        footprint?: string;
        tolerance?: number;
        toleranceSource?: 'user' | 'catalog';
        sourcing?: Record<string, unknown>;
    };
    /** The SPICE model body to add alongside the component, for active devices. */
    modelDef?: { name: string; [k: string]: unknown };
    catalog: CatalogPart;
}

/**
 * The drawing that comes back with the document.
 *
 * `unknown` on the wire types above, and NARROWED here, because this is the boundary where it stops being
 * "whatever the server stored" and starts being something the canvas will position symbols from. Both
 * endpoints already carry it — the working copy validates it against `UiJsonSchema` on write — but neither
 * was ever read back into the editor, so every project opened with a blank drawing regardless of what was
 * saved. A malformed or absent value becomes `{}`: a project with no drawing yet is the ordinary case, and
 * refusing to open one because its layout is unreadable would make a recoverable annoyance fatal.
 */
const asUiJson = (raw: unknown): UiJson =>
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as UiJson) : {};

export type OpenedProject =
    | {
          source: 'working-copy';
          circuitJson: CircuitJson;
          uiJson: UiJson;
          updatedAt: string;
          baseVersionId: string | null;
      }
    | {
          source: 'version';
          circuitJson: CircuitJson;
          uiJson: UiJson;
          version: VersionSummary;
          totalVersions: number;
      }
    | { source: 'empty' };

export class Api {
    constructor(private readonly http: ApiClient) {}

    // ---- Orgs and projects ----------------------------------------------------------------------------

    /** GET /orgs */
    orgs(signal?: AbortSignal): Promise<Org[]> {
        return this.http.request<Org[]>('/orgs', { signal });
    }

    /**
     * GET /orgs/:orgId/projects — one PAGE, and the caller has to treat it as one.
     *
     * The envelope carries `total` and `hasMore` precisely because the array is not the whole set. A picker
     * that renders `items` and says nothing else presents page one as the complete list, and the 51st project
     * becomes unreachable with no indication anywhere.
     */
    projects(
        orgId: string,
        page: { limit?: number; offset?: number } = {},
        signal?: AbortSignal,
    ): Promise<Paginated<Project>> {
        return this.http.request<Paginated<Project>>(`/orgs/${orgId}/projects`, { query: page, signal });
    }

    /** GET /projects/:id */
    project(projectId: string, signal?: AbortSignal): Promise<Project> {
        return this.http.request<Project>(`/projects/${projectId}`, { signal });
    }

    // ---- The draft ------------------------------------------------------------------------------------

    /**
     * GET /projects/:id/working-copy — null when the project has no draft yet.
     *
     * A missing draft is an ordinary state (a project that has only saved versions, or none at all), so it
     * becomes `null` rather than an error. Making the caller catch a 404 to handle the normal case is how real
     * errors end up swallowed by the same handler.
     *
     * The translation is keyed on `NO_WORKING_COPY`, never on the status alone: this route answers 404 for two
     * different reasons — no draft, and no such project — and swallowing both would turn a wrong or deleted
     * project id into a project that merely looks empty. The live e2e caught exactly this: the first version
     * of this method assumed the API returned `null`, which it never did.
     */
    async workingCopy(projectId: string, signal?: AbortSignal): Promise<WorkingCopy | null> {
        try {
            return await this.http.request<WorkingCopy>(`/projects/${projectId}/working-copy`, { signal });
        } catch (err) {
            if (err instanceof ApiError && err.kind === 'not-found' && err.code === 'NO_WORKING_COPY') return null;
            throw err;
        }
    }

    /**
     * PUT /projects/:id/working-copy
     *
     * `expectedUpdatedAt` is the whole point: pass the `updatedAt` the draft had when it was loaded and a
     * concurrent save is rejected with 409 `WORKING_COPY_CONFLICT` instead of silently overwriting work that
     * was never on this screen. Omitting it means "last writer wins", which is only ever right for a first
     * save, when there is nothing to lose.
     */
    saveWorkingCopy(
        projectId: string,
        draft: {
            circuitJson: CircuitJson;
            /**
             * The drawing — where each symbol sits and how it is turned. REQUIRED, mirroring the API's own
             * DTO, and deliberately not defaulted to `{}` here. A default would look convenient and would
             * destroy data: the save REPLACES the stored value, so a caller that omitted it because it
             * "only changed the circuit" would wipe the user's arrangement.
             *
             * That is not hypothetical. The hook above sent a hard-coded `{}` on every autosave for exactly
             * that reason, which meant no drawing could survive a keystroke. The parameter being required is
             * what makes the decision visible at the call site instead of implied by its absence.
             */
            uiJson: UiJson;
            baseVersionId?: string | null;
            expectedUpdatedAt?: string;
        },
        signal?: AbortSignal,
    ): Promise<WorkingCopySaved> {
        return this.http.request<WorkingCopySaved>(`/projects/${projectId}/working-copy`, {
            method: 'PUT',
            body: draft,
            signal,
        });
    }

    /** DELETE /projects/:id/working-copy — revert to the last saved version. Idempotent. */
    discardWorkingCopy(projectId: string, signal?: AbortSignal): Promise<{ discarded: boolean }> {
        return this.http.request(`/projects/${projectId}/working-copy`, { method: 'DELETE', signal });
    }

    // ---- Versions -------------------------------------------------------------------------------------

    /** GET /projects/:id/versions — newest first, blob-free rows. */
    versions(
        projectId: string,
        page: { limit?: number; offset?: number } = {},
        signal?: AbortSignal,
    ): Promise<Paginated<VersionSummary>> {
        return this.http.request<Paginated<VersionSummary>>(`/projects/${projectId}/versions`, {
            query: page,
            signal,
        });
    }

    /** GET /versions/:id — the saved circuit itself. */
    version(versionId: string, signal?: AbortSignal): Promise<Version> {
        return this.http.request<Version>(`/versions/${versionId}`, { signal });
    }

    /**
     * Open a project: the draft if there is one, otherwise the newest saved version, otherwise nothing.
     *
     * The API states this rule in its own docstring — "404 if none yet (open the latest version instead)" —
     * and then leaves every client to implement it. That is the shape of bug this codebase keeps producing: a
     * rule that lives in prose, re-derived at each call site, correct in the one place someone tested. Encoded
     * once here, every consumer gets it, and `source` makes which branch ran visible instead of implied.
     *
     * The two-request path for a version is the API's blob isolation working as designed: the list returns
     * four columns, so finding the newest costs a small response, and only the one being opened is fetched
     * whole. Asking for `limit: 1` against a newest-first order is what makes that a constant-cost lookup
     * rather than downloading a project's entire history to take the head of it.
     */
    async openProject(projectId: string, signal?: AbortSignal): Promise<OpenedProject> {
        const draft = await this.workingCopy(projectId, signal);
        if (draft) {
            return {
                source: 'working-copy',
                circuitJson: draft.circuitJson,
                uiJson: asUiJson(draft.uiJson),
                updatedAt: draft.updatedAt,
                baseVersionId: draft.baseVersionId,
            };
        }

        const page = await this.versions(projectId, { limit: 1, offset: 0 }, signal);
        const newest = page.items[0];
        if (!newest) return { source: 'empty' };

        const full = await this.version(newest.id, signal);
        return {
            source: 'version',
            circuitJson: full.circuitJson,
            // A version's drawing comes forward with it: opening v12 and finding every symbol back at the
            // grid fallback would read as the editor having lost the layout that was saved WITH that version.
            uiJson: asUiJson(full.uiJson),
            version: newest,
            totalVersions: page.total,
        };
    }

    // ---- Layout, the long-running one -----------------------------------------------------------------

    /**
     * POST /layouts → 202. Returns the job id to poll; it does NOT wait.
     *
     * The field is `circuit`, and there is no `projectId`. This method used to send `circuitJson` and
     * `projectId`, which the API rejects OUTRIGHT — `CreateLayoutDto` declares `circuit`, and the global pipe
     * runs `forbidNonWhitelisted`, so every request would have failed with
     * `["property circuitJson should not exist", "property projectId should not exist", "circuit is not a
     * valid CircuitJson"]`. Nothing called it yet, so nothing was visibly broken; it was 100% broken the
     * first time a PCB panel used it, and TypeScript could not catch it because the wrong shape WAS the
     * declared shape.
     *
     * The project is derived from `versionId` server-side, which is why there is nothing to send: a layout
     * tagged to a saved version inherits that version's project and org authoritatively.
     */
    startLayout(
        request: { circuit: CircuitJson; versionId?: string; orgId?: string },
        signal?: AbortSignal,
    ): Promise<{ jobId: string; status: string; orgId: string }> {
        return this.http.request('/layouts', { method: 'POST', body: request, signal });
    }

    /** GET /layouts/:id */
    layout(jobId: string, signal?: AbortSignal): Promise<LayoutJob> {
        return this.http.request<LayoutJob>(`/layouts/${jobId}`, { signal });
    }

    /**
     * GET /layouts?versionId= — how the PCB tab re-hydrates after a reload.
     *
     * The client holds the versionId, which is durable; the jobId lives only in browser memory. Asking by
     * version is what makes a refresh show the board again instead of an empty tab.
     */
    layoutsFor(
        filter: { versionId?: string; projectId?: string },
        signal?: AbortSignal,
    ): Promise<Paginated<LayoutJobSummary>> {
        return this.http.request<Paginated<LayoutJobSummary>>('/layouts', { query: filter, signal });
    }

    /** DELETE /layouts/:id — QUEUED cancels outright, RUNNING requests a cooperative abort. Idempotent. */
    cancelLayout(jobId: string, signal?: AbortSignal): Promise<{ id: string; status: string }> {
        return this.http.request(`/layouts/${jobId}`, { method: 'DELETE', signal });
    }

    /**
     * Start a layout and wait for it to settle.
     *
     * Returns whatever it settled as — FAILED included. The caller renders the outcome; a throw here would
     * make the routine case of "this board could not be routed" indistinguishable from the server being down.
     */
    async runLayout(
        request: { circuit: CircuitJson; versionId?: string; orgId?: string },
        options: PollOptions = {},
    ): Promise<LayoutJob> {
        const { jobId } = await this.startLayout(request, options.signal);
        return pollUntilSettled((s) => this.layout(jobId, s), options);
    }

    // ---- Simulation -----------------------------------------------------------------------------------

    /**
     * POST /versions/:versionId/simulations → the job to poll.
     *
     * Returns `{ jobId }` and nothing more. A `status` was declared here too, transcribed by symmetry with
     * the layout route (which does echo one) rather than from the simulation service, which returns the id
     * alone. A caller rendering `status` would have shown "undefined" on the one screen the user is watching
     * to find out whether their simulation started.
     */
    startSimulation(versionId: string, body: unknown, signal?: AbortSignal): Promise<{ jobId: string }> {
        return this.http.request(`/versions/${versionId}/simulations`, { method: 'POST', body, signal });
    }

    /** GET /simulations/:jobId */
    simulation(jobId: string, signal?: AbortSignal): Promise<SimulationJob> {
        return this.http.request<SimulationJob>(`/simulations/${jobId}`, { signal });
    }

    /** GET /simulations/:jobId/result — only meaningful once the job has settled. */
    simulationResult<T = unknown>(jobId: string, signal?: AbortSignal): Promise<T> {
        return this.http.request<T>(`/simulations/${jobId}/result`, { signal });
    }

    // ---- The component catalogue ----------------------------------------------------------------------

    /**
     * GET /parts/search — real manufacturer parts, by keyword or MPN.
     *
     * Metered per request (the billable unit is the call, cache hits included), so a client debounces
     * rather than searching per keystroke. The envelope carries `page`/`returned` and NOT a total on every
     * provider, so a caller must page rather than treating a short page as the end — `returned` is what
     * this page gave back, not the page capacity.
     */
    searchParts(q: string, page = 1, signal?: AbortSignal): Promise<PartSearchResult> {
        return this.http.request<PartSearchResult>('/parts/search', { query: { q, page }, signal });
    }

    /**
     * GET /parts/:symbol/component — the catalogue part as something the document can hold.
     *
     * The server does the classification: which of OUR component types this part is, its value pulled from
     * the right catalogue parameter, its footprint, and whether it can be SIMULATED at all — with the
     * reason when it cannot. That verdict is the server's and is passed through untouched; a client that
     * re-derived "is this a resistor" would be a second authority, and the day the two disagreed a part
     * would enter the design as something it is not.
     */
    partComponent(supplierId: string, signal?: AbortSignal): Promise<MappedPart> {
        return this.http.request<MappedPart>(`/parts/${encodeURIComponent(supplierId)}/component`, { signal });
    }

    // ---- The cheap checks -----------------------------------------------------------------------------

    /**
     * POST /design-checks/erc — synchronous. No job, no quota unit, no saved version.
     *
     * The circuit goes in the BODY because the question is about what is on screen, which is by definition
     * not what is saved. Both result types are IMPORTED rather than transcribed: they are the same types the
     * API returns, so a field added or renamed upstream is a compile error here instead of a panel that
     * quietly renders nothing.
     *
     * Deliberately not debounced or cached at this layer. Both are real decisions about editor behaviour —
     * how long a pause counts as "stopped typing", whether a stale verdict may stay on screen — and a policy
     * buried in the transport is one no screen can override.
     */
    erc(circuit: CircuitJson, signal?: AbortSignal): Promise<ErcResult> {
        return this.http.request<ErcResult>('/design-checks/erc', { method: 'POST', body: { circuit }, signal });
    }

    /**
     * POST /design-checks/preflight — can this become a board, and what would each part become?
     *
     * FAST, not complete: the API runs this without the footprint oracle, so pad accounting is reported as
     * not-run (`PCB006` in `diagnostics`) rather than passed over. A caller that shows "ready to lay out"
     * without reading the diagnostics would be claiming a check that never happened.
     */
    preflight(circuit: CircuitJson, signal?: AbortSignal): Promise<LayoutabilityResult> {
        return this.http.request<LayoutabilityResult>('/design-checks/preflight', {
            method: 'POST',
            body: { circuit },
            signal,
        });
    }
}
