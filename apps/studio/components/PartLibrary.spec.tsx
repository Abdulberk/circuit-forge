/**
 * @jest-environment jsdom
 */
/**
 * The component library, where a real manufacturer part enters the design as itself.
 *
 * The properties under test are the honesty ones. A part that cannot be simulated must be placeable AND
 * say so; a catalogue lookup that did not answer must not read as a part with no price; and the identity
 * that arrives with the part — MPN, footprint, tolerance — must reach the document, because three shipped
 * capabilities go quiet without it.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { ApiError, type Api, type CatalogPart, type MappedPart } from '../lib/api';
import type { DocumentState } from '../lib/useDocument';

import { PartLibrary } from './PartLibrary';

const PART: CatalogPart = {
    mpn: 'RC0603FR-0710KL',
    manufacturer: 'YAGEO',
    description: 'Thick film resistor 10k 1% 0603',
    footprint: '0603',
    stock: 4200,
    unitCost: 0.012,
    currency: 'EUR',
    supplier: 'tme',
    supplierId: 'RC0603-10K',
};

const MAPPED: MappedPart = {
    simulatable: true,
    component: {
        type: 'resistor',
        value: '10k',
        mpn: 'RC0603FR-0710KL',
        manufacturer: 'YAGEO',
        footprint: '0603',
        tolerance: 0.01,
        toleranceSource: 'catalog',
        sourcing: { supplier: 'tme', supplierId: 'RC0603-10K' },
    },
    catalog: PART,
};

function fakeApi(over: Partial<Record<'search' | 'component', unknown>> = {}) {
    const calls: string[] = [];
    const api = {
        searchParts: (q: string) => {
            calls.push(`search:${q}`);
            return over.search instanceof Error
                ? Promise.reject(over.search)
                : Promise.resolve({ items: [PART], page: 1, returned: 1 });
        },
        partComponent: (id: string) => {
            calls.push(`component:${id}`);
            return Promise.resolve((over.component as MappedPart) ?? MAPPED);
        },
    } as unknown as Api;
    return { api, calls };
}

function fakeDoc() {
    const applied: unknown[] = [];
    const doc = {
        refusal: null,
        notes: [],
        apply: (edit: (c: never) => { ok: boolean; changed?: boolean; circuit?: unknown }) => {
            const r = edit({ version: '1.0', components: [], nets: [] } as never);
            if (r.ok && r.changed) applied.push(r.circuit);
        },
    } as unknown as DocumentState;
    return { doc, applied };
}

const type = (value: string) => fireEvent.change(screen.getByLabelText('Search parts'), { target: { value } });

beforeEach(() => jest.useFakeTimers({ advanceTimers: true }));
afterEach(() => jest.useRealTimers());

const settle = async (ms = 600) => {
    await act(async () => {
        jest.advanceTimersByTime(ms);
        await Promise.resolve();
        await Promise.resolve();
    });
};

describe('searching the catalogue', () => {
    it('waits for a pause in typing — the search is METERED per request', () => {
        // A search per keystroke spends the user's quota on words they were still typing.
        const { api, calls } = fakeApi();
        const { doc } = fakeDoc();
        render(<PartLibrary api={api} doc={doc} />);

        type('10k');
        expect(calls).toEqual([]); // nothing yet
        act(() => void jest.advanceTimersByTime(500));
        expect(calls).toEqual(['search:10k']);
    });

    it('does not search a fragment too short to mean anything', () => {
        const { api, calls } = fakeApi();
        const { doc } = fakeDoc();
        render(<PartLibrary api={api} doc={doc} />);
        type('1');
        act(() => void jest.advanceTimersByTime(1000));
        expect(calls).toEqual([]);
    });

    it('shows what a buyer needs to choose: part number, package, price, stock', async () => {
        const { api } = fakeApi();
        const { doc } = fakeDoc();
        render(<PartLibrary api={api} doc={doc} />);
        type('10k');
        await settle();
        await waitFor(() => expect(screen.getByText('RC0603FR-0710KL')).toBeTruthy());
        expect(screen.getByText(/YAGEO · 0603 · 0\.01 EUR · 4200 in stock/)).toBeTruthy();
    });

    it('says price and stock arrive on placement, rather than showing a part with none', async () => {
        // A search row genuinely does not carry them — the catalogue fills them in on the detail call.
        // Omitting them silently would read as "this part has no price".
        const { api } = fakeApi();
        (api as unknown as { searchParts: () => Promise<unknown> }).searchParts = () =>
            Promise.resolve({ items: [{ ...PART, stock: undefined, unitCost: undefined }], page: 1, returned: 1 });
        const { doc } = fakeDoc();
        render(<PartLibrary api={api} doc={doc} />);
        type('10k');
        await settle();
        await waitFor(() => expect(screen.getByText(/price and stock load when placed/)).toBeTruthy());
    });

    it('MARKS a lookup that did not answer, instead of showing a part with nothing', async () => {
        // "We could not ask" and "the answer is nothing" must never look the same — and tolerance comes
        // from the same call, so a silent failure narrows the robustness spread without saying so.
        const { api } = fakeApi();
        (api as unknown as { searchParts: () => Promise<unknown> }).searchParts = () =>
            Promise.resolve({
                items: [{ ...PART, stock: undefined, unitCost: undefined, unavailable: ['pricing'] }],
                page: 1,
                returned: 1,
            });
        const { doc } = fakeDoc();
        render(<PartLibrary api={api} doc={doc} />);
        type('10k');
        await settle();
        await waitFor(() => expect(screen.getByText(/catalogue did not answer for: pricing/)).toBeTruthy());
    });

    it('shows a failure rather than an empty list', async () => {
        const { api } = fakeApi({ search: new ApiError('server', 'Component catalog unavailable.') });
        const { doc } = fakeDoc();
        render(<PartLibrary api={api} doc={doc} />);
        type('10k');
        await settle();
        await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/catalog unavailable/i));
    });
});

describe('placing a real part', () => {
    it('carries the IDENTITY into the document, not just a generic', async () => {
        // The whole point. Without MPN the package-agreement check has nothing to compare; without
        // tolerance the robustness verdict falls back to an assumed ±5%; without sourcing the BOM line
        // cannot be ordered.
        const { api } = fakeApi();
        const { doc, applied } = fakeDoc();
        render(<PartLibrary api={api} doc={doc} />);
        type('10k');
        await settle();
        await waitFor(() => screen.getByText('Place'));

        await act(async () => {
            screen.getByText('Place').click();
            await Promise.resolve();
        });

        await waitFor(() => expect(applied).toHaveLength(1));
        const added = (applied[0] as { components: Array<Record<string, unknown>> }).components[0]!;
        expect(added).toMatchObject({
            type: 'resistor',
            designator: 'R1',
            value: '10k',
            mpn: 'RC0603FR-0710KL',
            footprint: '0603',
            tolerance: 0.01,
            toleranceSource: 'catalog',
        });
    });

    it('places a part the simulator cannot model, and SAYS why', async () => {
        // Refusing would be the tool deciding a board may not contain a connector. Hiding the reason would
        // let someone wonder later why simulation stopped covering half the design.
        const { api } = fakeApi({
            component: {
                simulatable: false,
                reason: 'no SPICE model for a mechanical connector',
                component: { type: 'subckt', mpn: PART.mpn },
                catalog: PART,
            } as MappedPart,
        });
        const { doc } = fakeDoc();
        render(<PartLibrary api={api} doc={doc} />);
        type('10k');
        await settle();
        await waitFor(() => screen.getByText('Place'));

        await act(async () => {
            screen.getByText('Place').click();
            await Promise.resolve();
        });

        await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/will NOT be simulated/));
        expect(screen.getByRole('status').textContent).toMatch(/mechanical connector/);
    });

    it('says plainly when a catalogue part cannot be represented at all', async () => {
        const { api } = fakeApi({
            component: { simulatable: false, reason: 'unclassified category', catalog: PART } as MappedPart,
        });
        const { doc, applied } = fakeDoc();
        render(<PartLibrary api={api} doc={doc} />);
        type('10k');
        await settle();
        await waitFor(() => screen.getByText('Place'));

        await act(async () => {
            screen.getByText('Place').click();
            await Promise.resolve();
        });

        await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/cannot be represented/));
        expect(applied).toHaveLength(0); // nothing approximate was inserted
    });
});
