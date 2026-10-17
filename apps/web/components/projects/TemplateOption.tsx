/** One choice in the "start from" list: a blank sheet or a template. A radio, announced as one. */
export function TemplateOption({
    title,
    detail,
    tags = [],
    selected,
    onSelect,
}: {
    title: string;
    detail: string;
    tags?: readonly string[];
    selected: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={onSelect}
            className={`cursor-pointer rounded-lg border p-3 text-left transition-colors ${
                selected ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'
            }`}
        >
            <p className="truncate text-sm font-medium">{title}</p>
            <p className="mt-0.5 line-clamp-2 text-xs text-muted">{detail}</p>
            {tags.length > 0 && (
                <p className="mt-1.5 flex flex-wrap gap-1">
                    {tags.slice(0, 3).map((t) => (
                        <span key={t} className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted">
                            {t}
                        </span>
                    ))}
                </p>
            )}
        </button>
    );
}
