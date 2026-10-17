'use client';

import { ProjectsDashboard } from '../../components/projects/ProjectsDashboard';
import { RequireAuth } from '../../components/shell/RequireAuth';

export default function ProjectsPage() {
    return (
        <RequireAuth>
            <ProjectsDashboard />
        </RequireAuth>
    );
}
