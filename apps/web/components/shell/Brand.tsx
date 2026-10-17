import Link from 'next/link';

/** The wordmark. A small schematic glyph (a resistor zig-zag) rather than a generic logo. */
export function Brand({ href = '/projects' }: { href?: string }) {
    return (
        <Link href={href} className="flex items-center gap-2 font-semibold tracking-tight text-fg">
            <span className="grid size-7 place-items-center rounded-md bg-accent text-accent-fg">
                <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden
                >
                    <path d="M2 12h4l2-5 3 10 3-10 3 10 2-5h3" strokeLinejoin="round" strokeLinecap="round" />
                </svg>
            </span>
            <span>
                Circuit<span className="text-accent">Forge</span>
            </span>
        </Link>
    );
}
