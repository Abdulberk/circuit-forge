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
 * Sanitize netlist content for dangerous patterns
 */
export function sanitizeNetlist(netlist: string, jobDir: string): string {
    const lines = netlist.split('\n');
    const sanitized: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim().toLowerCase();

        // Validate .include statements
        if (trimmed.startsWith('.include')) {
            const match = line.match(/\.include\s+["']?([^"'\s]+)["']?/i);
            if (match && match[1]) {
                validateIncludePath(match[1], jobDir);
            }
        }

        // Block potentially dangerous directives
        if (trimmed.startsWith('.shell') || trimmed.startsWith('.system')) {
            throw new SecurityError(
                'Shell commands not allowed in netlist',
                'SHELL_COMMAND',
            );
        }

        sanitized.push(line);
    }

    return sanitized.join('\n');
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