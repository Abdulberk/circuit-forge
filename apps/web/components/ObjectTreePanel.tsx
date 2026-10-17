'use client';

/**
 * The object tree, rendered.
 *
 * This component owns exactly two things: which rows are collapsed, and which row is selected. Everything
 * else — the shape, the labels, the joins, what could not be placed — comes from `buildObjectTree` in the
 * kernel and is not recomputed, reinterpreted or patched up here. That split is the point of the whole
 * package: this file is the part that will be REWRITTEN for another renderer, so anything that matters must
 * not live in it.
 *
 * Selection is by `path`, never by index. A re-layout reorders arrays; an index-based selection would then
 * point at a different component with nothing to indicate it moved.
 */

import type { CircuitJson } from '@circuit-forge/eda-core';
import { buildObjectTree, pathKey, type ObjectTree, type SelectMode, type TreeNode } from '@circuit-forge/editor-core';
import type { LayoutGeometry } from '@circuit-forge/pcb-contract';
import { useMemo, useState } from 'react';

const key = (node: TreeNode) => pathKey(node.ref.path);

/** Groups start open; a design with one board is more useful expanded than as a single row saying "Root". */
const COLLAPSED_BY_DEFAULT = new Set<string>();

/**
 * The rows a reader can actually see, in the order they are drawn.
 *
 * Keyboard movement is DOWN THE SCREEN, not down the data: a row inside a folded group is not somewhere the
 * caret may land, because the user cannot see where they went.
 */
function visibleRows(node: TreeNode, collapsed: ReadonlySet<string>, seat = '0', out: string[] = []): string[] {
    out.push(seat);
    if (!collapsed.has(key(node)))
        node.children.forEach((child, i) => visibleRows(child, collapsed, `${seat}.${i}`, out));
    return out;
}

/**
 * WHERE A ROW SITS IN THE TREE, which is not the same as what object it addresses.
 *
 * Two components CAN share an id — this kernel supports it on purpose and reports it as `ambiguous` rather
 * than dropping one — and then two rows carry the same address. Keyed by address, React was handed the same
 * key twice and said so; worse, the caret resolved by `indexOf` and the focus lookup took the first DOM
 * match, so pressing Down on the second row jumped BACKWARDS into the first one's subtree and everything
 * below it was unreachable from a keyboard. A seat is a path of child indices and is unique by construction.
 */
interface RowProps {
    node: TreeNode;
    /** This row's position in the tree, e.g. `0.2.1`. Unique even when two rows address one object. */
    seat: string;
    depth: number;
    collapsed: Set<string>;
    selected: ReadonlySet<string>;
    /** The one row the Tab key reaches. Every other row is skipped — see `ObjectTreePanel`. */
    active: string | null;
    onToggle: (path: string) => void;
    onSelect: (path: string, mode: SelectMode) => void;
    onMove: (from: string, key: string) => void;
}

