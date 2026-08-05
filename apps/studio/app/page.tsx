'use client';

/**
 * The workspace: a real vertical slice through the whole stack.
 *
 * Sign in → list orgs → list projects → load that project's working copy → project it through the editor
 * kernel → render it. Nothing here is fixture-backed; every panel is showing what the API actually returned,
 * which is the only way this harness is worth building inside the product's own workspace.
 */

import {
    connectPins,
    deleteComponent,
    disconnectPin,
    isPlaceablePart,
    type TreeNode,
} from '@circuit-forge/editor-core';
import { useMemo, useState } from 'react';

import { AddPart, Inspector } from '../components/Inspector';
import { ObjectTreePanel } from '../components/ObjectTreePanel';
import { PartLibrary } from '../components/PartLibrary';
import { SaveStatus } from '../components/SaveStatus';
import { SchematicCanvas } from '../components/SchematicCanvas';
import { SignIn } from '../components/SignIn';
import { API_BASE_URL, type ApiError, type OpenedProject } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useDocument } from '../lib/useDocument';
import { useUndoShortcuts } from '../lib/useUndoShortcuts';

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
            {/* Not "read-only": editing this is allowed and the first keystroke creates a draft descending
                from it. Saying otherwise was a lie the moment the write path landed. */}
            Opened from saved v{doc.version.versionNumber} of {doc.totalVersions} — editing starts a new draft
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

    // A page, not THE list. The default limit is 50 and the picker rendered whatever came back as though it
    // were everything, so a 51st project was simply unreachable with no indication. Asking for the cap and
    // disclosing the remainder is honest at any size; real paging belongs with a searchable picker.
    const projects = useAsync(
        (signal) => api.projects(activeOrg!, { limit: 100 }, signal),
        [activeOrg],
        activeOrg !== null,
    );
    const activeProject = projectId ?? projects.data?.items[0]?.id ?? null;

    // `openProject`, not `workingCopy`: a project with no draft still has its saved history, and the API's
    // own contract says to open the newest version instead of showing nothing.
    const opened = useAsync(
        (signal) => api.openProject(activeProject!, signal),
        [activeProject],
        activeProject !== null,
    );

    // The loader fetches; the document OWNS what is on screen and writes it back. Splitting them is what
    // keeps a local edit instant while the save is debounced, refusable and one-at-a-time.
    const doc = useDocument(api, activeProject, opened.data, opened.reload);
    useUndoShortcuts({ undo: doc.undo, redo: doc.redo });
    const circuit = doc.circuit;
    const counts = useMemo(
        () => ({
            // Counted the way the TREE counts, which means net markers are not parts. The raw array length
            // disagreed with the Components row by exactly the number of ground symbols — 27 in the footer
            // beside 26 in the tree, on the same screen, for the same design. Two numbers for one fact is a
            // defect even when both are defensible: the reader has to work out which one answers their
            // question, and nothing on screen tells them.
            components: (circuit?.components ?? []).filter(isPlaceablePart).length,
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
                    {projects.data?.hasMore && (
                        <option disabled>…and {projects.data.total - projects.data.items.length} more not shown</option>
                    )}
                </select>

                {/* Titled with the shortcut, because a disabled button with no explanation reads as broken.
                    Disabled is the truth here: there is genuinely nothing to undo. */}
                <button onClick={doc.undo} disabled={!doc.canUndo} title="Undo (Ctrl+Z)">
                    Undo
                </button>
                <button onClick={doc.redo} disabled={!doc.canRedo} title="Redo (Ctrl+Shift+Z)">
                    Redo
                </button>

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
                        {doc.source === 'empty' && (
                            // Ordinary, not broken: a project created but never saved. Said plainly so it does
                            // not read as a failed load.
                            <p className="empty">This project has no circuit yet — no draft and no saved version.</p>
                        )}
                        <SaveStatus doc={doc} />
                        <Provenance doc={opened.data} />
                        {/* The palette lives beside the tree it adds to, and only once a document is open —
                            there is nothing to add a part TO before that. */}
                        {circuit && <AddPart doc={doc} />}
                        {/* Real parts, from the catalogue. The palette above adds a generic; this adds a
                            part with an MPN, a footprint and a tolerance — which is what the package
                            check, the robustness verdict and an orderable BOM all key on. */}
                        {circuit && <PartLibrary api={api} doc={doc} />}
                        {circuit && (
                            // Selection is held HERE and passed down, so the tree and the canvas cannot
                            // disagree about what is selected. The panel used to keep its own, which meant
                            // clicking a symbol told the Inspector and left the tree painting some other
                            // row — two views of one document, each right by its own lights.
                            //
                            // The remount-on-switch key went with it: a selection held above cannot outlive
                            // a document it does not belong to, because whatever changes the document
                            // clears it. (The key had to be there before: paths look like `root/nets/<id>`
                            // and `gnd` appears in nearly every design, so a stale selection usually landed
                            // on a real row belonging to a different circuit.)
                            <ObjectTreePanel
                                circuit={circuit}
                                selectedPath={selected?.ref.path.join('/') ?? null}
                                onSelect={setSelected}
                            />
                        )}
                    </div>
                </aside>

                <main className="stage">
                    {/* WHY IT IS HERE AND NOT ONLY IN THE INSPECTOR. A refusal is the kernel explaining that an
                        edit was not made — joining a declared ground to a declared rail, for instance, which is
                        a dead short. The Inspector renders it at the bottom of the SELECTED object's panel, so
                        an edit made on the canvas with nothing selected was refused in silence: the wire simply
                        did not appear and nothing said why. Beside the drawing, it is where the edit happened. */}
                    {doc.refusal && (
                        <div className="notice bad" role="alert">
                            {doc.refusal.message}
                        </div>
                    )}
                    {circuit ? (
                        <SchematicCanvas
                            // REMOUNTED PER PROJECT, so the canvas starts fresh. Zoom and pan are the viewer's
                            // own state and rightly survive an edit — but not a different document: opening
                            // another project while zoomed into a corner showed a blank patch of sheet with no
                            // indication that the drawing was elsewhere.
                            key={activeProject ?? 'none'}
                            circuit={circuit}
                            // The drawing the document actually carries. Without this line the canvas falls
                            // back to its derived grid on every render no matter what anyone arranged — the
                            // stored-position branch below it has been unreachable since it was written.
                            ui={doc.ui}
                            selectedPath={selected?.ref.path.join('/') ?? null}
                            onSelect={setSelected}
                            // Arranging goes through the SAME commit kernel as any other edit, so a move
                            // lands in the undo stack in the same order as the rename that followed it. Two
                            // stacks would let Ctrl+Z un-move something without un-deleting what was deleted
                            // after it — an order a user cannot hold in their head.
                            onArrange={doc.commitUi}
                            // DRAWING A WIRE goes through the same kernel edit the Inspector's dropdown uses,
                            // and through the same `apply`, so it lands in one undo stack in the order it
                            // happened. `connectPins` decides what the gesture MEANS — a change, a no-op when
                            // the two terminals are already one node, or a refusal with the reason named — and
                            // the canvas is told none of it: it reports two terminals and nothing more.
                            onConnect={(from, to) => doc.apply((c) => connectPins(c, from, to))}
                            // The other half of the same verb. Both go through `apply`, so joining two
                            // terminals and parting them again are two steps of one undo stack in the order
                            // they happened — not two stacks a user has to hold in their head.
                            onDisconnect={(pin) => doc.apply((c) => disconnectPin(c, pin))}
                            onDelete={(id) => {
                                doc.apply((c) => deleteComponent(c, id));
                                // The selection cannot outlive the thing it names. Left alone it would point
                                // at a path the tree no longer has, and the Inspector would go on offering
                                // fields for a part that is gone.
                                setSelected(null);
                            }}
                        />
                    ) : (
                        <p className="empty">Open a project with a working copy to begin.</p>
                    )}
                </main>

                <aside className="pane">
                    <div className="pane-head">Inspector</div>
                    <div className="pane-body">
                        <Inspector selected={selected} circuit={circuit} doc={doc} />
                    </div>
                </aside>
            </div>

            <footer className="statusbar">
                <span>{API_BASE_URL}</span>
                <span>{counts.components} components</span>
                <span>{counts.nets} nets</span>
                {opened.data && opened.data.source !== 'empty' && (
                    <span>
                        {opened.data.source === 'working-copy' ? 'draft' : `from v${opened.data.version.versionNumber}`}
                    </span>
                )}
                <span className="spacer" />
                <SaveStatus doc={doc} />
            </footer>
        </div>
    );
}
