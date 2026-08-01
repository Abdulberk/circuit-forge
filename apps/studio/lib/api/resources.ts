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
import type { CircuitJson } from '@circuit-forge/eda-core';
import type { LayoutGeometry } from '@circuit-forge/pcb-contract';

import type { ApiClient } from './client';
import { ApiError } from './errors';
import { pollUntilSettled, type PollOptions } from './poll';

/** Every list endpoint answers in this envelope. */
export interface Paginated<T> {
    items: T[];
    total: number;
    limit: number;
    offset: number;
}

export interface Org {
    id: string;
    name: string;
    slug: string;
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
 * The draft. `updatedAt` is not decoration — it is the concurrency token: send it back as
 * `expectedUpdatedAt` and the API refuses the write if anyone else saved in between.
 */
export interface WorkingCopy {
    projectId: string;
    circuitJson: CircuitJson;
    uiJson: unknown;
    baseVersionId: string | null;
    updatedByUserId: string;
    createdAt: string;
    updatedAt: string;
}

/** GET /layouts/:id — status while pending, plus the result and presigned artifacts once finished. */
export interface LayoutJob {
    id: string;
    orgId: string;
    projectId: string | null;
    versionId: string | null;
    status: string;
    result: { geometry?: LayoutGeometry } | null;
    errorMessage: string | null;
    glbUrl?: string;
    gerbersUrl?: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}

export interface SimulationJob {
    id: string;
    status: string;
    errorMessage?: string | null;
}

export class Api {
    constructor(private readonly http: ApiClient) {}

    // ---- Orgs and projects ----------------------------------------------------------------------------

    /** GET /orgs */
    orgs(signal?: AbortSignal): Promise<Org[]> {
        return this.http.request<Org[]>('/orgs', { signal });
    }

    /** GET /orgs/:orgId/projects */
    projects(orgId: string, signal?: AbortSignal): Promise<Paginated<Project>> {
        return this.http.request<Paginated<Project>>(`/orgs/${orgId}/projects`, { signal });
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
             * Editor state — viewport, selection, panel sizes. REQUIRED, mirroring the API's own DTO, and
             * deliberately not defaulted to `{}` here. A default would look convenient and would eventually
             * destroy data: the save replaces the stored value, so the first caller that omitted it because
             * it "only changed the circuit" would silently wipe the user's editor state. Sending `{}` is a
             * decision ("there is no UI state"), and it should be made where it is true.
             */
            uiJson: Record<string, unknown>;
            baseVersionId?: string | null;
            expectedUpdatedAt?: string;
        },
        signal?: AbortSignal,
    ): Promise<WorkingCopy> {
        return this.http.request<WorkingCopy>(`/projects/${projectId}/working-copy`, {
            method: 'PUT',
            body: draft,
            signal,
        });
    }

    /** DELETE /projects/:id/working-copy — revert to the last saved version. Idempotent. */
    discardWorkingCopy(projectId: string, signal?: AbortSignal): Promise<{ discarded: boolean }> {
        return this.http.request(`/projects/${projectId}/working-copy`, { method: 'DELETE', signal });
    }

    // ---- Layout, the long-running one -----------------------------------------------------------------

    /** POST /layouts → 202. Returns the job id to poll; it does NOT wait. */
    startLayout(
        request: { circuitJson: CircuitJson; projectId?: string; versionId?: string; orgId?: string },
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
    ): Promise<Paginated<LayoutJob>> {
        return this.http.request<Paginated<LayoutJob>>('/layouts', { query: filter, signal });
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
        request: { circuitJson: CircuitJson; projectId?: string; versionId?: string; orgId?: string },
        options: PollOptions = {},
    ): Promise<LayoutJob> {
        const { jobId } = await this.startLayout(request, options.signal);
        return pollUntilSettled((s) => this.layout(jobId, s), options);
    }

    // ---- Simulation -----------------------------------------------------------------------------------

    /** POST /versions/:versionId/simulations → the job to poll. */
    startSimulation(
        versionId: string,
        body: unknown,
        signal?: AbortSignal,
    ): Promise<{ jobId: string; status: string }> {
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
}
