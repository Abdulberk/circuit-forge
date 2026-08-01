/**
 * Editing a design, as pure functions over the document.
 *
 * WHY THESE LIVE IN THE KERNEL AND NOT IN A COMPONENT. An edit is where a design can be corrupted, and the
 * corruption is rarely loud: a duplicated designator confuses the BOM and the pick-and-place file, a reordered
 * pin array silently re-binds a subcircuit's ports, an empty value produces a SPICE card that will not parse
 * three stages later. Each of those is a one-line mistake in a React handler and a support ticket a week
 * later. Written here, every one of them is a total function with a test.
 *
 * TOTAL, NOT THROWING. Every edit returns either the new document or a refusal that names the reason. A
 * throw would push each caller into a try/catch that ends up showing "something went wrong" — and the whole
 * point is that the user can be told which field is wrong and why.
 *
 * IMMUTABLE. Nothing is mutated in place, so an undo stack can hold the previous value and a React render
 * can compare by reference. That is also what makes step two — a commit kernel — a matter of sequencing
 * these rather than rewriting them.
 *
 * ORDER IS LOAD-BEARING. `Component.pins` is emitted to SPICE in the AUTHORED order for subcircuits, where it
 * must match the macromodel's port order. No edit here reorders a pin array, and any future one must treat
 * that as a deliberate, checked operation rather than an incidental map().
 */
import type { CircuitJson, Component } from '@circuit-forge/eda-core';

/** The outcome of an edit: a new document, or a refusal a UI can put next to the offending field. */
export type EditResult =
    | { ok: true; circuit: CircuitJson; changed: true }
    /** The edit was valid but changed nothing — re-typing the same value. Never a save, never an undo entry. */
    | { ok: true; circuit: CircuitJson; changed: false }
    | { ok: false; reason: EditRefusal; message: string };

export type EditRefusal =
    /** No component with that id — a stale selection, or a document that moved underneath the editor. */
    | 'no-such-component'
    /** A designator must identify exactly one part; two R1s break the BOM, the pick-place file and the netlist. */
    | 'duplicate-designator'
    /** Empty or whitespace where the pipeline needs a token. */
    | 'empty'
    /** Contains characters the downstream format cannot carry. */
    | 'invalid-characters';

const refuse = (reason: EditRefusal, message: string): EditResult => ({ ok: false, reason, message });

/**
 * A designator is an identifier in three formats we do not control: the SPICE netlist, the BOM, and the
 * pick-and-place file. Whitespace and separators break the last two silently — a CSV field with a comma in
 * it shifts every column after it — so they are refused at the point of entry rather than escaped later by
 * whichever exporter remembered to.
 */
const DESIGNATOR_PATTERN = /^[A-Za-z][A-Za-z0-9_$.-]*$/;

/**
 * Rename a part.
 *
 * Uniqueness is checked against every OTHER component, so re-typing a part's own designator is not a
 * conflict with itself. Case-insensitively, because `r1` and `R1` are the same reference to an engineer and
 * to most fabrication software, and a board with both is a board nobody can assemble.
 */
export function setDesignator(circuit: CircuitJson, componentId: string, next: string): EditResult {
    const components = circuit.components ?? [];
    const target = components.find((c) => c.id === componentId);
    if (!target) return refuse('no-such-component', `No component with id "${componentId}".`);

    const trimmed = next.trim();
    if (trimmed.length === 0) return refuse('empty', 'A designator cannot be empty.');
    if (!DESIGNATOR_PATTERN.test(trimmed)) {
        return refuse(
            'invalid-characters',
            'A designator must start with a letter and contain only letters, digits, and _ $ . or -.',
        );
    }
    if (trimmed === target.designator) return { ok: true, circuit, changed: false };

    const clash = components.find((c) => c.id !== componentId && c.designator?.toLowerCase() === trimmed.toLowerCase());
    if (clash) {
        return refuse('duplicate-designator', `${clash.designator} already exists — designators must be unique.`);
    }

    return {
        ok: true,
        changed: true,
        circuit: replaceComponent(circuit, componentId, (c) => ({ ...c, designator: trimmed })),
    };
}

/**
 * Change a part's value.
 *
 * Deliberately NOT parsed or normalised here. The value grammar belongs to eda-core's netlist generator —
 * it is the thing that knows `10k`, `100n`, `DC 5` and `SIN(0 1 1k)` are all legal and that a bare number
 * means different units for a resistor and a source. Re-implementing a subset of that grammar in the editor
 * would produce a second, wrong authority: the editor would reject values the simulator accepts, or accept
 * ones it cannot emit, and the two would drift apart the first time either changed.
 *
 * So the rule here is only what is true of EVERY value: it is present, and it has no leading or trailing
 * space to confuse a downstream tokenizer. Whether it is a legal value is answered by running ERC, which is
 * the authority, and which the editor will surface next to the field.
 */
export function setValue(circuit: CircuitJson, componentId: string, next: string): EditResult {
    const target = (circuit.components ?? []).find((c) => c.id === componentId);
    if (!target) return refuse('no-such-component', `No component with id "${componentId}".`);

    const trimmed = next.trim();
    if (trimmed.length === 0) return refuse('empty', 'A value cannot be empty — remove the field instead.');
    if (trimmed === target.value) return { ok: true, circuit, changed: false };

    return {
        ok: true,
        changed: true,
        circuit: replaceComponent(circuit, componentId, (c) => ({ ...c, value: trimmed })),
    };
}

/**
 * Rename a net.
 *
 * The net's `id` is untouched: every pin references it, and renaming an id would mean rewriting every
 * `PinConnection` in the document — a wide edit for a cosmetic change, and one that would silently
 * disconnect anything the sweep missed. `name` is the label an engineer reads; `id` is the key the machinery
 * uses. Keeping them separate is why this edit is one field wide.
 */
export function setNetName(circuit: CircuitJson, netId: string, next: string): EditResult {
    const nets = circuit.nets ?? [];
    const target = nets.find((n) => n.id === netId);
    if (!target) return refuse('no-such-component', `No net with id "${netId}".`);

    const trimmed = next.trim();
    if (trimmed.length === 0) return refuse('empty', 'A net name cannot be empty.');
    if (trimmed === target.name) return { ok: true, circuit, changed: false };

    const clash = nets.find((n) => n.id !== netId && n.name?.toLowerCase() === trimmed.toLowerCase());
    if (clash) return refuse('duplicate-designator', `A net called ${clash.name} already exists.`);

    return {
        ok: true,
        changed: true,
        circuit: {
            ...circuit,
            nets: nets.map((n) => (n.id === netId ? { ...n, name: trimmed } : n)),
        },
    };
}

/**
 * Swap one component for a modified copy, preserving array ORDER and every untouched field.
 *
 * Order matters beyond tidiness: a diff between two saves is read by a human, and a document whose component
 * array reshuffles on every edit produces a diff nobody can review. `map` rather than filter-and-push for
 * exactly that reason.
 */
function replaceComponent(
    circuit: CircuitJson,
    componentId: string,
    update: (component: Component) => Component,
): CircuitJson {
    return {
        ...circuit,
        components: (circuit.components ?? []).map((c) => (c.id === componentId ? update(c) : c)),
    };
}
