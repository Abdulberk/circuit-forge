'use client';

/**
 * The properties panel — the first place in this app where a user changes a design.
 *
 * Every field commits on blur and on Enter, and reverts on Escape. That is not a style choice: an editor that
 * commits on every keystroke turns "1k" into an edit for "1" and then "1k", and the intermediate is a value
 * that means something different. Committing on blur also gives the refusal somewhere to appear while the
 * field still has focus context — "R1 already exists" beside the box you typed it in.
 *
 * The field owns its DRAFT text; the document owns the committed value. Keeping those separate is what lets
 * a refusal leave your typing on screen instead of snapping back to the old value and losing what you wrote.
 */

import type { CircuitJson } from '@circuit-forge/eda-core';
import { setDesignator, setNetName, setValue, type TreeNode } from '@circuit-forge/editor-core';
import { useEffect, useRef, useState } from 'react';

import type { DocumentState } from '../lib/useDocument';

/**
 * A field is either editable — in which case it MUST say where a commit goes — or read-only, in which case a
 * commit handler is meaningless. Expressed as a union rather than an optional flag so "read-only, and here is
 * what to do when it changes" cannot be written at all.
 */
type FieldProps =
    | { label: string; value: string; readOnly: true }
    | { label: string; value: string; readOnly?: false; onCommit: (next: string) => void };

function EditableField(props: FieldProps) {
    const { label, value } = props;
    const [draft, setDraft] = useState(value);
    const committed = useRef(value);

    // Adopt a new value when the SELECTION changes or the document is reloaded — but never while the user is
    // mid-edit, which would yank the text out from under them.
    useEffect(() => {
        committed.current = value;
        setDraft(value);
    }, [value]);

    if (props.readOnly) {
        return (
            <div className="field">
                <dt>{label}</dt>
                <dd style={{ color: 'var(--text-faint)' }}>{value}</dd>
            </div>
        );
    }

    return (
        <div className="field">
            <dt>{label}</dt>
            <dd>
                <input
                    className="mono"
                    value={draft}
                    aria-label={label}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => {
                        if (draft !== committed.current) props.onCommit(draft);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.currentTarget.blur(); // blur commits, so there is one commit path, not two
                        } else if (e.key === 'Escape') {
                            setDraft(committed.current);
                            e.currentTarget.blur();
                        }
                    }}
                />
            </dd>
        </div>
    );
}

export function Inspector({
    selected,
    circuit,
    doc,
}: {
    selected: TreeNode | null;
    circuit: CircuitJson | null;
    doc: DocumentState;
}) {
    if (!selected || !circuit) return <p className="empty">Select an object.</p>;

    const { kind, id } = selected.ref;
    const component = kind === 'component' ? (circuit.components ?? []).find((c) => c.id === id) : undefined;
    const net = kind === 'net' ? (circuit.nets ?? []).find((n) => n.id === id) : undefined;

    return (
        <dl>
            {component && (
                <>
                    <EditableField
                        label="Designator"
                        value={component.designator}
                        onCommit={(next) => doc.apply((c) => setDesignator(c, component.id, next))}
                    />
                    {/* Only offered where the part HAS one. A ground marker or a bare IC has no value, and an
                        empty box inviting one would be asking the user to author a field the netlist
                        generator does not read for that type. */}
                    {component.value !== undefined && (
                        <EditableField
                            label="Value"
                            value={component.value}
                            onCommit={(next) => doc.apply((c) => setValue(c, component.id, next))}
                        />
                    )}
                    <EditableField label="Type" value={component.type} readOnly />
                    {component.model && <EditableField label="Model" value={component.model} readOnly />}
                    <EditableField label="Pins" value={String(component.pins?.length ?? 0)} readOnly />
                </>
            )}

            {net && (
                <>
                    <EditableField
                        label="Net"
                        value={net.name}
                        onCommit={(next) => doc.apply((c) => setNetName(c, net.id, next))}
                    />
                    {net.isGround && <EditableField label="Role" value="ground" readOnly />}
                </>
            )}

            {!component && !net && (
                <>
                    <EditableField label="Name" value={selected.label} readOnly />
                    <EditableField label="Kind" value={selected.ref.kind} readOnly />
                </>
            )}

            <EditableField label="Id" value={selected.ref.id} readOnly />
            <EditableField label="Path" value={selected.ref.path.join(' / ')} readOnly />

            {doc.refusal && (
                <div className="notice bad" role="alert" style={{ marginTop: 8 }}>
                    {doc.refusal.message}
                </div>
            )}
        </dl>
    );
}
