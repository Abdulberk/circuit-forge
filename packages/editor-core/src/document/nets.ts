/**
 * Connectivity: the edits that decide what is wired to what.
 *
 * Everything else the editor can do is cosmetic beside this. A wrong value produces a circuit that
 * simulates to the wrong number; a wrong CONNECTION produces a different circuit entirely, and one that
 * every downstream stage will faithfully build, route, manufacture and ship.
 *
 * THE SCHEMA DECIDES THE VOCABULARY. `PinConnection.netId` is REQUIRED — there is no representation of an
 * unconnected pin. A pin is always on some net; a pin nobody else shares a net with is what "unconnected"
 * means here, and ERC is what calls it out. So the primitive is not "add a wire", it is "these two pins are
 * on the same net", and every operation below is a rearrangement of pins across nets.
 *
 * MERGING IS LOSSY, AND SAYING SO IS THE POINT. Two nets have two names; afterwards there is one. A user
 * who joins VOUT to GND has not just made a connection, they have made VOUT stop existing — and if nobody
 * tells them, they will look for it later and conclude the editor lost it. Every operation that destroys a
 * net reports what it destroyed.
 *
 * ONE REFUSAL THAT IS NOT ABOUT VALIDITY. Joining a net declared ground to one declared a power rail is a
 * short across the supply. It is perfectly representable, and it is never what anyone means, so it is
 * refused with the remedy named — change the role first — rather than accepted and left for a check three
 * stages later to find in copper.
 *
 * DETERMINISTIC, like every edit in this kernel: generated ids and names come from scanning what already
 * exists, never from a clock or a random source. An undo that produced a different id than the redo would
 * make history unreplayable, and a test that could not predict the id could not assert on it.
 */
import type { CircuitJson, Component, Net, PinRef } from '@circuit-forge/eda-core';

import type { EditRefusal, EditResult } from './edits';

const refuse = (reason: EditRefusal, message: string): EditResult => ({ ok: false, reason, message });

/** Locate a pin, or say which half was missing — "no such pin" alone sends the reader to the wrong place. */
function findPin(circuit: CircuitJson, ref: PinRef): { component: Component; netId: string } | string {
    const component = (circuit.components ?? []).find((c) => c.id === ref.componentId);
    if (!component) return `No component with id "${ref.componentId}".`;
    const pin = component.pins.find((p) => p.pinId === ref.pinId);
    if (!pin) return `${component.designator} has no pin "${ref.pinId}".`;
    return { component, netId: pin.netId };
}

const netById = (circuit: CircuitJson, id: string): Net | undefined => (circuit.nets ?? []).find((n) => n.id === id);

/**
 * A set key for a pin.
 *
 * JSON rather than a separator character. Ids are free-form strings in this schema, so ANY delimiter can
 * in principle appear inside one and make two different pins share a key — and the first version of this
 * file reached for a null byte to dodge that, which made the source file read as binary to every tool that
 * touched it. Encoding the pair removes the question instead of betting on it.
 */
const pinKey = (ref: PinRef): string => JSON.stringify([ref.componentId, ref.pinId]);

/** Every pin in the document that sits on this net. */
function pinsOn(circuit: CircuitJson, netId: string): PinRef[] {
    const out: PinRef[] = [];
    for (const c of circuit.components ?? []) {
        for (const p of c.pins) if (p.netId === netId) out.push({ componentId: c.id, pinId: p.pinId });
    }
    return out;
}

/**
 * An id and a name nothing else is using.
 *
 * Derived by scanning, not generated randomly, so the same edit on the same document always produces the
 * same net — which is what makes undo/redo replayable and what lets a test name the result. Names are
 * compared case-insensitively because `setNetName` treats them that way, and two rules that disagree about
 * what a collision is would let one of them create what the other refuses.
 */
function freshNet(circuit: CircuitJson): { id: string; name: string } {
    const ids = new Set((circuit.nets ?? []).map((n) => n.id));
    const names = new Set((circuit.nets ?? []).map((n) => n.name?.toLowerCase()));
    for (let i = 1; ; i++) {
        const id = `n${i}`;
        const name = `N${i}`;
        if (!ids.has(id) && !names.has(name.toLowerCase())) return { id, name };
    }
}

