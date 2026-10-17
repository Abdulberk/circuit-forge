/**
 * The web app's own flows against the RUNNING API — the calls the new screens make, in the order they make
 * them. No mocks. Excluded from the default run like the other live suite (`pnpm test:e2e`).
 *
 * register → orgs → templates → create project → seed its draft from a template → open it → rename →
 * delete. Each step is one the projects page or the new-project dialog performs.
 */
import { safeValidateCircuitJson } from '@circuit-forge/eda-core';

import { ApiClient } from './client';
import { Api } from './resources';
import { memoryTokenStore } from './tokens';

const BASE_URL = process.env.STUDIO_E2E_API_URL ?? 'http://localhost:3001';

const client = new ApiClient({ baseUrl: BASE_URL, store: memoryTokenStore(), timeoutMs: 20_000 });
const api = new Api(client);
const stamp = Date.now();

describe('the web app flows, live', () => {
    let orgId = '';
    let projectId = '';

    it('registers a new account, which lands signed in with an organisation', async () => {
        // Register is rate-limited (20/hour/IP); a 429 here is an environment limit, not a regression.
        await client.register(`Web Flow ${stamp}`, `web-flow-${stamp}@example.com`, 'web-flow-password-1');
        expect(client.authenticated).toBe(true);
        const orgs = await api.orgs();
        expect(orgs.length).toBeGreaterThanOrEqual(1);
        orgId = orgs[0]!.id;
    });

    it('lists public templates as a plain array of valid circuits', async () => {
        const templates = await api.templates({ limit: 50 });
        expect(Array.isArray(templates)).toBe(true);
        expect(templates.length).toBeGreaterThan(0);
        for (const t of templates)
            expect({ name: t.name, valid: safeValidateCircuitJson(t.circuitJson).success }).toEqual({
                name: t.name,
                valid: true,
            });
    });

    it('creates a project from a template and opens it with that circuit', async () => {
        const [template] = await api.templates({ limit: 1 });
        const project = await api.createProject(orgId, { name: `From template ${stamp}` });
        projectId = project.id;
        await api.saveWorkingCopy(projectId, { circuitJson: template!.circuitJson, uiJson: {} });

        const opened = await api.openProject(projectId);
        expect(opened.source).toBe('working-copy');
        if (opened.source !== 'working-copy') return;
        expect(opened.circuitJson).toEqual(template!.circuitJson);

        const page = await api.projects(orgId, { limit: 100 });
        expect(page.items.map((p) => p.id)).toContain(projectId);
    });

    it('renames and then deletes it', async () => {
        const renamed = await api.updateProject(projectId, { name: `Renamed ${stamp}` });
        expect(renamed.name).toBe(`Renamed ${stamp}`);
        await api.deleteProject(projectId);
        await expect(api.project(projectId)).rejects.toMatchObject({ kind: 'not-found' });
    });
});
