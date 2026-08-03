/**
 * Adding and removing parts — the repair a human makes to a design a machine wrote.
 *
 * Until now every component in every document came from the AI, and the only remedy for one missing
 * decoupling capacitor was to re-prompt and accept whatever else changed with it. For an AI-first product
 * that makes hand repair MORE important rather than less: regeneration is destructive, so the reason a
 * person opens the editor at all is to fix one thing without disturbing the rest.
 *
 * TWO RULES SHAPE THIS.
 *
 * A new part is BORN DISCONNECTED, each pin on a net of its own. That is not a placeholder for a better
 * idea — the schema has no representation of an unconnected pin, and a one-pin net IS what "unconnected"
 * means here, which is exactly what ERC reports. Guessing which net a new capacitor belongs on would be
 * inventing a connection nobody asked for, and a wrong connection is a different circuit that every stage
 * after this one would faithfully build.
 *
 * Deleting is LOSSY and says what it lost. Removing a part strands the nets that only it touched, and a
 * user who is not told that VOUT ceased to exist will look for it later. The same reasoning that made
 * `connectPins` report a merged-away net.
 *
 * DETERMINISTIC, like every edit in this kernel: designators and ids come from scanning what exists, never
 * from a clock or a random source, so undo and redo agree and a test can name the result.
 */
import {
    COMPONENT_PINS,
    DESIGNATOR_PATTERN as CANONICAL_DESIGNATOR_PATTERN,
    SPICE_PREFIXES,
    type CircuitJson,
    type Component,
    type ComponentType,
} from '@circuit-forge/eda-core';

import type { EditRefusal, EditResult } from './edits';

const refuse = (reason: EditRefusal, message: string): EditResult => ({ ok: false, reason, message });

/**
 * Types whose pin list is AUTHORED rather than canonical.
 *
 * `COMPONENT_PINS` gives `[]` for these on purpose — a subcircuit's pins are emitted in authored order to
 * match its `.subckt` port order, and a logic gate's input count is derived from what the author wrote. A
 * part created with no pins would be a part nothing can ever connect to, so these are refused with the
 * reason named rather than created empty and left to puzzle someone.
 */
const isVariableArity = (type: ComponentType): boolean => (COMPONENT_PINS[type] ?? []).length === 0;

/** The next free `R3`-style designator for a type, by scanning what the document already uses. */
function nextDesignator(circuit: CircuitJson, type: ComponentType): string | null {
    const prefix = SPICE_PREFIXES[type];
    if (!prefix) return null; // composite types (transformer) have no single prefix
    const taken = new Set((circuit.components ?? []).map((c) => c.designator.toUpperCase()));
    for (let n = 1; ; n++) {
        const candidate = `${prefix}${n}`;
        if (!taken.has(candidate)) return candidate;
    }
}

/** A net id and name nothing else is using — the same scan `nets.ts` does, for the same reason. */
function freshNets(circuit: CircuitJson, count: number): Array<{ id: string; name: string }> {
    const ids = new Set((circuit.nets ?? []).map((n) => n.id));
    const names = new Set((circuit.nets ?? []).map((n) => n.name?.toLowerCase()));
    const out: Array<{ id: string; name: string }> = [];
    for (let i = 1; out.length < count; i++) {
        const id = `n${i}`;
        const name = `N${i}`;
        if (ids.has(id) || names.has(name.toLowerCase())) continue;
        ids.add(id);
        names.add(name.toLowerCase());
        out.push({ id, name });
    }
    return out;
}

export interface NewPart {
    type: ComponentType;
    /** Omit to take the next free one for this type (`R3`). Supplying one that exists is refused. */
    designator?: string;
    value?: string;
    /** SPICE model name, for the types that need one (diodes, transistors). */
    model?: string;
}

/**
 * Add a part.
 *
 * The id is DERIVED from the designator rather than generated, so a caller who just added `R3` knows to
 * select `r3` without the edit having to hand an id back through a result shape that carries none. It also
 * makes the whole operation replayable: the same document plus the same request is the same document out.
 */
