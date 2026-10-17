import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

import { cn } from './cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
    { className, ...rest },
    ref,
) {
    return (
        <input
            ref={ref}
            className={cn(
                'h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-fg',
                'placeholder:text-subtle focus:border-accent focus:outline-none',
                className,
            )}
            {...rest}
        />
    );
});

/** A labelled control. The label is a real <label>, so clicking it focuses the input and readers announce it. */
export function Field({
    label,
    htmlFor,
    hint,
    children,
}: {
    label: string;
    htmlFor: string;
    hint?: string;
    children: ReactNode;
}) {
    return (
        <div className="grid gap-1.5">
            <label htmlFor={htmlFor} className="text-xs font-medium text-muted">
                {label}
            </label>
            {children}
            {hint && <p className="text-xs text-subtle">{hint}</p>}
        </div>
    );
}
