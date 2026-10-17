/** Join class names, dropping the falsy ones. Small on purpose: no class-merging library is needed yet. */
export function cn(...parts: Array<string | false | null | undefined>): string {
    return parts.filter(Boolean).join(' ');
}
