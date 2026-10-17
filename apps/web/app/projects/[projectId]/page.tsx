'use client';

import { use } from 'react';

import { ProjectEditor } from '../../../components/editor/ProjectEditor';
import { RequireAuth } from '../../../components/shell/RequireAuth';

/**
 * One project, by URL. Remounted per id (`key`), so switching projects starts from a clean editor: the
 * selection, the view and the undo stack all belong to the document they were made in.
 */
export default function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    return (
        <RequireAuth>
            <ProjectEditor key={projectId} projectId={projectId} />
        </RequireAuth>
    );
}