/** Move every pin sitting on `fromNetId` onto `toNetId`, preserving pin ORDER within each component. */
function repoint(circuit: CircuitJson, fromNetId: string, toNetId: string): CircuitJson {
    return {
        ...circuit,
        components: (circuit.components ?? []).map((c) =>
            c.pins.some((p) => p.netId === fromNetId)
                ? { ...c, pins: c.pins.map((p) => (p.netId === fromNetId ? { ...p, netId: toNetId } : p)) }
                : c,
        ),
    };
}

/**
 * Which of two nets survives a merge.
 *
 * A DECLARED ROLE outranks a plain signal name, because losing "this net is ground" is a larger loss than
 * losing a label: the flag drives supply-rail checks and pour assignment downstream, and a name can be
 * retyped. Between two nets of equal rank the DESTINATION wins — you drag from a pin to a net and the pin
 * joins it, which is the gesture every schematic tool uses and the only reading under which the parameter
 * order means anything.
 *
 * The rule was "the first argument wins" until a test read the assertion out loud and it was obviously
 * backwards: `connectPins(c, loosePin, groundPin)` should put the loose pin on ground, not rename ground
 * after the loose pin's net.
 */
function rank(net: Net): number {
    if (net.isGround) return 2;
    if (net.isPower) return 1;
    return 0;
}

/**
 * Put two pins on the same net.
 *
 * The one operation an editor cannot do without, and the reason `connectPins` rather than `addWire`: a wire
 * is a drawing, and two pins being on one net is the electrical fact the drawing depicts. Drawing lives in
 * `UiJson`; this is the design.
 */
export function connectPins(circuit: CircuitJson, from: PinRef, to: PinRef): EditResult {
    const pa = findPin(circuit, from);
    if (typeof pa === 'string') return refuse('no-such-pin', pa);
    const pb = findPin(circuit, to);
    if (typeof pb === 'string') return refuse('no-such-pin', pb);

    if (from.componentId === to.componentId && from.pinId === to.pinId)
        return refuse('no-such-pin', 'A pin cannot be connected to itself.');

    // Already the same node. Not an error and not a change — re-drawing a connection that exists must not
    // become an undo step the user has to press twice to get past.
    if (pa.netId === pb.netId) return { ok: true, circuit, changed: false };

    const na = netById(circuit, pa.netId);
    const nb = netById(circuit, pb.netId);
    if (!na)
        return refuse('no-such-net', `${pa.component.designator} pin ${from.pinId} names a net that does not exist.`);
    if (!nb)
        return refuse('no-such-net', `${pb.component.designator} pin ${to.pinId} names a net that does not exist.`);

    // The one connection that is representable and never meant. Refused with the remedy named, because the
    // alternative is a dead short discovered in copper — or worse, in a built board.
    if ((na.isGround && nb.isPower) || (na.isPower && nb.isGround)) {
        const [gnd, pwr] = na.isGround ? [na, nb] : [nb, na];
        return refuse(
            'rail-short',
            `${gnd.name} is declared ground and ${pwr.name} is declared a power rail — connecting them shorts the supply. If one of them is marked wrongly, change its role first.`,
        );
    }

    const [keep, absorb] = rank(nb) >= rank(na) ? [nb, na] : [na, nb];
    const moved = repoint(circuit, absorb.id, keep.id);

    return {
        ok: true,
        changed: true,
        circuit: {
            ...moved,
            // The absorbed net is REMOVED, not left behind empty: a net with no pins is not a node, and a
            // netlist carrying one invites a reader to look for the connection it implies.
            nets: (moved.nets ?? []).filter((n) => n.id !== absorb.id),
        },
        // Said out loud. A user who joins VOUT to GND has made VOUT cease to exist, and discovering that by
        // its absence later is how an editor earns a reputation for losing things.
        note: `${absorb.name} merged into ${keep.name}.`,
    };
}

