/**
 * Netlist Sanitization Utilities
 * Security-focused input validation and path sanitization
 */

/**
 * Reserved SPICE words that cannot be used as node names
 */
const RESERVED_WORDS = new Set([
    'all',
    'none',
    'in',
    'out',
    'vcc',
    'vdd',
    'vss',
    'gnd',
    'ground',
]);

/**
 * ngspice's expression/wrdata lexer treats these as relational/boolean OPERATORS. A node whose final name
 * equals one — most commonly net id `e` (an emitter) → node `ne` (== "not equal") — makes `v(ne)` abort the
 * ENTIRE wrdata line and silently produce no output file (no error). They must never be a bare node name.
 */
const NGSPICE_OPERATORS = new Set(['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'and', 'or', 'not']);

/**
 * Sanitize a node name for SPICE compatibility
 * - Removes special characters
 * - Ensures it doesn't start with a number
 * - Avoids reserved words
 */
export function sanitizeNodeName(name: string): string {
    // Remove special characters, keep alphanumeric and underscore
    let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_');

    // Ensure it doesn't start with a number
    if (/^[0-9]/.test(sanitized)) {
        sanitized = `n${sanitized}`;
    }

    // Prefix if it's a reserved word
    if (RESERVED_WORDS.has(sanitized.toLowerCase())) {
        sanitized = `x_${sanitized}`;
    }

    // Ensure not empty
    if (sanitized === '') {
        sanitized = 'node';
    }

    // Prefix with 'n' for clarity
    if (!sanitized.startsWith('n') && !sanitized.startsWith('x_')) {
        sanitized = `n${sanitized}`;
    }

    // Final guard: the prefixed name must not BE an ngspice operator token (e.g. net 'e' → 'ne'), or
    // `v(<node>)` in a wrdata/expression context silently aborts the whole output line.
    if (NGSPICE_OPERATORS.has(sanitized.toLowerCase())) {
        sanitized = `x_${sanitized}`;
    }

    return sanitized;
}

/**
 * Validate include paths to prevent path traversal attacks
 * All paths must be relative and within the job directory
 */
export function validateIncludePaths(paths: string[], jobDir: string): void {
    for (const includePath of paths) {
        validateIncludePath(includePath, jobDir);
    }
}

/**
 * Validate a single include path
 */
export function validateIncludePath(includePath: string, _jobDir: string): void {
    // Reject absolute paths (Unix or Windows style)
    if (includePath.startsWith('/') || /^[A-Za-z]:/.test(includePath)) {
        throw new SecurityError(
            `Absolute include path not allowed: ${includePath}`,
            'ABSOLUTE_PATH',
        );
    }

    // Reject path traversal
    if (includePath.includes('..')) {
        throw new SecurityError(
            `Path traversal not allowed: ${includePath}`,
            'PATH_TRAVERSAL',
        );
    }

    // Reject paths starting with special characters
    if (includePath.startsWith('~') || includePath.startsWith('$')) {
        throw new SecurityError(
            `Special path prefix not allowed: ${includePath}`,
            'SPECIAL_PREFIX',
        );
    }

    // Validate characters (alphanumeric, underscore, dash, dot, slash)
    if (!/^[a-zA-Z0-9_\-./]+$/.test(includePath)) {
        throw new SecurityError(
            `Invalid characters in include path: ${includePath}`,
            'INVALID_CHARS',
        );
    }
}

/**
 * ngspice commands that can execute code or escape the job sandbox. CRUCIALLY these run INSIDE a
 * `.control … .endc` block (which ngspice DOES execute in `-b` batch mode, and which our own generated decks
 * use for `set`/`run`/`wrdata`/`quit`) WITHOUT a leading dot — so blocking only `.shell`/`.system` at the top
 * level missed the real attack surface (`shell rm -rf /`, `system curl … | sh`, `source /etc/passwd`,
 * `osdi evil.so`). Matched as the line's FIRST token (dot-prefix stripped), so a device named `Cd1`/`Lload2`
 * is unaffected — only the bare command word is rejected.
 */
const DANGEROUS_COMMANDS = new Set([
    'shell', // run a shell command
    'system', // run a system command
    'source', // read + execute another SPICE file
    'exec', // execute
    'cd', // change working directory (relative-path escape)
    'load', // load an external rawfile (arbitrary file read)
    'osdi', // load an OSDI shared library → native code execution
    'codemodel', // load an XSPICE .cm shared library → native code execution
    'pre_osdi', // pre-run OSDI load
]);

/** Commands whose FIRST argument is a destination/​source FILE that must stay inside the job dir (validated
 *  like `.include`). Our generated decks use `wrdata output.csv …` (a safe relative path); a crafted
 *  `wrdata /etc/cron.d/x …` would otherwise write outside the sandbox. */
const FILE_PATH_COMMANDS = new Set(['wrdata', 'write', 'wrs', 'sconvert', 'rawfile']);

/**
 * Sanitize netlist content for dangerous patterns. Defence-in-depth before ngspice runs the deck: blocks
 * code-execution / sandbox-escape commands (top-level OR inside a `.control` block) and validates every
 * file path (`.include`, `wrdata`, …) stays within the job directory. Throws SecurityError on the first
 * violation; returns the netlist unchanged when clean.
 */
export function sanitizeNetlist(netlist: string, jobDir: string): string {
    const lines = netlist.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('*')) continue; // blank / comment
        const tokens = trimmed.split(/\s+/);
        const firstTok = (tokens[0] ?? '').toLowerCase();
        const cmd = firstTok.replace(/^\./, ''); // `.shell` and `shell` are the same threat

        // Code-execution / sandbox-escape commands — blocked everywhere (incl. inside .control, no dot needed).
        if (DANGEROUS_COMMANDS.has(cmd)) {
            throw new SecurityError(
                `Disallowed ngspice command "${firstTok}" (shell/system/source/exec/cd/load/osdi are blocked, including inside a .control block)`,
                'DANGEROUS_COMMAND',
            );
        }

        // .include <path> — must be a relative path inside the job dir.
        if (cmd === 'include') {
            const match = line.match(/\.include\s+["']?([^"'\s]+)["']?/i);
            if (match && match[1]) validateIncludePath(match[1], jobDir);
        }

        // File-writing/reading commands — validate the destination/source path stays in the job dir.
        if (FILE_PATH_COMMANDS.has(cmd) && tokens[1]) {
            validateIncludePath(tokens[1].replace(/^["']|["']$/g, ''), jobDir);
        }
    }

    return netlist;
}

/**
 * Security error class
 */
export class SecurityError extends Error {
    public readonly code: string;

    constructor(message: string, code: string) {
        super(message);
        this.name = 'SecurityError';
        this.code = code;
    }
}

/**
 * Sanitize a component value string
 * Removes potentially dangerous characters while keeping valid SPICE syntax
 */
export function sanitizeValue(value: string): string {
    // Allow: numbers, letters (for units), spaces, parentheses (for sources), +/-/.
    const sanitized = value.replace(/[^a-zA-Z0-9\s()+\-.,_]/g, '');
    return sanitized.trim();
}

/**
 * Validate a designator format
 */
export function validateDesignator(designator: string): boolean {
    // Must start with a letter, followed by alphanumeric, ending with a number
    return /^[A-Za-z][A-Za-z0-9]*[0-9]+$/.test(designator);
}

/**
 * Check if a string contains shell metacharacters
 */
export function hasShellMetacharacters(str: string): boolean {
    // Characters that could be used for shell injection
    const shellMeta = /[;&|`$<>\\!#{}[\]*?'"]/;
    return shellMeta.test(str);
}