function Row({ node, seat, depth, collapsed, selected, active, onToggle, onSelect, onMove }: RowProps) {
    const path = key(node);
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(path);

    return (
        <>
            <div
                className="tree-row"
                role="treeitem"
                aria-selected={selected.has(path)}
                aria-expanded={hasChildren ? !isCollapsed : undefined}
                aria-level={depth + 1}
                data-path={path}
                data-seat={seat}
                // ONE TAB STOP FOR THE WHOLE TREE — the roving-tabindex pattern every tree control uses.
                // Every row was tabbable, which on a four-hundred-part design is TWO THOUSAND presses of Tab
                // to reach whatever is after the panel. Measured. Inside the tree you move with the arrows,
                // which is what a tree is for and what this component's own help text already promised.
                tabIndex={seat === active ? 0 : -1}
                style={{ paddingLeft: 6 + depth * 13 }}
                // Shift extends the selection. WHAT that means — add, remove, replace — is decided one layer
                // up, so this panel and the canvas cannot come to different conclusions about the same key.
                onClick={(e) => onSelect(path, e.shiftKey ? 'toggle' : 'replace')}
                onKeyDown={(e) => {
                    // Enter and Space select. A tree that can only be driven by mouse is unusable for the one
                    // task it exists for — finding a part in a long list.
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(path, e.shiftKey ? 'toggle' : 'replace');
                        return;
                    }
                    // RIGHT opens a folded group, LEFT folds an open one. Where there is nothing to fold they
                    // fall through to movement, which is what the tree pattern says and what a hand expects:
                    // left on a leaf goes back out to its parent rather than doing nothing at all.
                    if (e.key === 'ArrowRight' && hasChildren && isCollapsed) {
                        e.preventDefault();
                        onToggle(path);
                        return;
                    }
                    if (e.key === 'ArrowLeft' && hasChildren && !isCollapsed) {
                        e.preventDefault();
                        onToggle(path);
                        return;
                    }
                    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                        // UP AND DOWN DID NOTHING, while the canvas's own help text told screen readers that
                        // "arrow keys move between objects in the tree". A promise with no behaviour behind
                        // it is worse than silence: it sends somebody looking for a way through that is not
                        // there.
                        e.preventDefault();
                        onMove(seat, e.key);
                    }
                }}
            >
                <span
                    className="tree-twist"
                    onClick={(e) => {
                        e.stopPropagation(); // twisting open is not selecting
                        if (hasChildren) onToggle(path);
                    }}
                >
                    {hasChildren ? (isCollapsed ? '▸' : '▾') : ''}
                </span>
                <span className="tree-label">{node.label}</span>
                {node.detail && <span className="tree-detail">{node.detail}</span>}
            </div>
            {hasChildren &&
                !isCollapsed &&
                node.children.map((child, i) => (
                    <Row
                        key={`${seat}.${i}`}
                        seat={`${seat}.${i}`}
                        node={child}
                        depth={depth + 1}
                        collapsed={collapsed}
                        selected={selected}
                        onToggle={onToggle}
                        active={active}
                        onSelect={onSelect}
                        onMove={onMove}
                    />
                ))}
        </>
    );
}