/**
 * Take a pin off whatever it shares a net with.
 *
 * It lands on a NEW net of its own rather than on nothing, because the schema has no "nothing" — and that
 * is the honest model anyway: a pin wired to no other pin is a one-pin node, which is exactly what ERC
 * reports as unconnected.
 */
export function disconnectPin(circuit: CircuitJson, ref: PinRef): EditResult {
    const found = findPin(circuit, ref);
    if (typeof found === 'string') return refuse('no-such-pin', found);

    const old = netById(circuit, found.netId);
    if (!old)
        return refuse('no-such-net', `${found.component.designator} pin ${ref.pinId} names a net that does not exist.`);

    const others = pinsOn(circuit, found.netId).filter(
        (p) => !(p.componentId === ref.componentId && p.pinId === ref.pinId),
    );
    // Already alone: moving it to another one-pin net would change the net's name and nothing electrical.
    if (others.length === 0) return { ok: true, circuit, changed: false };

    const fresh = freshNet(circuit);
    const moved = {
        ...circuit,
        components: (circuit.components ?? []).map((c) =>
            c.id === ref.componentId
                ? { ...c, pins: c.pins.map((p) => (p.pinId === ref.pinId ? { ...p, netId: fresh.id } : p)) }
                : c,
        ),
        nets: [...(circuit.nets ?? []), { id: fresh.id, name: fresh.name }],
    };

    return {
        ok: true,
        changed: true,
        circuit: moved,
        note:
            others.length === 1
                ? `${found.component.designator} pin ${ref.pinId} is now on ${fresh.name}, and ${old.name} is left with a single pin.`
                : `${found.component.designator} pin ${ref.pinId} is now on ${fresh.name}.`,
    };
}

/**
 * Break one net into two by moving a chosen set of pins onto a new one.
 *
 * The operation an editor needs when a net was joined too eagerly — by an AI that tied two things it should
 * not have, or by a click on the wrong pin. Without it the only repair is to disconnect every pin
 * individually and reconnect them, which is the kind of tedium that makes people edit the JSON by hand.
 */
export function splitNet(circuit: CircuitJson, netId: string, take: readonly PinRef[]): EditResult {
    const net = netById(circuit, netId);
    if (!net) return refuse('no-such-net', `No net with id "${netId}".`);

    const on = pinsOn(circuit, netId);
    const onKey = new Set(on.map((p) => pinKey(p)));

    for (const ref of take) {
        const found = findPin(circuit, ref);
        if (typeof found === 'string') return refuse('no-such-pin', found);
        if (!onKey.has(pinKey(ref)))
            return refuse(
                'pin-not-on-net',
                `${found.component.designator} pin ${ref.pinId} is on ${netById(circuit, found.netId)?.name ?? found.netId}, not on ${net.name}.`,
            );
    }

    // Deduplicated: naming the same pin twice must not make the counts below disagree with reality.
    const takeKeys = new Set(take.map((p) => pinKey(p)));
    if (takeKeys.size === 0 || takeKeys.size === on.length)
        return refuse(
            'pointless-split',
            takeKeys.size === 0
                ? 'Choose at least one pin to move onto a new net.'
                : `Moving every pin of ${net.name} would rename it, not split it.`,
        );

    const fresh = freshNet(circuit);
    const moved = {
        ...circuit,
        components: (circuit.components ?? []).map((c) => {
            if (!c.pins.some((p) => takeKeys.has(pinKey({ componentId: c.id, pinId: p.pinId })))) return c;
            return {
                ...c,
                pins: c.pins.map((p) =>
                    takeKeys.has(pinKey({ componentId: c.id, pinId: p.pinId })) ? { ...p, netId: fresh.id } : p,
                ),
            };
        }),
        // The new net does NOT inherit isGround/isPower. A role is a declaration about a node, and the split
        // half is a different node — carrying the flag across would silently declare a second ground.
        nets: [...(circuit.nets ?? []), { id: fresh.id, name: fresh.name }],
    };

    return {
        ok: true,
        changed: true,
        circuit: moved,
        note: `${takeKeys.size} of ${on.length} pins moved from ${net.name} to ${fresh.name}.`,
    };
}
