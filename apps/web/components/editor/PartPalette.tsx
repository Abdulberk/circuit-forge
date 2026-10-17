'use client';

/**
 * The generic part palette: search, click, and the part is on the sheet with a sensible value.
 *
 * Reads `GENERIC_PARTS` from the kernel — the same definitions any other placing surface uses — so a
 * resistor arrives as 10k here and everywhere else. The kernel allocates the designator and
 * `placeNewParts` finds it a free spot beside what is already on the sheet.
 */
import { addComponent, searchGenericParts, type GenericPart, type PartGroup } from '@circuit-forge/editor-core';
import { useMemo, useState } from 'react';

import type { DocumentState } from '../../lib/useDocument';

const GROUP_LABEL: Record<PartGroup, string> = {
    passive: 'Passives',
    source: 'Sources',
    semiconductor: 'Semiconductors',
};

export function PartPalette({ doc }: { doc: DocumentState }) {
    const [query, setQuery] = useState('');
    const parts = useMemo(() => searchGenericParts(query), [query]);
    const groups = useMemo(() => {
        const out = new Map<PartGroup, GenericPart[]>();
        for (const p of parts) out.set(p.group, [...(out.get(p.group) ?? []), p]);
        return [...out];
    }, [parts]);

    const place = (p: GenericPart): void => {
        doc.applyMany(`Add ${p.label.toLowerCase()}`, [(c) => addComponent(c, p.part)]);
    };

    return (
        <section aria-label="Parts" className="pb-2">
            <div className="pane-head border-b-0">Parts</div>
            <div className="px-3">
                <input
                    type="search"
                    aria-label="Search parts"
                    placeholder="Search: resistor, cap, npn…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="h-8 w-full rounded-md border border-line-strong bg-surface px-2.5 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
                />
            </div>
            {groups.length === 0 && <p className="empty">No part matches “{query}”.</p>}
            {groups.map(([group, list]) => (
                <div key={group} className="mt-3">
                    <p className="px-3 pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">
                        {GROUP_LABEL[group]}
                    </p>
                    <ul className="grid gap-px px-1.5">
                        {list.map((p) => (
                            <li key={p.id}>
                                <button
                                    type="button"
                                    data-testid={`palette-${p.id}`}
                                    onClick={() => place(p)}
                                    className="flex w-full cursor-pointer items-center justify-between rounded-md px-1.5 py-1 text-left text-sm text-fg hover:bg-surface-2"
                                >
                                    <span>{p.label}</span>
                                    <span className="font-mono text-xs text-subtle">
                                        {p.part.value ?? p.part.model}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </section>
    );
}