export function addComponent(circuit: CircuitJson, spec: NewPart): EditResult {
    const pins = COMPONENT_PINS[spec.type];
    if (pins === undefined) return refuse('invalid-characters', `"${spec.type}" is not a component type.`);
    if (isVariableArity(spec.type))
        return refuse(
            'invalid-characters',
            `A ${spec.type} has no fixed pin list — its pins are authored to match its own port order, so it cannot be created blank. Add it through the design, not the part palette.`,
        );

    const designator = (spec.designator ?? nextDesignator(circuit, spec.type) ?? '').trim();
    if (designator.length === 0) return refuse('empty', `No designator was given and none could be derived.`);
    if (!CANONICAL_DESIGNATOR_PATTERN.test(designator))
        // The SAME rule the pipeline enforces, imported rather than restated — a second grammar here would
        // accept names the working copy later refuses, minutes after they were typed.
        return refuse('invalid-characters', `"${designator}" is not a valid designator.`);

    const clash = (circuit.components ?? []).find((c) => c.designator.toLowerCase() === designator.toLowerCase());
    if (clash) return refuse('duplicate-designator', `${clash.designator} already exists.`);

    const id = designator.toLowerCase();
    if ((circuit.components ?? []).some((c) => c.id === id))
        return refuse('duplicate-designator', `A component with id "${id}" already exists.`);

    // Each pin on its own net. A new part is unconnected until someone connects it, and pretending
    // otherwise would invent wiring nobody asked for.
    const nets = freshNets(circuit, pins.length);
    const component = {
        id,
        type: spec.type,
        designator,
        ...(spec.value === undefined ? {} : { value: spec.value }),
        ...(spec.model === undefined ? {} : { model: spec.model }),
        pins: pins.map((pinId, i) => ({ pinId, netId: nets[i]!.id })),
    } as Component;

    return {
        ok: true,
        changed: true,
        circuit: {
            ...circuit,
            // Appended, never inserted: a document whose component array reshuffles produces a diff nobody
            // can review, and `Component.pins` order is already load-bearing for subcircuit ports.
            components: [...(circuit.components ?? []), component],
            nets: [...(circuit.nets ?? []), ...nets.map((n) => ({ id: n.id, name: n.name }))],
        },
        note: `${designator} added with ${pins.length} unconnected pin(s) (${nets.map((n) => n.name).join(', ')}).`,
    };
}

/**
 * Remove a part, and the nets it was the last thing holding up.
 *
 * A net nobody sits on is not a node — left behind it shows up in the tree and the netlist as a connection
 * to look for, and there is none. Which ones went is reported, because a user who deletes a regulator and
 * silently loses VOUT will look for it later and conclude the editor lost it.
 */
export function deleteComponent(circuit: CircuitJson, componentId: string): EditResult {
    const target = (circuit.components ?? []).find((c) => c.id === componentId);
    if (!target) return refuse('no-such-component', `No component with id "${componentId}".`);

    const remaining = (circuit.components ?? []).filter((c) => c.id !== componentId);
    const stillUsed = new Set(remaining.flatMap((c) => c.pins.map((p) => p.netId)));

    // Only the nets THIS delete emptied. A net that was already unreferenced before the edit is somebody
    // else's business — sweeping it here would make one deletion quietly remove things the user never
    // touched, and the note would name nets they have no memory of.
    const touched = new Set(target.pins.map((p) => p.netId));
    const orphaned = (circuit.nets ?? []).filter((n) => touched.has(n.id) && !stillUsed.has(n.id));
    const orphanedIds = new Set(orphaned.map((n) => n.id));

    return {
        ok: true,
        changed: true,
        circuit: {
            ...circuit,
            components: remaining,
            nets: (circuit.nets ?? []).filter((n) => !orphanedIds.has(n.id)),
        },
        note: orphaned.length
            ? `${target.designator} removed; ${orphaned.length} net(s) had nothing left on them and are gone (${orphaned.map((n) => n.name).join(', ')}).`
            : `${target.designator} removed.`,
    };
}
