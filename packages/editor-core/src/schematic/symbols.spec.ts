/**
 * Symbols, for every component type the system can express — not for the handful someone drew.
 *
 * The rule under test is the one that makes this safe for a catalogue of hundreds of thousands of parts: a
 * symbol is a CLAIM, so a part is either drawn by a convention that genuinely applies to it, or derived as a
 * labelled box from its own pins. There is no third option, and in particular there is no "nearest match".
 */
import { COMPONENT_TYPES, type Component } from '@circuit-forge/eda-core';

import { DRAWN_TYPES, UNDRAWN_BY_DESIGN, symbolFor } from './symbols';

const part = (type: string, pinIds: string[]): Pick<Component, 'type' | 'pins'> =>
    ({ type, pins: pinIds.map((pinId) => ({ pinId, netId: 'n' })) }) as Pick<Component, 'type' | 'pins'>;

describe('every component type produces a usable symbol', () => {
    it('covers EVERY type in COMPONENT_TYPES, with no gaps and no throws', () => {
        // The generality claim, checked exhaustively rather than sampled. A type added tomorrow lands here.
        for (const type of COMPONENT_TYPES) {
            const geometry = symbolFor(part(type, ['1', '2']));
            expect({ type, hasPins: geometry.pins.length > 0, hasBody: geometry.strokes.length > 0 }).toEqual({
                type,
                hasPins: true,
                hasBody: true,
            });
        }
    });

    it('exposes EVERY pin the part declares — a symbol that hides one hides a connection', () => {
        // The failure this prevents is silent: a 16-pin IC drawn with 8 pins looks fine and is wrong.
        for (const type of COMPONENT_TYPES) {
            for (const count of [1, 2, 3, 5, 8, 16, 40]) {
                const pinIds = Array.from({ length: count }, (_, i) => `p${i + 1}`);
                const geometry = symbolFor(part(type, pinIds));
                expect({ type, count, shown: geometry.pins.map((p) => p.pinId) }).toEqual({
                    type,
                    count,
                    shown: pinIds,
                });
            }
        }
    });

    it('grows the body with the pin count instead of stacking pins on top of each other', () => {
        const small = symbolFor(part('ic', ['1', '2', '3', '4']));
        const large = symbolFor(
            part(
                'ic',
                Array.from({ length: 40 }, (_, i) => `p${i}`),
            ),
        );
        expect(large.height).toBeGreaterThan(small.height);
        // Every pin at a distinct position — the actual thing "big enough" has to mean.
        const positions = new Set(large.pins.map((p) => `${p.x},${p.y}`));
        expect(positions.size).toBe(large.pins.length);
    });

    it('derives rather than forcing a drawn shape onto the wrong pin count', () => {
        // A "resistor" with four pins is not the two-terminal part the resistor shape describes. Forcing it
        // would drop two connections silently.
        expect(symbolFor(part('resistor', ['1', '2'])).basis).toBe('drawn');
        expect(symbolFor(part('resistor', ['1', '2', '3', '4'])).basis).toBe('derived');
    });

    it('declares which parts it does NOT draw, and derives them', () => {
        // Polarity for these lives in the referenced SPICE model's free text, which this package does not
        // parse. An arrow pointing the wrong way is read as fact; a box labelled c/b/e is a smaller claim.
        for (const type of UNDRAWN_BY_DESIGN) {
            expect({ type, basis: symbolFor(part(type, ['c', 'b', 'e'])).basis }).toEqual({ type, basis: 'derived' });
            expect(DRAWN_TYPES).not.toContain(type);
        }
    });
});

describe('a polarised symbol is oriented by pin NAME, never by array order', () => {
    // The bug: the shape put pins[0] on the left and pins[1] on the right, so a diode authored
    // [cathode, anode] — legal, and identical to the netlist generator, which binds by pinId — drew
    // backwards. A reversed diode on a schematic is read as fact by everyone who sees it.
    it('draws a diode the same way whichever order its pins are declared in', () => {
        const forward = symbolFor(part('diode', ['anode', 'cathode']));
        const reversed = symbolFor(part('diode', ['cathode', 'anode']));

        const anodeOf = (g: typeof forward) => g.pins.find((p) => p.pinId === 'anode')!;
        const cathodeOf = (g: typeof forward) => g.pins.find((p) => p.pinId === 'cathode')!;

        expect(forward.basis).toBe('drawn');
        expect(reversed.basis).toBe('drawn');
        // The anode is on the left in BOTH — the triangle points at the cathode either way.
        expect(anodeOf(forward).x).toBeLessThan(cathodeOf(forward).x);
        expect(anodeOf(reversed).x).toBeLessThan(cathodeOf(reversed).x);
    });

    it('draws a source the same way whichever order its terminals are declared in', () => {
        const normal = symbolFor(part('voltage_source', ['+', '-']));
        const flipped = symbolFor(part('voltage_source', ['-', '+']));
        const plusOf = (g: typeof normal) => g.pins.find((p) => p.pinId === '+')!;
        const minusOf = (g: typeof normal) => g.pins.find((p) => p.pinId === '-')!;

        // + above − in both: y grows downward in this frame.
        expect(plusOf(normal).y).toBeLessThan(minusOf(normal).y);
        expect(plusOf(flipped).y).toBeLessThan(minusOf(flipped).y);
    });

    it('DERIVES when the terminals are not named recognisably, rather than guessing', () => {
        // A diode whose pins are '1' and '2' carries no polarity information. Drawing the conventional
        // symbol would assert an orientation the document does not state — so it becomes a box, and the
        // reader can see that nothing was claimed.
        expect(symbolFor(part('diode', ['1', '2'])).basis).toBe('derived');
        expect(symbolFor(part('voltage_source', ['1', '2'])).basis).toBe('derived');
        // …while a NON-polarised two-terminal part is happy either way round.
        expect(symbolFor(part('resistor', ['1', '2'])).basis).toBe('drawn');
        expect(symbolFor(part('resistor', ['2', '1'])).basis).toBe('drawn');
    });
});

describe('degenerate input still yields something honest', () => {
    it('a part with no pins at all still draws', () => {
        // A design containing it should SHOW it, rather than silently have one fewer part than it has.
        const geometry = symbolFor(part('generic', []));
        expect(geometry.strokes.length).toBeGreaterThan(0);
        expect(geometry.pins.length).toBeGreaterThan(0);
    });

    it('an unnamed pin is addressed by position rather than collapsing onto its neighbour', () => {
        const geometry = symbolFor({
            type: 'generic',
            pins: [
                { pinId: '', netId: 'n' },
                { pinId: '', netId: 'n' },
            ],
        } as Pick<Component, 'type' | 'pins'>);
        expect(new Set(geometry.pins.map((p) => p.pinId)).size).toBe(2);
    });

    it('an unknown type is derived, not approximated', () => {
        expect(symbolFor(part('a_part_type_invented_tomorrow', ['1', '2'])).basis).toBe('derived');
    });
});
