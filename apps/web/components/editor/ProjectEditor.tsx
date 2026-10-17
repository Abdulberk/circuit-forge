'use client';

/**
 * The project editor: one project, opened from its URL (`/projects/[projectId]`).
 *
 * Load that project's working copy → project it through the editor kernel → render it. Nothing here is
 * fixture-backed; every panel shows what the API actually returned. Choosing a project is the projects
 * page's job; this screen only edits the one in its address, so refresh, back and a shared link all work.
 */

import { runErc, type CircuitJson, type Position } from '@circuit-forge/eda-core';
import {
    alignParts,
    buildObjectTree,
    connectPins,
    deleteComponent,
    disconnectPin,
    duplicateComponents,
    isPlaceablePart,
    placeParts,
    planWire,
    planWireDeletion,
    splitNet,
    spreadParts,
    type PlacedPart,
    type SelectMode,
    type TreeNode,
    pathKey,
    componentPath,
} from '@circuit-forge/editor-core';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { useSession } from '../../app/providers';
import { API_BASE_URL, type ApiError, type OpenedProject } from '../../lib/api';
import { applySelection } from '../../lib/selection';
import { useAsync } from '../../lib/useAsync';
import { useDocument } from '../../lib/useDocument';
import { useUndoShortcuts } from '../../lib/useUndoShortcuts';
import { ContextMenu } from '../ContextMenu';
import { EditNotes } from '../EditNotes';
import { ErcNotice } from '../ErcNotice';
import { Inspector } from '../Inspector';
import { ObjectTreePanel } from '../ObjectTreePanel';
import { PartLibrary } from '../PartLibrary';
import { SaveStatus } from '../SaveStatus';
import { SchematicCanvas } from '../SchematicCanvas';
import { AppHeader } from '../shell/AppHeader';
import { Button } from '../ui/Button';

import { PartPalette } from './PartPalette';

/** How far a copy lands from what it was copied from: far enough to see, near enough to be obviously its. */
const PASTE_OFFSET = 40;

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
        return <span className="text-xs text-subtle">Draft · saved {new Date(doc.updatedAt).toLocaleString()}</span>;
    }
    return (
        <span className="text-xs text-warn">
            {/* Not "read-only": editing this is allowed and the first keystroke creates a draft descending
                from it. Saying otherwise was a lie the moment the write path landed. */}
            Opened from saved v{doc.version.versionNumber} of {doc.totalVersions} — editing starts a new draft
        </span>
    );
}

