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

// The tree already answers "is this a part someone places, or an annotation" — imported rather than restated,
// because a second answer here is a second thing to keep in step.
import { isPlaceablePart } from '../tree/object-tree';

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

/**
 * The next free `R3`-style designator for a type, by scanning what the document already uses.
 *
 * FREE AS A DESIGNATOR **AND** AS AN ID, because the id is derived from it a few lines below. Skipping only
 * taken designators produced names whose derived id was already somebody else's, and the add was then
 * refused — permanently, since nothing retried, and with a message naming an internal id the user has never
 * seen. Measured on a shipped template: `01-alu-8bit` names its gates `g0`, `g1`, … with designators
 * `U0`, `U1`, …, and the SPICE prefix for a VCCS is `G` — so the first free designator was `G1`, whose id
 * `g1` was a logic gate, and no VCCS could ever be added to that design. The same trap closes on any
 * document after one rename: rename `R9` to `R20` and the id stays `r9`, so the next resistor is refused.
 */
function nextDesignator(circuit: CircuitJson, type: ComponentType): string | null {
    const prefix = SPICE_PREFIXES[type];
    if (!prefix) return null; // composite types (transformer) have no single prefix
    const parts = circuit.components ?? [];
    const takenNames = new Set(parts.map((c) => c.designator.toUpperCase()));
    const takenIds = new Set(parts.map((c) => c.id));
    for (let n = 1; ; n++) {
        const candidate = `${prefix}${n}`;
        if (!takenNames.has(candidate) && !takenIds.has(candidate.toLowerCase())) return candidate;
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
    /**
     * Catalogue identity, when the part came from one rather than being a generic.
     *
     * Carried because these fields are what make the rest of the pipeline able to tell the truth about a
     * board: `mpn` and `footprint` are what the package-agreement check compares (a part ordered as a WSON
     * against SOIC pads is refused), `tolerance` is what the robustness verdict spreads over instead of
     * assuming ±5%, and `sourcing` is what the BOM can actually be ordered from. Dropping them here would
     * turn a real part into a generic the moment it entered the document.
     */
    mpn?: string;
    manufacturer?: string;
    footprint?: string;
    tolerance?: number;
    toleranceSource?: 'user' | 'catalog';
    sourcing?: Record<string, unknown>;
    /**
     * The pin shape to build, when the caller already knows it — copying an existing part.
     *
     * Omit it and the part gets the canonical shape for its type, which is what the palette wants. It is
     * needed because the canonical shape is not always the right one:
     *
     *  - VARIABLE-ARITY types (a subckt, a logic gate, a catalogue generic) have no canonical shape at all,
     *    so without this they cannot be created here and COPYING one was refused outright.
     *  - OPTIONAL pins are real. A flip-flop authored without `set`/`rst` is auto-tied to the inactive rail
     *    by the netlist generator; give its copy those two pins on fresh private nets and they become real
     *    floating nodes. The copy would look identical on the sheet and behave differently.
     *
     * Every pin still gets its own fresh net: an authored SHAPE is not authored WIRING.
     */
    pins?: readonly string[];
}

/**
 * Add a part.
 *
 * The id is DERIVED from the designator rather than generated, so a caller who just added `R3` knows to
 * select `r3` without the edit having to hand an id back through a result shape that carries none. It also
 * makes the whole operation replayable: the same document plus the same request is the same document out.
 */
export function addComponent(circuit: CircuitJson, spec: NewPart): EditResult {
    const canonical = COMPONENT_PINS[spec.type];
    if (canonical === undefined) return refuse('invalid-characters', `"${spec.type}" is not a component type.`);
    if (spec.pins === undefined && isVariableArity(spec.type))
        return refuse(
            'invalid-characters',
            `A ${spec.type} has no fixed pin list — its pins are authored to match its own port order, so it cannot be created blank. Add it through the design, not the part palette.`,
        );

    const pins = spec.pins ?? canonical;
    if (pins.length === 0) return refuse('empty', `A part needs at least one pin.`);
    if (new Set(pins).size !== pins.length) return refuse('invalid-characters', `A pin is named twice.`);
    // A fixed-arity type's pins are resolved BY NAME against the canonical list everywhere downstream — the
    // netlist generator refuses a deck outright if one is missing — so an authored shape may leave OPTIONAL
    // pins out but may not invent names. Unchecked, a copy could carry a pin no analysis will ever find.
    if (spec.pins && !isVariableArity(spec.type)) {
        const stray = spec.pins.find((id) => !canonical.includes(id));
        if (stray !== undefined) return refuse('invalid-characters', `"${stray}" is not a pin of a ${spec.type}.`);
    }

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
    // Every optional field is omitted when absent rather than written as `undefined`: the working copy is
    // compared and diffed, and a key that exists with no value is a change nobody made.
    const optional = (
        ['value', 'model', 'mpn', 'manufacturer', 'footprint', 'tolerance', 'toleranceSource', 'sourcing'] as const
    )
        .filter((k) => spec[k] !== undefined)
        .reduce<Record<string, unknown>>((acc, k) => ({ ...acc, [k]: spec[k] }), {});

    const component = {
        id,
        type: spec.type,
        designator,
        ...optional,
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

/**
 * Copy parts, with the connections that are ENTIRELY among them.
 *
 * WHAT A COPY MEANS, decided here rather than in a canvas. Two questions have to be answered and neither is
 * obvious from the word "duplicate":
 *
 * WIRING BETWEEN THE COPIES IS KEPT, on nets of its own. Copying a divider and getting two loose resistors
 * would make the gesture useless for the thing people copy — a sub-circuit they want another of. So a net
 * with two or more of the copied terminals on it is reproduced as a FRESH net joining the copies, and the
 * originals keep theirs untouched.
 *
 * WIRING TO EVERYTHING ELSE IS DROPPED. A copied terminal whose net reaches outside the selection gets a
 * fresh net of its own: the copy arrives unconnected there. Keeping it would silently join the new parts to
 * the existing circuit — five parts pasted and five connections nobody asked for, in a document where a
 * connection is the whole meaning — and a user cannot see what they did not ask for in order to undo it.
 *
 * EXCEPT THE REFERENCE, which is shared rather than copied. Ground is one node for the whole design; minting
 * a second ground net would produce two references that are drawn identically — every ground symbol looks
 * like every other — and no reader could tell them apart. The same will hold for a declared power rail when
 * anything authors one.
 *
 * The copies are returned in `created`, in the order they were asked for, because a caller that has just
 * pasted five parts needs to select and place them and cannot derive their ids: designators are allocated
 * against a document that is changing as each one lands.
 */
export function duplicateComponents(circuit: CircuitJson, ids: readonly string[]): EditResult {
    const asked = ids.map((id) => (circuit.components ?? []).find((c) => c.id === id));
    const missing = ids.filter((_id, i) => !asked[i]);
    if (missing.length > 0) return refuse('no-such-component', `No component with id "${missing[0]}".`);

    // NET MARKERS ARE SKIPPED, not refused. A ground symbol is notation — it has no designator prefix, so
    // `addComponent` cannot name a copy of one and the whole call failed with "no designator could be
    // derived" the moment a box selection happened to catch one. Copying it would be meaningless anyway: the
    // drawing marks every ground terminal for itself, so the copy's reference is already drawn.
    const originals = asked.filter((c) => isPlaceablePart(c!));
    if (originals.length === 0) return { ok: true, circuit, changed: false };

    // GROUND AND THE SUPPLY RAILS, for the same reason: these are the nets a sheet MARKS rather than wires.
    // Every other connection out of the selection is deliberately cut, because a copy that silently joined
    // the original's signal nets would be a second part on the same node rather than a second stage. A rail
    // is not that — it is global by definition, drawn as a marker at each terminal that touches it, and a
    // copy dropped onto a fresh private net would come back unpowered AND unmarked, since the marker follows
    // the net's own flag. Ground behaved this way already; the rails did not, which made "copy this stage"
    // mean two different things depending on which end of the part you looked at.
    const shared = new Set((circuit.nets ?? []).filter((n) => n.isGround || n.isPower).map((n) => n.id));

    // WHAT WAS ALREADY HERE IS NOT OURS TO REMOVE. The prune below exists to drop the private nets
    // `addComponent` mints for a copy's unconnected pins — and it used to drop every unreferenced net, which
    // meant copying one resistor silently deleted a net somebody had NAMED and not yet wired to anything.
    // A copy is an addition; it must not be able to lose part of the design it was copied from.
    const existing = new Set((circuit.nets ?? []).map((n) => n.id));

    // How many terminals of each net are inside the selection: two or more means the connection is between
    // copies and travels with them.
    const inside = new Map<string, number>();
    for (const c of originals)
        for (const pin of c!.pins) if (!shared.has(pin.netId)) inside.set(pin.netId, (inside.get(pin.netId) ?? 0) + 1);

    let next = circuit;
    const created: string[] = [];
    const netFor = new Map<string, string>();

    for (const original of originals) {
        // Through `addComponent`, so a copy is validated, named and given fresh nets by the same rule any
        // other new part is. A second creation path here would be a second set of answers to "what is a
        // legal part", and the two would drift.
        const spec: NewPart = {
            type: original!.type,
            ...(original!.value !== undefined ? { value: original!.value } : {}),
            ...(original!.model !== undefined ? { model: original!.model } : {}),
            ...(original!.mpn !== undefined ? { mpn: original!.mpn } : {}),
            ...(original!.manufacturer !== undefined ? { manufacturer: original!.manufacturer } : {}),
            ...(original!.footprint !== undefined ? { footprint: original!.footprint } : {}),
            ...(original!.tolerance !== undefined ? { tolerance: original!.tolerance } : {}),
            ...(original!.toleranceSource !== undefined ? { toleranceSource: original!.toleranceSource } : {}),
            ...(original!.sourcing !== undefined
                ? { sourcing: original!.sourcing as unknown as Record<string, unknown> }
                : {}),
            // THE ORIGINAL'S OWN SHAPE, which settles three things at once. A logic gate or a subckt has no
            // canonical shape, so copying one was refused outright. A flip-flop authored without `set`/`rst`
            // would have gained them on fresh private nets — real floating inputs where the generator had
            // been auto-tying them to the inactive rail, a copy that looks identical and behaves otherwise.
            // And the copy's pins now arrive in the original's order, so there is no question of matching
            // them up afterwards.
            pins: original!.pins.map((q) => q.pinId),
        };
        const added = addComponent(next, spec);
        if (!added.ok) return added;
        next = added.circuit;
        const copy = (next.components ?? [])[(next.components ?? []).length - 1]!;
        created.push(copy.id);

        // EVERYTHING ELSE THE PART CARRIED. `NewPart` names the fields the palette knows about, and a
        // document can hold more — `properties` is where a transmission line's impedance and delay live, and
        // a copy without them is a part the netlist generator cannot emit at all. Carried by DIFFERENCE
        // rather than by another hand-written list, which is how the first list came to be short.
        const {
            id: _id,
            designator: _designator,
            pins: _pins,
            ...rest
        } = original as unknown as Record<string, unknown>;
        // A key present with no value is a change nobody made — the working copy is compared and diffed to
        // decide what is unsaved, so an `undefined` carried across would mark a document dirty on arrival.
        const carried = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
        next = {
            ...next,
            components: (next.components ?? []).map((c) => (c.id === copy.id ? ({ ...carried, ...c } as typeof c) : c)),
        };

        // Re-point the copy's pins: shared nets as they were, internal ones onto one fresh net per original
        // net, and everything else left on the private net `addComponent` already gave it.
        //
        // BY PIN ID. The copy was built from the original's shape above, so the two agree pin for pin — but
        // the lookup is by name rather than by position because that is the contract everything downstream
        // uses (the netlist generator resolves `c b e` by name and refuses a deck missing one). Matched by
        // POSITION, as it was, a diode stored cathode-first came back with its anode on the net its cathode
        // had been on: the same part wired backwards, drawn identically, and nothing would have caught it.
        const wasOn = new Map(original!.pins.map((q) => [q.pinId, q.netId]));
        const pins = copy.pins.map((pin) => {
            const was = wasOn.get(pin.pinId);
            if (was === undefined) return pin; // a pin the original did not have: leave it on its own net
            if (shared.has(was)) return { ...pin, netId: was };
            if ((inside.get(was) ?? 0) < 2) return pin;
            const mapped = netFor.get(was) ?? pin.netId;
            netFor.set(was, mapped);
            return { ...pin, netId: mapped };
        });
        next = {
            ...next,
            components: (next.components ?? []).map((c) => (c.id === copy.id ? { ...c, pins } : c)),
        };
    }

    // ONCE, at the end, and against a set built in one pass. Pruning inside the loop re-read every net
    // against every pin of every component for every part copied — quadratic in the size of the SHEET, not of
    // the selection, so duplicating a handful of parts on a large design took over a second while the sheet
    // sat still. The answer is the same either way; only the cost differed.
    const referenced = new Set<string>();
    for (const c of next.components ?? []) for (const pin of c.pins) referenced.add(pin.netId);
    next = { ...next, nets: (next.nets ?? []).filter((n) => referenced.has(n.id) || existing.has(n.id)) };

    return {
        ok: true,
        changed: true,
        circuit: next,
        created,
        // Said, not left to be inferred: the caller places each copy relative to the part it came from, and
        // `created` no longer lines up with the ids it was ASKED about now that markers are skipped.
        derivedFrom: originals.map((c) => c!.id),
        note:
            created.length === 1
                ? undefined
                : `Copied ${created.length} parts; connections among them were kept, connections to the rest of the design were not.`,
    };
}
