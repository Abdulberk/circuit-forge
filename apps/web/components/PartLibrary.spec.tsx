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

/**
 * A document with a CIRCUIT in it, because a real one always has.
 *
 * The stub used to carry only `apply`, which let the panel be tested without ever asking whether the edit
 * would be accepted — and the panel duly reported "Placed …" for parts the kernel refuses. `doc.circuit` is
 * what the panel now asks before it claims anything.
 */
function fakeDoc(circuit: unknown = { version: '1.0', components: [], nets: [] }) {
    const applied: unknown[] = [];
    const doc = {
        circuit,
        refusal: null,
        notes: [],
        apply: (edit: (c: never) => { ok: boolean; changed?: boolean; circuit?: unknown }) => {
            const r = edit(circuit as never);
            if (r.ok && r.changed) applied.push(r.circuit);
        },
    } as unknown as DocumentState;
    return { doc, applied };
}

const type = (value: string) => fireEvent.change(screen.getByLabelText('Search parts'), { target: { value } });

beforeEach(() => jest.useFakeTimers({ advanceTimers: true }));
afterEach(() => jest.useRealTimers());

/**
 * Advance the clock and let everything it started FINISH, inside `act`.
 *
 * Two microtask ticks were not enough and the shortfall was invisible. A search is a timer, then a promise,
 * then a `.then` that sets the results, then a `.finally` that clears the busy flag — and that last one
 * landed a tick after the act block closed, so React updated with nothing wrapping it. Every assertion still
 * passed; the only sign was a warning nothing was reading.
 *
 * Drained until quiet rather than a fixed number of ticks, because "how many" is a fact about a promise
 * chain in another file and would go stale the moment that chain grew a link.
 */
const settle = async (ms = 600) => {
    await act(async () => {
        jest.advanceTimersByTime(ms);
        for (let i = 0; i < 10; i++) await Promise.resolve();
    });
};

describe('searching the catalogue', () => {
    it('waits for a pause in typing — the search is METERED per request', async () => {
        // A search per keystroke spends the user's quota on words they were still typing.
        const { api, calls } = fakeApi();
        const { doc } = fakeDoc();
        render(<PartLibrary api={api} doc={doc} />);

        type('10k');
        expect(calls).toEqual([]); // nothing yet
        act(() => void jest.advanceTimersByTime(500));
        expect(calls).toEqual(['search:10k']);

        // AND THE SEARCH IT STARTED IS LET FINISH. Asserting the call was made and walking away leaves a
        // promise chain in flight; it resolves during whichever test runs next, updating React with nothing
        // wrapping it, and the warning is attributed to that innocent test. A test that leaves work running
        // is a test that can fail its neighbour — the same shape as a gesture that outlives its own pointer.
        await settle();
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
        // SETTLED, not waited for. This row needs a SECOND round trip — a search result carries no price or
        // stock, and the catalogue fills those in on a detail call — and `waitFor` under fake timers advances
        // the clock OUTSIDE `act`, so React was updating while nothing was wrapping it. The warning said so
        // and every assertion still passed, which is the shape this suite keeps finding in itself.
        //
        // `settle` is this file's own act-wrapped advance. Two of them: one for the search, one for the
        // detail that follows it.
        await settle();
        expect(screen.getByText('RC0603FR-0710KL')).toBeTruthy();
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
        // Refusing would be the tool deciding a board may not contain an op-amp macromodel. Hiding the reason
        // would let someone wonder later why simulation stopped covering half the design.
        //
        // ITS PINS COME FROM ITS MODEL. A subckt has no canonical pin list — its shape IS the `.subckt`
        // declaration — so `ModelDef.ports` is what makes it placeable at all. Without that this panel
        // reported "Placed …" over a document the kernel had refused, and this test asserted the message
        // rather than the placement, so it agreed.
        const { api } = fakeApi({
            component: {
                simulatable: false,
                reason: 'macromodel only — not a full transistor-level model',
                component: { type: 'subckt', mpn: PART.mpn },
                modelDef: { name: 'OPA333', ports: ['in+', 'in-', 'v+', 'v-', 'out'] },
                catalog: PART,
            } as MappedPart,
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

        await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/will NOT be simulated/));
        expect(screen.getByRole('status').textContent).toMatch(/macromodel only/);
        // It really landed, with the pins its model declares.
        await waitFor(() => expect(applied).toHaveLength(1));
        const added = (applied[0] as { components: Array<{ pins: Array<{ pinId: string }> }> }).components[0]!;
        expect(added.pins.map((q) => q.pinId)).toEqual(['in+', 'in-', 'v+', 'v-', 'out']);
    });

    it('does NOT claim it placed a part the kernel refused', async () => {
        // THE DEFECT. `doc.apply` reports a refusal by setting state, not by returning, so the success line
        // printed whether or not anything landed — and for a part with no pin shape nothing can. A mechanical
        // connector mapped to a subckt with no model has no declared ports, and nobody can invent them.
        const { api } = fakeApi({
            component: {
                simulatable: false,
                reason: 'no SPICE model for a mechanical connector',
                component: { type: 'subckt', mpn: PART.mpn },
                catalog: PART,
            } as MappedPart,
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

        await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/was not placed/));
        // The kernel's own words, so a user knows why rather than retrying something that cannot work.
        expect(screen.getByRole('status').textContent).toMatch(/no fixed pin list/);
        expect(applied).toHaveLength(0);
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