export function ProjectEditor({ projectId }: { projectId: string }) {
    const { api } = useSession();
    const project = useAsync((signal) => api.project(projectId, signal), [projectId]);
    const activeProject = projectId;
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

    /** One rule for what a gesture means, held apart from here so it can be tested on its own. */
    const select = (what: TreeNode | readonly TreeNode[] | null, mode: SelectMode = 'replace'): void =>
        setSelected((was) => applySelection(was, what, mode));
    const primary = selected[selected.length - 1] ?? null;
    const selectedPaths = selected.map((n) => pathKey(n.ref.path));

    // `openProject`, not `workingCopy`: a project with no draft still has its saved history, and the API's
    // own contract says to open the newest version instead of showing nothing.
    const opened = useAsync((signal) => api.openProject(activeProject, signal), [activeProject]);

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
        const alive = selected.filter((n) => byPath.has(pathKey(n.ref.path)));
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
        <div className="flex h-screen flex-col bg-bg text-fg">
            <AppHeader>
                <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
                    <Link href="/projects" className="text-muted hover:text-fg">
                        Projects
                    </Link>
                    <span className="text-subtle">/</span>
                    <span className="truncate font-medium">{project.data?.name ?? '…'}</span>
                </nav>
                {/* The tabs the product will grow into. Only the schematic exists today; the others are
                    shown disabled rather than hidden, so the shape of the product is visible. */}
                <div role="tablist" aria-label="Views" className="ml-4 hidden items-center gap-1 md:flex">
                    {['Schematic', 'PCB', 'Simulation', 'BOM'].map((tab, i) => (
                        <button
                            key={tab}
                            role="tab"
                            aria-selected={i === 0}
                            disabled={i !== 0}
                            title={i === 0 ? undefined : 'Coming soon'}
                            className={
                                i === 0
                                    ? 'rounded-md bg-surface-2 px-3 py-1 text-sm font-medium text-fg'
                                    : 'rounded-md px-3 py-1 text-sm text-subtle disabled:cursor-default'
                            }
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="ml-auto flex items-center gap-1">
                    {/* Titled with the shortcut, because a disabled button with no explanation reads as broken. */}
                    <Button variant="ghost" size="sm" onClick={doc.undo} disabled={!doc.canUndo} title="Undo (Ctrl+Z)">
                        Undo
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={doc.redo}
                        disabled={!doc.canRedo}
                        title="Redo (Ctrl+Shift+Z)"
                    >
                        Redo
                    </Button>
                </div>
            </AppHeader>

            <div className="grid min-h-0 flex-1 grid-cols-[272px_1fr_300px]">
                <aside className="pane border-r border-line">
                    <div className="pane-body">
                        {project.error && <Failure error={project.error} />}
                        {opened.error && <Failure error={opened.error} />}
                        {opened.loading && <p className="empty">Opening…</p>}
                        {doc.source === 'empty' && (
                            // Ordinary, not broken: a project created but never saved. Said plainly so it does
                            // not read as a failed load.
                            <p className="empty">This project has no circuit yet — no draft and no saved version.</p>
                        )}
                        {/* Generic parts first, each arriving with a sensible value; then real catalogue parts,
                            which carry the MPN, footprint and tolerance the package check, the robustness
                            verdict and an orderable BOM all key on. */}
                        {circuit && <PartPalette doc={doc} />}
                        {circuit && (
                            <details className="border-t border-line">
                                <summary className="pane-head cursor-pointer list-none border-b-0">
                                    Catalogue parts
                                </summary>
                                <div className="px-3 pb-3">
                                    <PartLibrary api={api} doc={doc} />
                                </div>
                            </details>
                        )}
                        {/* WHAT the rule check found, beside the drawing that carries the marks saying WHERE. */}
                        <ErcNotice problems={problems} circuit={circuit} onSelect={setSelected} />
                        {circuit && (
                            <div className="border-t border-line">
                                <div className="pane-head border-b-0">Objects</div>
                                {/* Selection is held HERE and passed down, so the tree and the canvas cannot
                                    disagree about what is selected. */}
                                <ObjectTreePanel circuit={circuit} selectedPaths={selectedPaths} onSelect={select} />
                            </div>
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
                    {/* WHAT THE EDIT COST. The kernel has written these since the connectivity work and
                        nothing displayed them — so joining two pins quietly took one of the user's net names
                        with it, which is the exact loss the note exists to report. Beside the refusal, and
                        deliberately not painted like one: these describe edits that were MADE. */}
                    <EditNotes notes={doc.notes} />
                    {/* Recovery, conflicts and failed saves are the moments work is at risk: shown over the
                        sheet where they cannot be missed. The quiet states live in the status bar. */}
                    {(doc.recovery || doc.save.status === 'conflict' || doc.save.status === 'error') && (
                        <SaveStatus doc={doc} />
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
                            // A DRAWN WIRE: stored where it was drawn, and the netlist follows in the same
                            // revision. `planWire` decides what it means; the canvas only reports the corners.
                            onDrawWire={(draft) => {
                                if (!circuit) return;
                                const plan = planWire(circuit, doc.ui, draft);
                                doc.applyMany(plan.label, plan.edits, plan.drawing);
                            }}
                            onDeleteWires={(keys) => {
                                if (!circuit) return;
                                const plan = planWireDeletion(circuit, doc.ui, keys);
                                doc.applyMany(plan.label, plan.edits, plan.drawing);
                            }}
                            // WHICH NET is read from the first terminal named, and `splitNet` checks that the
                            // rest are on it — refusing by name if they are not. Deciding it here would be a
                            // second opinion about connectivity, which is the drift this codebase keeps
                            // paying for; the canvas reports terminals and the kernel says what that means.
                            onSplit={(pins) =>
                                doc.apply((c) => {
                                    const first = (c.components ?? [])
                                        .find((x) => x.id === pins[0]?.componentId)
                                        ?.pins.find((q) => q.pinId === pins[0]?.pinId);
                                    return splitNet(c, first?.netId ?? '', pins);
                                })
                            }
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
                                // WHICH COPY CAME FROM WHICH PART, asked rather than assumed. A selection
                                // can hold things that are not copied — a ground marker is notation and is
                                // skipped — so pairing the two lists up by position drops the offset on the
                                // wrong part, on exactly the sheets where a box happened to catch a marker.
                                const cameFrom = new Map(
                                    created.map((id, k) => [
                                        id,
                                        (preview?.ok && preview.changed ? (preview.derivedFrom ?? []) : [])[k],
                                    ]),
                                );

                                doc.applyMany('Copy', [(c: CircuitJson) => duplicateComponents(c, ids)], (ui, made) => {
                                    // OFFSET, in the same revision. A copy drawn exactly on top of its
                                    // original is invisible and reads as nothing having happened.
                                    const positions = { ...(ui.positions ?? {}) };
                                    for (const id of made) {
                                        const source = cameFrom.get(id);
                                        const from = source ? positions[source] : undefined;
                                        if (from)
                                            positions[id] = {
                                                ...from,
                                                x: from.x + PASTE_OFFSET,
                                                y: from.y + PASTE_OFFSET,
                                            };
                                    }
                                    return { ...ui, schemaVersion: 1, positions };
                                });

                                // The copies arrive SELECTED, because the next thing anyone does with one is
                                // put it somewhere, and hunting for it first is a step nobody wanted.
                                if (created.length > 0 && preview?.ok && preview.changed) {
                                    const tree = buildObjectTree(preview.circuit);
                                    setSelected(created.flatMap((id) => tree.byPath.get(componentPath(id)) ?? []));
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

                <aside className="pane border-l border-line">
                    <div className="pane-head">Properties</div>
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
                    {
                        // The counterpart. Deleting terminals disconnects each of them and leaves every one
                        // alone on its own net; this takes them off TOGETHER, onto one new node, which is
                        // what "these belong on their own node" means and had no way to be said.
                        label: 'Split onto a new net',
                        keys: 'S',
                        run:
                            selected.filter((n) => n.ref.kind === 'pin').length > 0
                                ? () => dispatchKey('s')
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

            <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface px-4 font-mono text-[11px] text-subtle">
                <span>{counts.components} components</span>
                <span>{counts.nets} nets</span>
                <Provenance doc={opened.data} />
                <span className="flex-1" />
                <span className="hidden lg:inline">W wire · R rotate · Del delete · Home fit · middle-drag pan</span>
                {!(doc.recovery || doc.save.status === 'conflict' || doc.save.status === 'error') && (
                    <SaveStatus doc={doc} />
                )}
            </footer>
        </div>
    );
}
