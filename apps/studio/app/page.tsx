'use client';

/**
 * The workspace: a real vertical slice through the whole stack.
 *
 * Sign in → list orgs → list projects → load that project's working copy → project it through the editor
 * kernel → render it. Nothing here is fixture-backed; every panel is showing what the API actually returned,
 * which is the only way this harness is worth building inside the product's own workspace.
 */

import type { TreeNode } from '@circuit-forge/editor-core';
import { useMemo, useState } from 'react';

import { ObjectTreePanel } from '../components/ObjectTreePanel';
import { SignIn } from '../components/SignIn';
import { API_BASE_URL, type ApiError, type OpenedProject } from '../lib/api';
import { useAsync } from '../lib/useAsync';

import { useSession } from './providers';

export default function Page() {
    const { signedIn } = useSession();
    // Null means "the browser has not been asked yet". Rendering the sign-in form during that moment would
    // flash it in front of an already-authenticated user on every reload.
    if (signedIn === null) return <div className="empty">Loading…</div>;
    return signedIn ? <Workspace /> : <SignIn />;
}

function Failure({ error }: { error: ApiError }) {
    return (
        <div className="notice bad" role="alert">
            <h4>{titleFor(error)}</h4>
            {error.message}
            {error.details && (
                <ul>
                    {error.details.map((d) => (
                        <li key={d}>{d}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/** The heading is derived from the kind, so the recovery a user needs is the first thing they read. */
function titleFor(error: ApiError): string {
    switch (error.kind) {
        case 'network':
            return `Cannot reach ${API_BASE_URL}`;
        case 'forbidden':
            return 'Not allowed';
        case 'not-found':
            return 'Not found';
        case 'conflict':
            return 'Someone else saved first';
        case 'invalid':
            return 'Rejected as invalid';
        case 'throttled':
            return 'Too many requests';
        case 'server':
            return 'The server failed';
        default:
            return 'Failed';
    }
}

/**
 * Which document is on screen, stated rather than implied.
 *
 * A draft and a saved version look identical once rendered, and they are not the same thing: one is the
 * user's own unsaved work, the other is history that editing must fork from. Leaving that to be inferred is
 * how someone types into what they believe is their draft and is in fact looking at v12.
 */
function Provenance({ doc }: { doc: OpenedProject | null }): React.JSX.Element | null {
    if (!doc || doc.source === 'empty') return null;
    if (doc.source === 'working-copy') {
        return (
            <p className="empty" style={{ color: 'var(--good)' }}>
                Draft · saved {new Date(doc.updatedAt).toLocaleString()}
            </p>
        );
    }
    return (
        <p className="empty" style={{ color: 'var(--warn)' }}>
            No draft — showing saved v{doc.version.versionNumber} of {doc.totalVersions}
        </p>
    );
}

function Workspace() {
    const { api, client } = useSession();
    const [orgId, setOrgId] = useState<string | null>(null);
    const [projectId, setProjectId] = useState<string | null>(null);
    const [selected, setSelected] = useState<TreeNode | null>(null);

    const orgs = useAsync((signal) => api.orgs(signal), []);
    // The first org is adopted only until the user picks one; `?? ''` keeps the <select> controlled.
    const activeOrg = orgId ?? orgs.data?.[0]?.id ?? null;

    const projects = useAsync((signal) => api.projects(activeOrg!, signal), [activeOrg], activeOrg !== null);
    const activeProject = projectId ?? projects.data?.items[0]?.id ?? null;

    // `openProject`, not `workingCopy`: a project with no draft still has its saved history, and the API's
    // own contract says to open the newest version instead of showing nothing.
    const opened = useAsync(
        (signal) => api.openProject(activeProject!, signal),
        [activeProject],
        activeProject !== null,
    );

    const doc = opened.data;
    const circuit = doc && doc.source !== 'empty' ? doc.circuitJson : null;
    const counts = useMemo(
        () => ({
            components: circuit?.components?.length ?? 0,
            nets: circuit?.nets?.length ?? 0,
        }),
        [circuit],
    );

    return (
        <div className="shell">
            <header className="topbar">
                <span className="brand">
                    Circuit<span>Forge</span>
                </span>

                <select
                    aria-label="Organisation"
                    style={{ width: 170 }}
                    value={activeOrg ?? ''}
                    onChange={(e) => {
                        setOrgId(e.target.value);
                        setProjectId(null); // a project id from another org would 404
                        setSelected(null);
                    }}
                >
                    {(orgs.data ?? []).map((o) => (
                        <option key={o.id} value={o.id}>
                            {o.name}
                        </option>
                    ))}
                    {orgs.loading && <option>Loading…</option>}
                </select>

                <select
                    aria-label="Project"
                    style={{ width: 230 }}
                    value={activeProject ?? ''}
                    onChange={(e) => {
                        setProjectId(e.target.value);
                        setSelected(null);
                    }}
                >
                    {(projects.data?.items ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.name}
                        </option>
                    ))}
                    {projects.loading && <option>Loading…</option>}
                    {projects.data?.items.length === 0 && <option value="">No projects</option>}
                </select>

                <span className="spacer" />
                <button
                    onClick={() => {
                        void client.signOut();
                    }}
                >
                    Sign out
                </button>
            </header>

            <div className="panes">
                <aside className="pane">
                    <div className="pane-head">Objects</div>
                    <div className="pane-body">
                        {orgs.error && <Failure error={orgs.error} />}
                        {projects.error && <Failure error={projects.error} />}
                        {opened.error && <Failure error={opened.error} />}
                        {opened.loading && <p className="empty">Opening…</p>}
                        {doc?.source === 'empty' && (
                            // Ordinary, not broken: a project created but never saved. Said plainly so it does
                            // not read as a failed load.
                            <p className="empty">This project has no circuit yet — no draft and no saved version.</p>
                        )}
                        <Provenance doc={doc} />
                        {circuit && <ObjectTreePanel circuit={circuit} onSelect={setSelected} />}
                    </div>
                </aside>

                <main className="stage">
                    <p className="empty">
                        {circuit
                            ? 'Schematic and board canvases mount here.'
                            : 'Open a project with a working copy to begin.'}
                    </p>
                </main>

                <aside className="pane">
                    <div className="pane-head">Inspector</div>
                    <div className="pane-body">
                        {selected ? (
                            <dl>
                                <div className="field">
                                    <dt>Name</dt>
                                    <dd>{selected.label}</dd>
                                </div>
                                <div className="field">
                                    <dt>Kind</dt>
                                    <dd>{selected.ref.kind}</dd>
                                </div>
                                <div className="field">
                                    <dt>Id</dt>
                                    <dd>{selected.ref.id}</dd>
                                </div>
                                {selected.detail && (
                                    <div className="field">
                                        <dt>Detail</dt>
                                        <dd>{selected.detail}</dd>
                                    </div>
                                )}
                                <div className="field">
                                    <dt>Path</dt>
                                    <dd style={{ color: 'var(--text-faint)' }}>{selected.ref.path.join(' / ')}</dd>
                                </div>
                            </dl>
                        ) : (
                            <p className="empty">Select an object.</p>
                        )}
                    </div>
                </aside>
            </div>

            <footer className="statusbar">
                <span>{API_BASE_URL}</span>
                <span>{counts.components} components</span>
                <span>{counts.nets} nets</span>
                {doc && doc.source !== 'empty' && (
                    <span>{doc.source === 'working-copy' ? 'draft' : `v${doc.version.versionNumber} (read-only)`}</span>
                )}
            </footer>
        </div>
    );
}
