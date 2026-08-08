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
import {
    buildObjectTree,
    nodeAt,
    pathKey,
    type ObjectTree,
    type SelectMode,
    type TreeNode,
} from '@circuit-forge/editor-core';
import type { LayoutGeometry } from '@circuit-forge/pcb-contract';
import { useMemo, useState } from 'react';

const key = (node: TreeNode) => pathKey(node.ref.path);

/** Groups start open; a design with one board is more useful expanded than as a single row saying "Root". */
const COLLAPSED_BY_DEFAULT = new Set<string>();

interface RowProps {
    node: TreeNode;
    depth: number;
    collapsed: Set<string>;
    selected: ReadonlySet<string>;
    onToggle: (path: string) => void;
    onSelect: (path: string, mode: SelectMode) => void;
}

function Row({ node, depth, collapsed, selected, onToggle, onSelect }: RowProps) {
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
                tabIndex={0}
                style={{ paddingLeft: 6 + depth * 13 }}
                // Shift extends the selection. WHAT that means — add, remove, replace — is decided one layer
                // up, so this panel and the canvas cannot come to different conclusions about the same key.
                onClick={(e) => onSelect(path, e.shiftKey ? 'toggle' : 'replace')}
                onKeyDown={(e) => {
                    // Enter and Space select; the arrows expand and collapse. A tree that can only be driven
                    // by mouse is unusable for the one task it exists for — finding a part in a long list.
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(path, e.shiftKey ? 'toggle' : 'replace');
                    } else if (e.key === 'ArrowRight' && hasChildren && isCollapsed) {
                        onToggle(path);
                    } else if (e.key === 'ArrowLeft' && hasChildren && !isCollapsed) {
                        onToggle(path);
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
                node.children.map((child) => (
                    <Row
                        key={key(child)}
                        node={child}
                        depth={depth + 1}
                        collapsed={collapsed}
                        selected={selected}
                        onToggle={onToggle}
                        onSelect={onSelect}
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

    // Rebuilt only when a document actually changes. The kernel builds a 400-part board in single-digit
    // milliseconds, but this runs on every keystroke in the editor, and "fast enough" times 60 per second is
    // not fast enough.
    const tree: ObjectTree | null = useMemo(
        () => (circuit ? buildObjectTree(circuit, layout) : null),
        [circuit, layout],
    );

    if (!tree) return <p className="empty">No design loaded.</p>;

    const select = (path: string, mode: SelectMode) => onSelect?.(nodeAt(tree, path.split('/')) ?? null, mode);

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
                onSelect={select}
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
