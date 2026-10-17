import Link from 'next/link';

import type { Project } from '../../lib/api';
import { Button } from '../ui/Button';

import { SheetThumb, relative } from './parts';

/** The project cards. The whole card opens the project; rename and delete appear on hover or focus. */
export function ProjectGrid({
    projects,
    onRename,
    onDelete,
}: {
    projects: readonly Project[];
    onRename: (p: Project) => void;
    onDelete: (p: Project) => void;
}) {
    return (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-list">
            {projects.map((p) => (
                <li
                    key={p.id}
                    className="group relative rounded-xl border border-line bg-surface shadow-sm transition-shadow hover:shadow-md"
                >
                    <Link href={`/projects/${p.id}`} className="block p-4">
                        <SheetThumb />
                        <h2 className="mt-3 truncate font-medium">{p.name}</h2>
                        <p className="mt-0.5 line-clamp-1 text-sm text-muted">{p.description || 'No description'}</p>
                        <p className="mt-2 text-xs text-subtle">Edited {relative(p.updatedAt)}</p>
                    </Link>
                    <div className="absolute top-3 right-3 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                        <Button size="sm" variant="secondary" onClick={() => onRename(p)}>
                            Rename
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => onDelete(p)}>
                            Delete
                        </Button>
                    </div>
                </li>
            ))}
        </ul>
    );
}
