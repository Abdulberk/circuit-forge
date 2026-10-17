/**
 * @jest-environment jsdom
 */
import type { CircuitJson, Component } from '@circuit-forge/eda-core';
import type { EditResult } from '@circuit-forge/editor-core';
import { fireEvent, render, screen } from '@testing-library/react';

import type { DocumentState } from '../../lib/useDocument';

import { PartPalette } from './PartPalette';

const EMPTY: CircuitJson = { version: '1.0', components: [], nets: [] };

/** A document stub that applies edits to a local circuit, the way useDocument does, and records labels. */
function fakeDoc() {
    let circuit = EMPTY;
    const labels: string[] = [];
    const doc = {
        circuit,
        applyMany: (label: string, edits: ReadonlyArray<(c: CircuitJson) => EditResult>) => {
            labels.push(label);
            for (const edit of edits) {
                const r = edit(circuit);
                if (r.ok && r.changed) circuit = r.circuit;
            }
        },
    } as unknown as DocumentState;
    return { doc, labels, current: () => circuit };
}

describe('the part palette', () => {
    it('places a part WITH its default value, in one labelled revision', () => {
        const { doc, labels, current } = fakeDoc();
        render(<PartPalette doc={doc} />);
        fireEvent.click(screen.getByTestId('palette-generic:resistor'));
        fireEvent.click(screen.getByTestId('palette-generic:capacitor'));
        const parts: Component[] = current().components;
        expect(parts.map((c) => [c.designator, c.value])).toEqual([
            ['R1', '10k'],
            ['C1', '100n'],
        ]);
        expect(labels).toEqual(['Add resistor', 'Add capacitor']);
    });

    it('places a transistor with its model, so it simulates without further typing', () => {
        const { doc, current } = fakeDoc();
        render(<PartPalette doc={doc} />);
        fireEvent.click(screen.getByTestId('palette-generic:npn'));
        expect(current().components[0]).toMatchObject({ type: 'bjt', designator: 'Q1', model: 'QGENNPN' });
    });

    it('filters as you type, and says so when nothing matches', () => {
        const { doc } = fakeDoc();
        render(<PartPalette doc={doc} />);
        const search = screen.getByRole('searchbox', { name: 'Search parts' });
        fireEvent.change(search, { target: { value: 'mosfet' } });
        expect(screen.queryByTestId('palette-generic:resistor')).toBeNull();
        expect(screen.getByTestId('palette-generic:nmos')).toBeTruthy();
        fireEvent.change(search, { target: { value: 'flux capacitor' } });
        expect(screen.getByText(/No part matches/)).toBeTruthy();
    });
});
