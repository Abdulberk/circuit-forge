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

import { COMPONENT_PINS, type CircuitJson, type ComponentType } from '@circuit-forge/eda-core';
import {
    addComponent,
    deleteComponent,
    disconnectPin,
    movePinToNet,
    setDesignator,
    setNetName,
    setValue,
    type TreeNode,
} from '@circuit-forge/editor-core';
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

/**
 * The parts a user can add.
 *
 * Only the FIXED-ARITY types. A subcircuit's pins are authored to match its own port order and a logic
 * gate's input count is derived from what was written, so `COMPONENT_PINS` gives them an empty list and the
 * kernel refuses to create one blank. Offering them here would put a button on screen whose only outcome is
 * a refusal — the shape this codebase keeps removing, one layer up.
 */
const ADDABLE: ComponentType[] = (
    ['resistor', 'capacitor', 'inductor', 'diode', 'zener', 'bjt', 'mosfet', 'voltage_source'] as ComponentType[]
).filter((t) => (COMPONENT_PINS[t] ?? []).length > 0);

export function AddPart({ doc }: { doc: DocumentState }): React.JSX.Element {
    return (
        <div className="field">
            <label htmlFor="add-part">Add a part</label>{' '}
            <select
                id="add-part"
                value=""
                onChange={(e) => {
                    const type = e.target.value as ComponentType;
                    if (!type) return;
                    // The kernel picks the designator by scanning what exists, so two clicks give R3 then R4
                    // without this component tracking anything.
                    doc.apply((c) => addComponent(c, { type }));
                    e.target.value = '';
                }}
            >
                <option value="">Choose…</option>
                {ADDABLE.map((t) => (
                    <option key={t} value={t}>
                        {t.replace(/_/g, ' ')}
                    </option>
                ))}
            </select>
        </div>
    );
}

export function Inspector({
    selected,
    selectedCount = selected ? 1 : 0,
    circuit,
    doc,
}: {
    selected: TreeNode | null;
    /**
     * How many objects are selected, when the panel can only be about one.
     *
     * A panel of fields has to address a single object, so it shows the primary — the one most recently
     * pointed at. Saying nothing about the others would make an edit here look like it applied to all of
     * them, which is the kind of surprise that costs a user a design.
     */
    selectedCount?: number;
    circuit: CircuitJson | null;
    doc: DocumentState;
}) {
    if (!selected || !circuit) return <p className="empty">Select an object.</p>;

    const { kind, id } = selected.ref;
    const component = kind === 'component' ? (circuit.components ?? []).find((c) => c.id === id) : undefined;
    const net = kind === 'net' ? (circuit.nets ?? []).find((n) => n.id === id) : undefined;

    // A pin: the only place in this app where connectivity can be changed. `componentId` comes off the ref
    // rather than being counted out of the path, because a pin is called `1` or `+` on every second part
    // and its id alone addresses nothing.
    const owner =
        kind === 'pin' && selected.ref.componentId
            ? (circuit.components ?? []).find((c) => c.id === selected.ref.componentId)
            : undefined;
    const pin = owner?.pins.find((p) => p.pinId === id);
    const pinNet = pin ? (circuit.nets ?? []).find((n) => n.id === pin.netId) : undefined;

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
                    <dt />
                    <dd>
                        {/* Deleting is lossy and the kernel says what it lost — the nets this part was the
                            last thing holding up come back as a note, which the status bar renders. */}
                        <button onClick={() => doc.apply((c) => deleteComponent(c, component.id))}>
                            Delete {component.designator}
                        </button>
                    </dd>
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

            {owner && pin && (
                <>
                    <EditableField label="Pin" value={`${owner.designator} · ${pin.pinId}`} readOnly />
                    {/*
                        Connectivity, as a list rather than a canvas. This is the whole point of the kernel
                        work behind it: until now every connection in every document came from the AI and no
                        human could correct one.

                        A SELECT, not a drag: choosing a net from a list means "this pin belongs there", which
                        moves ONLY this pin. Dragging a wire would mean "these become one node" and would
                        bring the pin's existing neighbours along — a merge. They are different operations
                        (`movePinToNet` vs `connectPins`) and offering the wrong one here would silently
                        rewire parts the user never selected.
                    */}
                    <dt>Net</dt>
                    <dd>
                        <select
                            value={pin.netId}
                            aria-label="Net"
                            onChange={(e) =>
                                doc.apply((c) =>
                                    movePinToNet(c, { componentId: owner.id, pinId: pin.pinId }, e.target.value),
                                )
                            }
                        >
                            {(circuit.nets ?? []).map((n) => (
                                <option key={n.id} value={n.id}>
                                    {n.name}
                                    {n.isGround ? ' (ground)' : n.isPower ? ' (power)' : ''}
                                </option>
                            ))}
                        </select>
                    </dd>
                    <dt />
                    <dd>
                        {/* Named for what it does, not for what it is called elsewhere: the pin does not
                            become unconnected — the schema has no such state — it lands on a net of its
                            own, which is what "unconnected" means to ERC. */}
                        <button
                            onClick={() =>
                                doc.apply((c) => disconnectPin(c, { componentId: owner.id, pinId: pin.pinId }))
                            }
                        >
                            Move to its own net
                        </button>
                    </dd>
                    {pinNet && pinNet.isGround && <EditableField label="Role" value="ground" readOnly />}
                    {pinNet && pinNet.isPower && <EditableField label="Role" value="power rail" readOnly />}
                </>
            )}

            {!component && !net && !pin && (
                <>
                    <EditableField label="Name" value={selected.label} readOnly />
                    <EditableField label="Kind" value={selected.ref.kind} readOnly />
                </>
            )}

            {selectedCount > 1 && (
                <div className="notice" role="status" style={{ marginTop: 8 }}>
                    {selectedCount} objects selected. These fields are about {selected.label}; Delete and the keyboard
                    verbs act on all of them.
                </div>
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
