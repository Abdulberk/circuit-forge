import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
    primary: 'bg-accent text-accent-fg hover:brightness-110 border border-transparent',
    secondary: 'bg-surface text-fg border border-line-strong hover:bg-surface-2',
    ghost: 'bg-transparent text-muted border border-transparent hover:bg-surface-2 hover:text-fg',
    danger: 'bg-transparent text-bad border border-line-strong hover:bg-surface-2',
};

const SIZE: Record<Size, string> = {
    sm: 'h-7 px-2.5 text-xs gap-1.5',
    md: 'h-9 px-3.5 text-sm gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: Variant;
    size?: Size;
}

/** The one button. Every screen uses it, so focus, disabled and hover look the same everywhere. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { variant = 'secondary', size = 'md', className, type = 'button', ...rest },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            className={cn(
                'inline-flex cursor-pointer items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors',
                'disabled:cursor-default disabled:opacity-50',
                VARIANT[variant],
                SIZE[size],
                className,
            )}
            {...rest}
        />
    );
});
