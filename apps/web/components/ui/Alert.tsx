import type { ReactNode } from 'react';

import { cn } from './cn';

const TONE = {
    bad: 'border-bad/40 text-bad',
    warn: 'border-warn/40 text-warn',
    info: 'border-line text-muted',
} as const;

/** An inline message. `role="alert"` for failures, so a reader hears it without hunting for it. */
export function Alert({
    tone = 'info',
    title,
    children,
}: {
    tone?: keyof typeof TONE;
    title?: string;
    children?: ReactNode;
}) {
    return (
        <div
            role={tone === 'bad' ? 'alert' : 'status'}
            className={cn('rounded-md border bg-surface px-3 py-2 text-sm', TONE[tone])}
        >
            {title && <p className="font-semibold">{title}</p>}
            {children && <div className="text-fg/80">{children}</div>}
        </div>
    );
}
