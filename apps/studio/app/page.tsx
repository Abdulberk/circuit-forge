'use client';

/**
 * The workspace: a real vertical slice through the whole stack.
 *
 * Sign in → list orgs → list projects → load that project's working copy → project it through the editor
 * kernel → render it. Nothing here is fixture-backed; every panel is showing what the API actually returned,
 * which is the only way this harness is worth building inside the product's own workspace.
 */

import { runErc, type CircuitJson, type Position } from '@circuit-forge/eda-core';
import {
    alignParts,
    buildObjectTree,
    connectPins,
    deleteComponent,
    duplicateComponents,
    disconnectPin,
    isPlaceablePart,
    placeParts,
    spreadParts,
    type PlacedPart,
    type TreeNode,
} from '@circuit-forge/editor-core';
import { useEffect, useMemo, useState } from 'react';

import { ContextMenu } from '../components/ContextMenu';
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

/** How far a copy lands from what it was copied from: far enough to see, near enough to be obviously its. */
const PASTE_OFFSET = 40;

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
    /**
     * WHAT IS SELECTED — a list, because an editor without one is an editor you use twenty times to do a
     * thing you meant once.
     *
     * The DECISION lives here rather than in either surface. The canvas and the tree report a gesture — this
     * row, with or without Shift — and this decides what the selection becomes. Two surfaces each keeping
     * their own idea of it is the defect this codebase already paid for once: clicking a symbol told the
     * Inspector and left the tree painting some other row.
     *
     * Ordered, and the LAST one is the primary: it is what the Inspector shows, because a panel of fields
     * has to be about one object, and the one you most recently pointed at is the one you meant.
     */
    const [selected, setSelected] = useState<TreeNode[]>([]);

    /** One rule for what a click means, so neither surface has to know. */
    const select = (node: TreeNode | null, additive = false): void =>
        setSelected((was) => {
            if (!node) return [];
            const path = node.ref.path.join('/');
            if (!additive) return [node];
            // Shift on something already selected takes it OUT — the same key adds and removes, which is
            // what every editor does and what a user tries first when they overshoot.
            const without = was.filter((n) => n.ref.path.join('/') !== path);
            return without.length === was.length ? [...was, node] : without;
        });
    const primary = selected[selected.length - 1] ?? null;
    const selectedPaths = selected.map((n) => n.ref.path.join('/'));

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
    /**
     * A SELECTION CANNOT OUTLIVE THE THING IT NAMES.
     *
     * Deleting from the canvas cleared it and deleting from the Inspector did not, so the Inspector's button
     * left the selection pointing at a part that was gone — and the next Delete key then acted on a ghost.
     * An undo that removes a part does the same. Checked against the document itself rather than patched at
     * each call site: there is one question here, and every path that changes the design asks it.
     */
    useEffect(() => {
        if (selected.length === 0 || !doc.circuit) return;
        const { byPath } = buildObjectTree(doc.circuit);
        const alive = selected.filter((n) => byPath.has(n.ref.path.join('/')));
        if (alive.length !== selected.length) setSelected(alive);
    }, [doc.circuit, selected]);
    useUndoShortcuts({ undo: doc.undo, redo: doc.redo });
    const circuit = doc.circuit;
    /**
     * WHAT THE RULE CHECK FOUND, run here and shown in two places at once.
     *
     * ERC has been in the kernel since long before there was a canvas and nothing in this app has ever shown
     * it: a design with no ground, a floating node, two parts sharing a designator — every one of them
     * reported, every one invisible. It is the check that says whether a drawing is a CIRCUIT, and the
     * product's whole claim is about designs that are verified.
     *
     * Recomputed only when the design changes. It runs on every keystroke otherwise, and a rule check is not
     * free on a four-hundred-part sheet.
     */
    const problems = useMemo(() => (circuit ? runErc(circuit).issues : []), [circuit]);

    /**
     * THE MENU, and it is where the alignment commands live at all.
     *
     * Every verb this editor has was reachable only by a key, and none of them is written down anywhere: the
     * way to find out what the editor can do was to already know. A right-click is where people look. It is
     * also the only place alignment could go — there is no free letter left, and a command that lines up
     * five parts is not one anybody would guess a chord for.
     *
     * The menu owns nothing. Each entry calls the same path the keyboard does, so the two cannot drift.
     */
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const selectedParts = useMemo(
        () => selected.filter((n) => n.ref.kind === 'component').map((n) => n.ref.id),
        [selected],
    );
    /**
     * A menu entry presses the key the entry names.
     *
     * Not a second implementation of the verb — the SAME one. A menu that reimplemented 'rotate' would be a
     * second answer to a question the canvas already answers, and the day they disagreed the same design
     * would turn one way from the keyboard and another from the menu.
     */
    const dispatchKey = (key: string, ctrl = false): void => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: ctrl, bubbles: true }));
    };

    const arrange = (label: string, next: Record<string, Position>): void => {
        if (Object.keys(next).length === 0) return; // nothing moved: not a revision, not a save
        doc.commitUi(label, { ...doc.ui, schemaVersion: 1, positions: { ...doc.ui.positions, ...next } });
    };
    const placedSelection = (): PlacedPart[] => {
        const placed = circuit ? placeParts(circuit, doc.ui.positions) : [];
        return placed.filter((p) => selectedParts.includes(p.id));
    };

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
                        setSelected([]);
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
                        setSelected([]);
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
                        {/* THE LIST, beside the drawing that carries the marks. A mark says WHERE and this says
                            WHAT, and clicking one selects what it names — which is the whole reason to have
                            both: a reader should not have to hunt a four-hundred-part sheet for the part an
                            error mentions. */}
                        {problems.length > 0 && (
                            <div className={`notice ${problems.some((p) => p.severity === 'error') ? 'bad' : 'warn'}`}>
                                <h4>
                                    {problems.filter((p) => p.severity === 'error').length} errors ·{' '}
                                    {problems.filter((p) => p.severity !== 'error').length} warnings
                                </h4>
                                <ul>
                                    {problems.slice(0, 12).map((issue, i) => (
                                        <li key={`${issue.code}:${issue.relatedIds.join(',')}:${i}`}>
                                            <button
                                                type="button"
                                                data-testid={`erc-${issue.code}`}
                                                style={{ textAlign: 'left' }}
                                                onClick={() => {
                                                    if (!circuit) return;
                                                    const { byPath } = buildObjectTree(circuit);
                                                    // An id may name a part or a net, and the issue does not
                                                    // say which — so both addresses are tried and whatever
                                                    // exists is selected.
                                                    setSelected(
                                                        issue.relatedIds.flatMap(
                                                            (id) =>
                                                                byPath.get(`root/components/${id}`) ??
                                                                byPath.get(`root/nets/${id}`) ??
                                                                [],
                                                        ),
                                                    );
                                                }}
                                            >
                                                {issue.message}
                                            </button>
                                        </li>
                                    ))}
                                    {problems.length > 12 && <li>…and {problems.length - 12} more</li>}
                                </ul>
                            </div>
                        )}
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
                            <ObjectTreePanel circuit={circuit} selectedPaths={selectedPaths} onSelect={select} />
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
                            selectedPaths={selectedPaths}
                            onSelect={select}
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
                            // ALL OF THEM, AS ONE REVISION. Deleting five parts one commit at a time would
                            // be five undo steps for one action, and each intermediate document is one a user
                            // never asked for — the fourth of them missing four parts and still holding the
                            // nets of the fifth.
                            // COPIES ARRIVE SELECTED AND OFFSET. Selected because the next thing anyone does
                            // with a copy is put it somewhere, and hunting for it first is a step nobody
                            // wanted; offset because a copy drawn exactly on top of its original is invisible
                            // and reads as nothing having happened.
                            onDuplicate={(ids) => {
                                // RUN ONCE FOR THE IDS, ONCE FOR THE COMMIT, and both are the same answer:
                                // `addComponent` derives an id from a designator allocated by scanning the
                                // document, so the same document plus the same request is the same document
                                // out. The preview is only read for WHICH parts to select afterwards — the
                                // committed document is the one the kernel builds from the live circuit.
                                const preview = doc.circuit ? duplicateComponents(doc.circuit, ids) : null;
                                const created = preview?.ok && preview.changed ? (preview.created ?? []) : [];

                                doc.applyMany('Copy', [(c: CircuitJson) => duplicateComponents(c, ids)], (ui, made) => {
                                    // OFFSET, in the same revision. A copy drawn exactly on top of its
                                    // original is invisible and reads as nothing having happened.
                                    const positions = { ...(ui.positions ?? {}) };
                                    made.forEach((id, k) => {
                                        const from = positions[ids[k]!];
                                        if (from)
                                            positions[id] = {
                                                ...from,
                                                x: from.x + PASTE_OFFSET,
                                                y: from.y + PASTE_OFFSET,
                                            };
                                    });
                                    return { ...ui, schemaVersion: 1, positions };
                                });

                                // The copies arrive SELECTED, because the next thing anyone does with one is
                                // put it somewhere, and hunting for it first is a step nobody wanted.
                                if (created.length > 0 && preview?.ok && preview.changed) {
                                    const tree = buildObjectTree(preview.circuit);
                                    setSelected(
                                        created.flatMap((id) => tree.byPath.get(`root/components/${id}`) ?? []),
                                    );
                                }
                            }}
                            problems={problems}
                            onContextMenu={(at) => setMenu(at)}
                            onDelete={(ids) =>
                                doc.applyMany(
                                    ids.length === 1 ? 'Delete' : `Delete ${ids.length} parts`,
                                    ids.map((id) => (c: CircuitJson) => deleteComponent(c, id)),
                                )
                            }
                        />
                    ) : (
                        <p className="empty">Open a project with a working copy to begin.</p>
                    )}
                </main>

                <aside className="pane">
                    <div className="pane-head">Inspector</div>
                    <div className="pane-body">
                        <Inspector selected={primary} selectedCount={selected.length} circuit={circuit} doc={doc} />
                    </div>
                </aside>
            </div>

            <ContextMenu
                at={menu}
                onClose={() => setMenu(null)}
                items={[
                    // Each entry is the SAME path the keyboard takes, so the two cannot answer differently.
                    // An entry with no `run` is shown greyed rather than hidden: a menu that changes shape
                    // teaches nothing, and "why can I not align one part" is answered by seeing it disabled.
                    {
                        label: 'Rotate',
                        keys: 'R',
                        run: selectedParts.length > 0 ? () => dispatchKey('r') : undefined,
                    },
                    {
                        label: 'Mirror across X',
                        keys: 'X',
                        run: selectedParts.length > 0 ? () => dispatchKey('x') : undefined,
                    },
                    {
                        label: 'Mirror across Y',
                        keys: 'Y',
                        run: selectedParts.length > 0 ? () => dispatchKey('y') : undefined,
                    },
                    {
                        // The keyboard's way to wire, shown where the other verbs are — a menu is where
                        // people learn the keys, and this is the one that had no other way to be found.
                        label: 'Join terminals',
                        keys: 'W',
                        run:
                            selected.filter((n) => n.ref.kind === 'pin').length === 2
                                ? () => dispatchKey('w')
                                : undefined,
                    },
                    'separator',
                    {
                        label: 'Duplicate',
                        keys: 'Ctrl+D',
                        run: selectedParts.length > 0 ? () => dispatchKey('d', true) : undefined,
                    },
                    {
                        label: 'Delete',
                        keys: 'Del',
                        run: selectedParts.length > 0 ? () => dispatchKey('Delete') : undefined,
                    },
                    'separator',
                    ...(
                        [
                            ['Align left', 'left'],
                            ['Align right', 'right'],
                            ['Align top', 'top'],
                            ['Align bottom', 'bottom'],
                        ] as const
                    ).map(([label, edge]) => ({
                        label,
                        run:
                            selectedParts.length > 1
                                ? () => arrange(label, alignParts(placedSelection(), edge, doc.ui.positions))
                                : undefined,
                    })),
                    {
                        label: 'Space evenly across',
                        run:
                            selectedParts.length > 2
                                ? () => arrange('Space evenly', spreadParts(placedSelection(), 'x', doc.ui.positions))
                                : undefined,
                    },
                    {
                        label: 'Space evenly down',
                        run:
                            selectedParts.length > 2
                                ? () => arrange('Space evenly', spreadParts(placedSelection(), 'y', doc.ui.positions))
                                : undefined,
                    },
                ]}
            />

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