export function ObjectTreePanel({
    circuit,
    layout,
    selectedPaths = [],
    onSelect,
}: {
    circuit: CircuitJson | null;
    layout?: LayoutGeometry;
    /**
     * Which row is selected — OWNED BY THE CALLER, not by this panel.
     *
     * It used to be private `useState` here, which made two authorities on one question: clicking a symbol
     * on the canvas told the Inspector and left the tree painting some other row, and clicking a row told
     * the Inspector and left the canvas highlighting nothing. Two panels describing the same document
     * disagreed on screen about what the user had selected, and neither was wrong by its own lights.
     *
     * The remount-on-project-switch that used to be necessary goes with it: a selection held above cannot
     * survive a document it does not belong to, because the same thing that changes the document clears it.
     */
    selectedPaths?: readonly string[];
    onSelect?: (what: TreeNode | readonly TreeNode[] | null, mode?: SelectMode) => void;
}) {
    // Collapse state stays private, and the difference is the point: which rows are folded is about this
    // panel's own appearance, and no other view has an opinion about it. Selection is about the DOCUMENT.
    const [collapsed, setCollapsed] = useState<Set<string>>(COLLAPSED_BY_DEFAULT);
    const chosen = useMemo(() => new Set(selectedPaths), [selectedPaths]);
    /**
     * The row the Tab key reaches, which is not the same question as which row is SELECTED.
     *
     * A tree is one stop in the page's tab order and the arrows move within it. Held here rather than read
     * from the document, because moving the caret is not an edit: walking down a list to look at it must not
     * change what is selected, mark the document unsaved, or mint an undo step.
     */
    const [active, setActive] = useState<string | null>(null);

    // Rebuilt only when a document actually changes. The kernel builds a 400-part board in single-digit
    // milliseconds, but this runs on every keystroke in the editor, and "fast enough" times 60 per second is
    // not fast enough.
    const tree: ObjectTree | null = useMemo(
        () => (circuit ? buildObjectTree(circuit, layout) : null),
        [circuit, layout],
    );

    if (!tree) return <p className="empty">No design loaded.</p>;

    /**
     * Resolve a row's ADDRESS, which is already escaped — do not take it apart.
     *
     * `pathKey` escapes `%` and `/` inside a segment so an id carrying a separator stays addressable.
     * Splitting that escaped string on `/` and handing the pieces to `nodeAt` escapes them a SECOND time
     * (`%2F` becomes `%252F`), so the lookup missed — and a miss becomes `null`, which the one selection
     * rule reads as CLEAR. Clicking a row whose id contained a slash therefore failed to select it AND
     * destroyed whatever the user already had. The map is keyed by exactly this string; ask it directly.
     */
    const select = (path: string, mode: SelectMode) => onSelect?.(tree.byPath.get(path) ?? null, mode);

    const rows = visibleRows(tree.root, collapsed);
    const caret = active !== null && rows.includes(active) ? active : (rows[0] ?? null);

    /**
     * Move the caret, and take the focus with it.
     *
     * Focus is moved through the DOM rather than by re-rendering into an autofocus, because the row that
     * should have it already exists — asking React to remount it would lose the ring for a frame and fight
     * anything else that had focus.
     */
    const move = (from: string, pressed: string) => {
        const here = rows.indexOf(from);
        if (here < 0) return;
        const target =
            pressed === 'Home'
                ? 0
                : pressed === 'End'
                  ? rows.length - 1
                  : pressed === 'ArrowDown'
                    ? Math.min(rows.length - 1, here + 1)
                    : pressed === 'ArrowUp'
                      ? Math.max(0, here - 1)
                      : // RIGHT on a row with nothing to open steps INTO the tree, LEFT on one with nothing
                        // to close steps back out — the two keys read as "further in" and "further out"
                        // rather than doing nothing at all when a row has no children.
                        pressed === 'ArrowRight'
                        ? Math.min(rows.length - 1, here + 1)
                        : Math.max(0, here - 1);
        const path = rows[target];
        if (path === undefined || path === from) return;
        setActive(path);
        // Queued, so the row has been re-rendered as the tabbable one before it is asked to take focus.
        //
        // FOUND BY COMPARING, not by building a selector. A path is ordinary data — it holds ids that came
        // from a document — so putting one inside a selector needs `CSS.escape`, which is absent in older
        // browsers and in the test environment. Reading the attribute back and comparing needs no escaping
        // and cannot be broken by an id containing a quote.
        requestAnimationFrame(() => {
            const el = [...document.querySelectorAll<HTMLElement>('[data-seat]')].find(
                (row) => row.getAttribute('data-seat') === path,
            );
            el?.focus();
        });
    };

    return (
        // DECLARED multi-selectable. A `role="tree"` says single-select unless it says otherwise, so marking
        // several rows `aria-selected` inside one told a screen reader something the tree denied — the reader
        // announces one selection while the user has five.
        <div className="tree" role="tree" aria-label="Design objects" aria-multiselectable="true">
            <Row
                node={tree.root}
                depth={0}
                collapsed={collapsed}
                selected={chosen}
                onToggle={(path) =>
                    setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (!next.delete(path)) next.add(path);
                        return next;
                    })
                }
                seat="0"
                active={caret}
                onSelect={select}
                onMove={move}
            />
            <TreeGaps tree={tree} />
        </div>
    );
}

/**
 * What the projection could not resolve, shown rather than swallowed.
 *
 * A tree that silently omitted these would read as a design that simply does not have them — the reader has
 * no way to tell an absent part from an unjoinable one. Both lists are normally empty, so this is invisible
 * until it matters.
 */
function TreeGaps({ tree }: { tree: ObjectTree }) {
    const { unplaced, ambiguous } = tree;
    if (unplaced.length === 0 && ambiguous.length === 0) return null;

    const byReason = new Map<string, string[]>();
    for (const u of unplaced) byReason.set(u.reason, [...(byReason.get(u.reason) ?? []), u.what]);

    const WORDING: Record<string, string> = {
        'no-layout-component': 'in the design, not on the board',
        'no-circuit-component': 'on the board, not in the design',
        'no-source-pin': 'copper with no pin declared for it',
    };

    return (
        <div className="notice warn">
            <h4>Not fully joined</h4>
            {[...byReason].map(([reason, names]) => (
                <div key={reason}>
                    <span style={{ color: 'var(--text-dim)' }}>{WORDING[reason] ?? reason}</span>
                    <ul>
                        {names.slice(0, 12).map((n) => (
                            <li key={n}>{n}</li>
                        ))}
                        {names.length > 12 && <li>…and {names.length - 12} more</li>}
                    </ul>
                </div>
            ))}
            {ambiguous.length > 0 && (
                <div>
                    <span style={{ color: 'var(--text-dim)' }}>
                        {ambiguous.length} address{ambiguous.length === 1 ? '' : 'es'} claimed twice — those rows cannot
                        be selected individually
                    </span>
                </div>
            )}
        </div>
    );
}
