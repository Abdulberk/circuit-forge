/**
 * The client against the RUNNING API. No mocks anywhere in this file.
 *
 * The unit tests prove the client behaves correctly given a response. They cannot prove the response is what
 * the client expects — every interface in `resources.ts` is hand-transcribed from a Prisma model or a service
 * return, and a transcription is a copy that can drift. The failure that produces is the quiet one: a renamed
 * field reads as `undefined`, the panel renders empty, and nothing anywhere is an error.
 *
 * So this asks the real server and asserts on the SHAPE it sends back. It is excluded from the default run
 * (`testPathIgnorePatterns`) because it needs the stack up; `pnpm --filter @circuit-forge/studio test:e2e`
 * runs it deliberately. It fails loudly rather than skipping when the API is unreachable — a live test that
 * quietly passes when it did not run is worse than no test.
 */
import type { CircuitJson } from '@circuit-forge/eda-core';
import { buildObjectTree } from '@circuit-forge/editor-core';

import { ApiClient } from './client';
import { ApiError } from './errors';
import { Api } from './resources';
import { memoryTokenStore } from './tokens';

const BASE_URL = process.env.STUDIO_E2E_API_URL ?? 'http://localhost:3001';

/** A real, minimal design: a divider that our own ERC and netlist generator both accept. */
const DIVIDER: CircuitJson = {
    version: '1.0',
    components: [
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: 5,
            pins: [
                { pinId: '+', netId: 'vin' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: 1000,
            pins: [
                { pinId: '1', netId: 'vin' },
                { pinId: '2', netId: 'mid' },
            ],
        },
        {
            id: 'r2',
            type: 'resistor',
            designator: 'R2',
            value: 2000,
            pins: [
                { pinId: '1', netId: 'mid' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
        { id: 'gnd1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [
        { id: 'vin', name: 'VIN' },
        { id: 'mid', name: 'MID' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
} as unknown as CircuitJson;

/**
 * ONE account, reused across runs; the PROJECTS are what carry the per-run stamp.
 *
 * An earlier version registered a fresh account every time, which made the suite un-runnable more than
 * twenty times an hour: `POST /auth/register` is capped at 20/hour/IP as anti-spam, and once that budget was
 * gone every test failed with `ThrottlerException` — a red suite caused entirely by having run it. A live
 * test that degrades the more you use it is a test people stop using.
 *
 * So it registers on first use and signs in afterwards, and the throttle it does consume is login's, which
 * refills every minute. Projects still get a unique name per run, so nothing collides in the database.
 */
const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const EMAIL = process.env.STUDIO_E2E_EMAIL ?? 'studio-e2e@example.test';
const PASSWORD = process.env.STUDIO_E2E_PASSWORD ?? 'studio-e2e-password-1';

const store = memoryTokenStore();
const client = new ApiClient({ baseUrl: BASE_URL, store, timeoutMs: 20_000 });
const api = new Api(client);

let projectId: string;
/** Whether THIS run created the account — the registration assertions only mean something if it did. */
let registered = false;

beforeAll(async () => {
    const reachable = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(4_000) })
        .then((r) => r.ok)
        .catch(() => false);
    if (!reachable) {
        throw new Error(
            `No API at ${BASE_URL}. Start it with \`API_HOST_PORT=3001 docker compose up -d api\`, or set ` +
                `STUDIO_E2E_API_URL. This test does not skip: a live check that passes without running is a ` +
                `false green.`,
        );
    }

    // Register on first use; sign in on every run after that. A 409 means the account is already there,
    // which is the ordinary steady state — anything else is a real failure and is rethrown.
    try {
        const tokens = await client.request<{ accessToken: string; refreshToken: string }>('/auth/register', {
            method: 'POST',
            body: { email: EMAIL, password: PASSWORD, name: 'Studio E2E' },
            authenticated: false,
        });
        store.write(tokens);
        registered = true;
    } catch (err) {
        if (!(err instanceof ApiError) || (err.kind !== 'conflict' && err.kind !== 'throttled')) throw err;
        // 409 means the account is there — the ordinary steady state. 429 means we could not even ask, which
        // is NOT the same thing: the account may or may not exist. Both are worth trying to sign in on, but
        // when that fails after a 429 the cause is the exhausted register budget, and saying "Invalid
        // credentials" would send a reader looking for a password bug that is not there.
        try {
            await client.signIn(EMAIL, PASSWORD);
        } catch (signInErr) {
            if (err.kind === 'throttled') {
                throw new Error(
                    `Could not create ${EMAIL}: POST /auth/register is rate-limited (20/hour/IP) and the ` +
                        `budget is spent, so the account does not exist yet. Restarting the API clears the ` +
                        `in-memory counters: \`API_HOST_PORT=3001 docker compose restart api\`.`,
                );
            }
            throw signInErr;
        }
    }
}, 60_000);

describe('the transcribed contracts, against the server that defines them', () => {
    it('an account has a usable session with an org already attached', async () => {
        const orgs = await api.orgs();
        expect(Array.isArray(orgs)).toBe(true);
        expect(orgs.length).toBeGreaterThan(0);
        // Registration creates the org, so on the run that registered we know it came from that path rather
        // than from something a previous run left behind. Stated in the output so a reader knows which
        // happened, instead of the test silently meaning two different things on different days.
        if (registered) expect(orgs).toHaveLength(1);

        // The KEY SET, not a subset. `toMatchObject` on two fields is what let a fabricated `slug` sit in
        // this interface undetected: the test passed, and every read of `org.slug` in the UI would have been
        // `undefined` with nothing reporting it. Comparing the whole key set makes an invented field fail
        // here and a newly added one impossible to ignore.
        expect(Object.keys(orgs[0]!).sort()).toEqual(
            ['createdAt', 'id', 'name', 'role', 'suspendReason', 'suspendedAt', 'updatedAt'].sort(),
        );

        // And the org id must be addressable by the routes that serve it — seeded demo data once was not,
        // which made every project inside it unopenable while the org itself listed perfectly.
        expect(orgs[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('answers list endpoints in the full pagination envelope, hasMore included', async () => {
        const orgs = await api.orgs();
        const page = await api.projects(orgs[0]!.id);
        expect(Object.keys(page).sort()).toEqual(['hasMore', 'items', 'limit', 'offset', 'total']);
    });

    it('creates a project and lists it inside the pagination envelope', async () => {
        const orgs = await api.orgs();
        const created = await client.request<{ id: string; name: string }>(`/orgs/${orgs[0]!.id}/projects`, {
            method: 'POST',
            body: { name: `studio-e2e-${stamp}`, description: 'created by the studio live e2e' },
        });
        projectId = created.id;

        const page = await api.projects(orgs[0]!.id);
        // `items`/`total`/`limit`/`offset` is the envelope every list endpoint uses; if it were `data`, the
        // studio's project picker would silently render zero projects.
        expect(page).toMatchObject({
            items: expect.any(Array),
            total: expect.any(Number),
            limit: expect.any(Number),
            offset: expect.any(Number),
        });
        expect(page.total).toBeGreaterThan(0);

        // Membership is checked by fetching the project, NOT by looking for it in page one. The account is
        // reused across runs, so projects accumulate; against a default limit of 50 this assertion would
        // start failing on the fifty-first run, for a reason that has nothing to do with what it tests.
        await expect(api.project(projectId)).resolves.toMatchObject({ id: projectId, orgId: orgs[0]!.id });
    });

    it('reports a project with no draft as null — and a missing PROJECT as an error', async () => {
        // The two cases the API answers 404 for, told apart. The studio renders "no working copy yet" for the
        // first; the second is a wrong or deleted id and must not read as an empty project.
        await expect(api.workingCopy(projectId)).resolves.toBeNull();
        await expect(api.workingCopy('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
            kind: 'not-found',
        });
    });

    it('round-trips a real circuit through the working copy, byte for byte', async () => {
        const saved = await api.saveWorkingCopy(projectId, { circuitJson: DIVIDER, uiJson: {} });
        expect(saved).toMatchObject({ projectId, updatedAt: expect.any(String) });

        const loaded = await api.workingCopy(projectId);
        expect(loaded).not.toBeNull();
        // The design must survive the JSON column unchanged: a component dropped or a field coerced here
        // would corrupt every downstream stage — ERC, netlist, layout — from a single silent write.
        expect(loaded!.circuitJson).toEqual(DIVIDER);
    });

    it('refuses a save whose precondition is stale — the whole point of expectedUpdatedAt', async () => {
        // Two people with the project open. The second save must be REFUSED, not merged and not silently
        // applied over work that was never on this screen.
        const first = await api.workingCopy(projectId);
        const stale = first!.updatedAt;

        await api.saveWorkingCopy(projectId, { circuitJson: DIVIDER, uiJson: {}, expectedUpdatedAt: stale });

        const err = (await api
            .saveWorkingCopy(projectId, { circuitJson: DIVIDER, uiJson: {}, expectedUpdatedAt: stale })
            .catch((e: unknown) => e)) as ApiError;

        expect(err).toBeInstanceOf(ApiError);
        expect(err.kind).toBe('conflict');
        expect(err.code).toBe('WORKING_COPY_CONFLICT');
        // Not retryable: repeating it verbatim fails identically. The client must re-read and re-apply.
        expect(err.retryable).toBe(false);
    });

    it('feeds the editor kernel directly — what the API returns is what the tree projects', async () => {
        // The join under test end to end: server → client types → kernel → the rows a user would see.
        const loaded = await api.workingCopy(projectId);
        const tree = buildObjectTree(loaded!.circuitJson);

        const branch = (kind: string) => tree.root.children.find((c) => c.ref.kind === kind)!;

        expect(
            branch('nets')
                .children.map((n) => n.label)
                .sort(),
        ).toEqual(['GND', 'MID', 'VIN']);

        // The components too — no layout has been run, and that must not make the parts vanish. This is the
        // state an editor is in almost all the time, and the tree used to render it as nets and nothing else.
        const parts = branch('components').children;
        expect(parts.map((n) => n.label).sort()).toEqual(['R1', 'R2', 'V1']); // GND1 is a net marker, not a part
        // …each with its own pins, read against the net NAME an engineer would recognise.
        const r1Pins = parts.find((n) => n.label === 'R1')!.children.find((c) => c.ref.kind === 'pins')!;
        expect(r1Pins.children.map((p) => `${p.label}→${p.detail!}`)).toEqual(['1→VIN', '2→MID']);

        // No layout was requested, so there is nothing to be unjoined about.
        expect(tree.unplaced).toEqual([]);
        expect(tree.ambiguous).toEqual([]);
    });

    it('opens a project through all three branches: empty, saved version, then draft', async () => {
        // The rule the API states in prose — "404 if none yet (open the latest version instead)" — and then
        // leaves to every client. Encoded once in `openProject`; this is what proves it against the server
        // rather than against my reading of the docstring.
        const orgs = await api.orgs();
        const fresh = await client.request<{ id: string }>(`/orgs/${orgs[0]!.id}/projects`, {
            method: 'POST',
            body: { name: `studio-e2e-open-${stamp}` },
        });

        // 1. Nothing saved at all — neither a draft nor history.
        await expect(api.openProject(fresh.id)).resolves.toEqual({ source: 'empty' });

        // 2. A saved version and no draft: the version is opened, and the UI is told it is read-only history.
        await client.request(`/projects/${fresh.id}/versions`, {
            method: 'POST',
            body: { circuitJson: DIVIDER, uiJson: {} },
        });
        const fromVersion = await api.openProject(fresh.id);
        expect(fromVersion.source).toBe('version');
        if (fromVersion.source !== 'version') throw new Error('unreachable');
        expect(fromVersion.circuitJson).toEqual(DIVIDER);
        expect(fromVersion.version.versionNumber).toBe(1);
        expect(fromVersion.totalVersions).toBe(1);

        // 3. A draft now exists: it WINS over the saved version, because it is the newer work.
        const edited = {
            ...DIVIDER,
            nets: [...(DIVIDER as unknown as { nets: unknown[] }).nets, { id: 'extra', name: 'EXTRA' }],
        } as unknown as CircuitJson;
        await api.saveWorkingCopy(fresh.id, { circuitJson: edited, uiJson: {} });
        const fromDraft = await api.openProject(fresh.id);
        expect(fromDraft.source).toBe('working-copy');
        if (fromDraft.source !== 'working-copy') throw new Error('unreachable');
        expect(fromDraft.circuitJson).toEqual(edited);
    });

    it('takes the NEWEST version, not the first page in insertion order', async () => {
        // `limit: 1` is only a constant-cost lookup if the server orders newest-first. If it did not, a
        // project with a long history would silently open v1 — the oldest circuit — and look perfectly fine.
        const orgs = await api.orgs();
        const proj = await client.request<{ id: string }>(`/orgs/${orgs[0]!.id}/projects`, {
            method: 'POST',
            body: { name: `studio-e2e-newest-${stamp}` },
        });
        for (let i = 0; i < 3; i++) {
            await client.request(`/projects/${proj.id}/versions`, {
                method: 'POST',
                body: { circuitJson: DIVIDER, uiJson: { n: i } },
            });
        }
        const opened = await api.openProject(proj.id);
        if (opened.source !== 'version') throw new Error(`expected a version, got ${opened.source}`);
        expect(opened.version.versionNumber).toBe(3);
        expect(opened.totalVersions).toBe(3);
    });

    it('classifies a genuinely missing project as not-found', async () => {
        await expect(api.project('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
            kind: 'not-found',
        });
    });

    it('refuses something that is not a circuit at all', async () => {
        // Before the shape check this answered 200 and stored `{nope:true}` as a design. The cost showed up
        // far away and looked like a different bug: the editor rendered an empty tree, and the eventual
        // layout job failed about a property that was never there.
        const err = (await api
            .saveWorkingCopy(projectId, { circuitJson: { nope: true } as unknown as CircuitJson, uiJson: {} })
            .catch((e: unknown) => e)) as ApiError;
        expect(err).toBeInstanceOf(ApiError);
        expect(err.kind).toBe('invalid');
        expect(err.details?.join(' ') ?? err.message).toContain('components');
    });

    it('still accepts a draft that is INCOMPLETE — that is what a draft is', async () => {
        // The other half of the same rule, and the reason it is a shape check rather than the full schema.
        // A row autosaved on a debounce is half-finished most of the time; rejecting that would make editing
        // impossible, so a guard without this test would be one keystroke away from being too strict.
        const midEdit = {
            version: '1.0',
            components: [{ id: 'r9', type: 'resistor', designator: 'R9', pins: [] }],
            nets: [],
        } as unknown as CircuitJson;
        await expect(api.saveWorkingCopy(projectId, { circuitJson: midEdit, uiJson: {} })).resolves.toMatchObject({
            projectId,
        });
        // Put the real design back for the tests that follow.
        await api.saveWorkingCopy(projectId, { circuitJson: DIVIDER, uiJson: {} });
    });

    it('discards the draft, and the project reads as having none again', async () => {
        await expect(api.discardWorkingCopy(projectId)).resolves.toMatchObject({ discarded: true });
        await expect(api.workingCopy(projectId)).resolves.toBeNull();
    });

    it('rotates the session on refresh, and the new pair works', async () => {
        // The behaviour the single-flight guard exists for, confirmed against the real rotation rather than
        // assumed from the schema.
        const before = store.read()!;
        const rotated = await client.request<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
            method: 'POST',
            body: { refreshToken: before.refreshToken },
            authenticated: false,
        });
        expect(rotated.refreshToken).not.toBe(before.refreshToken);

        store.write(rotated);
        await expect(api.orgs()).resolves.toBeDefined();

        // The old refresh token must now be dead — that is what makes concurrent refreshes dangerous.
        await expect(
            client.request('/auth/refresh', {
                method: 'POST',
                body: { refreshToken: before.refreshToken },
                authenticated: false,
            }),
        ).rejects.toBeInstanceOf(ApiError);
    });
});
