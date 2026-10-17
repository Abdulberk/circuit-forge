import { Button } from '../ui/Button';

/** A tiny schematic motif, so a card reads as a circuit rather than a document. */
export function SheetThumb() {
    return (
        <div className="grid h-20 place-items-center rounded-lg bg-canvas" aria-hidden>
            <svg width="120" height="40" viewBox="0 0 120 40" fill="none" stroke="var(--wire)" strokeWidth="1.5">
                <path d="M4 20h22l4-8 6 16 6-16 6 16 4-8h14" />
                <path d="M72 20h10M82 10v20M88 10v20M88 20h28" />
            </svg>
        </div>
    );
}

export function EmptyState({ searching, onCreate }: { searching: boolean; onCreate: () => void }) {
    return (
        <div className="mt-10 grid place-items-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-16 text-center">
            <SheetThumb />
            <h2 className="mt-4 font-medium">{searching ? 'No project matches' : 'No projects yet'}</h2>
            <p className="mt-1 max-w-sm text-sm text-muted">
                {searching
                    ? 'Try another name, or clear the search.'
                    : 'Start from a blank sheet or from one of the ready-made circuits.'}
            </p>
            {!searching && (
                <Button variant="primary" className="mt-5" onClick={onCreate}>
                    New project
                </Button>
            )}
        </div>
    );
}

export function SkeletonGrid() {
    return (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
            {[0, 1, 2].map((i) => (
                <li key={i} className="h-44 animate-pulse rounded-xl border border-line bg-surface" />
            ))}
        </ul>
    );
}

/** "3 min ago" for recent edits, a date for old ones. */
export function relative(iso: string, now = Date.now()): string {
    const s = (now - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
    return new Date(iso).toLocaleDateString();
}
