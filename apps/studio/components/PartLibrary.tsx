'use client';

/**
 * The component library — real manufacturer parts, searchable, placed into the design as themselves.
 *
 * The palette shipped beside this adds a GENERIC: a resistor with no part number, no footprint and no
 * tolerance. That is right for sketching and wrong for everything after it, because three capabilities
 * this product already has are keyed on a part's identity and go quiet without one:
 *
 *   • the package-agreement check compares the ordered MPN against the pads we draw, and refuses a WSON
 *     part on SOIC footprints — it cannot say anything about a component with no MPN;
 *   • the robustness verdict spreads over a part's real tolerance, and falls back to an assumed ±5% when
 *     the document does not carry one;
 *   • the BOM can only be ordered from if a line has a part number and a distributor code.
 *
 * So this is not a nicety on top of the editor. It is what makes the rest of the pipeline able to tell the
 * truth about a board.
 *
 * THE SERVER CLASSIFIES, NOT THIS FILE. Which of our component types a catalogue part is, where its value
 * lives among the catalogue parameters, and whether it can be SIMULATED at all — all decided by the API and
 * passed through untouched. A client that re-derived "is this a resistor" would be a second authority, and
 * the day the two disagreed a part would enter the design as something it is not.
 *
 * TWO HONESTY RULES, both visible on screen:
 *   • A part the simulator cannot model is inserted anyway, with the server's REASON shown. Refusing it
 *     would be the tool deciding a board may not contain a connector; hiding the reason would let someone
 *     wonder later why their simulation stopped covering half the design.
 *   • A part whose catalogue lookup did not fully ANSWER is marked. "We could not ask" and "the answer is
 *     nothing" must never look the same — a supplier blip returns a part with no price and no stock, which
 *     reads exactly like a part that genuinely has neither.
 */
import { addComponent } from '@circuit-forge/editor-core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, isAbort, type Api, type CatalogPart, type MappedPart } from '../lib/api';
import type { DocumentState } from '../lib/useDocument';

/**
 * How long a pause in typing counts as "done".
 *
 * Longer than the editor's own debounce on purpose: catalogue search is METERED per request, cache hits
 * included, so a search per keystroke spends the user's quota on words they were still typing.
 */
const SEARCH_IDLE_MS = 450;

const money = (p: CatalogPart) =>
    p.unitCost === undefined ? null : `${p.unitCost.toFixed(2)} ${p.currency ?? ''}`.trim();

export function PartLibrary({ api, doc }: { api: Api; doc: DocumentState }) {
    const [query, setQuery] = useState('');
    const [items, setItems] = useState<CatalogPart[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);
    const [placing, setPlacing] = useState<string | null>(null);
    const [placed, setPlaced] = useState<MappedPart | null>(null);
    const inFlight = useRef<AbortController | null>(null);

    useEffect(() => {
        const q = query.trim();
        if (q.length < 2) {
            setItems(null);
            setError(null);
            return;
        }
        const timer = setTimeout(() => {
            inFlight.current?.abort();
            const controller = new AbortController();
            inFlight.current = controller;
            setBusy(true);
            api.searchParts(q, 1, controller.signal)
                .then((r) => {
                    setItems(r.items);
                    setError(null);
                })
                .catch((e: unknown) => {
                    if (isAbort(e)) return; // superseded by a later keystroke, not a failure
                    setError(e instanceof ApiError ? e : new ApiError('unexpected', String(e)));
                    setItems(null);
                })
                .finally(() => {
                    if (inFlight.current === controller) setBusy(false);
                });
        }, SEARCH_IDLE_MS);
        return () => clearTimeout(timer);
    }, [query, api]);

    useEffect(() => () => inFlight.current?.abort(), []);

    const place = useCallback(
        async (part: CatalogPart) => {
            setPlacing(part.supplierId);
            setPlaced(null);
            try {
                const mapped = await api.partComponent(part.supplierId);
                if (!mapped.component) {
                    // The catalogue knows the part and we cannot represent it. Said plainly rather than
                    // inserting something approximate that would simulate and build as the wrong thing.
                    setPlaced(mapped);
                    return;
                }
                const c = mapped.component;
                doc.apply((circuit) =>
                    addComponent(circuit, {
                        type: c.type as Parameters<typeof addComponent>[1]['type'],
                        value: c.value,
                        model: c.model,
                        mpn: c.mpn ?? part.mpn,
                        manufacturer: c.manufacturer ?? part.manufacturer,
                        footprint: c.footprint ?? part.footprint,
                        tolerance: c.tolerance,
                        toleranceSource: c.toleranceSource,
                        sourcing: c.sourcing,
                    }),
                );
                setPlaced(mapped);
            } catch (e: unknown) {
                setError(e instanceof ApiError ? e : new ApiError('unexpected', String(e)));
            } finally {
                setPlacing(null);
            }
        },
        [api, doc],
    );

    return (
        <div>
            <div className="field">
                <label htmlFor="part-search">Search parts</label>{' '}
                <input
                    id="part-search"
                    className="mono"
                    value={query}
                    placeholder="10k 0603, NE555, LED…"
                    onChange={(e) => setQuery(e.target.value)}
                />
            </div>

            {busy && <p className="empty">Searching…</p>}
            {error && (
                <div className="notice bad" role="alert">
                    {error.message}
                </div>
            )}
            {items?.length === 0 && <p className="empty">No parts matched.</p>}

            {placed && (
                <div className={placed.simulatable ? 'notice' : 'notice bad'} role="status">
                    {placed.component ? (
                        placed.simulatable ? (
                            <>Placed {placed.catalog.mpn}.</>
                        ) : (
                            <>
                                Placed {placed.catalog.mpn}, but it will NOT be simulated
                                {placed.reason ? `: ${placed.reason}` : '.'} It still appears on the board and the BOM.
                            </>
                        )
                    ) : (
                        <>
                            {placed.catalog.mpn} cannot be represented in a design yet
                            {placed.reason ? `: ${placed.reason}` : '.'}
                        </>
                    )}
                </div>
            )}

            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {(items ?? []).map((p) => (
                    <li key={p.supplierId} style={{ borderTop: '1px solid var(--rule, #333)', padding: '6px 0' }}>
                        <div className="mono">{p.mpn}</div>
                        <div style={{ color: 'var(--text-faint)', fontSize: '0.85em' }}>
                            {p.manufacturer}
                            {p.footprint ? ` · ${p.footprint}` : ''}
                            {money(p) ? ` · ${money(p)}` : ''}
                            {p.stock !== undefined ? ` · ${p.stock} in stock` : ''}
                            {/* A search row genuinely does not carry price, stock or package — the catalogue
                                populates those on the DETAIL call, which happens when the part is placed.
                                Omitting them silently would read as "this part has no price", which is the
                                same lie `unavailable` exists to prevent one level down. */}
                            {p.unitCost === undefined && p.stock === undefined
                                ? ' · price and stock load when placed'
                                : ''}
                        </div>
                        <div style={{ fontSize: '0.85em' }}>{p.description}</div>
                        {/* "We could not ask" is not "the answer is nothing" — a supplier blip returns a part
                            with no price and no tolerance, which reads exactly like a part that has neither,
                            and tolerance is what the robustness verdict spreads over. */}
                        {p.unavailable?.length ? (
                            <div className="warn" style={{ fontSize: '0.8em' }}>
                                catalogue did not answer for: {p.unavailable.join(', ')}
                            </div>
                        ) : null}
                        <button disabled={placing === p.supplierId} onClick={() => void place(p)}>
                            {placing === p.supplierId ? 'Placing…' : 'Place'}
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}
