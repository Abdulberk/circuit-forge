/**
 * The reuse gate — mechanically enforced, on day one, before anything imports these types.
 *
 * The promise this package exists to keep is that the editor built here can be lifted into a separate
 * frontend workspace VERBATIM. A promise like that only survives if it is a test. Checked at the end, the
 * fix is a rewrite; checked from the start, a violation is a red build the day someone writes it.
 *
 * There is a specific accident this guards against. `LayoutGeometry` used to be declared inside
 * `@circuit-forge/pcb-core`, which depends on `@tscircuit/eval`, `@tscircuit/footprinter`,
 * `circuit-json-to-gerber`, `circuit-json-to-kicad` and `dsn-converter` — an evaluator, a footprint library
 * and three format converters that exist to be confined to the server. An editor that wanted to render a
 * board had exactly one way to get the type, and taking it would have inverted the boundary silently, on
 * the first import.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname);
const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
};

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return sourceFiles(full);
        return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [full] : [];
    });
}

describe('the contract stays a contract', () => {
    it('has NO dependencies — not one, of any kind', () => {
        // Zero is the only defensible number here. A single dependency makes "browser-safe" a claim about
        // someone else's package too, and the next one is always easier to justify than the first.
        expect(PKG.dependencies ?? {}).toEqual({});
        expect(PKG.peerDependencies ?? {}).toEqual({});
    });

    it('imports nothing at all', () => {
        for (const file of sourceFiles(SRC)) {
            const src = readFileSync(file, 'utf8');
            const imports = [...src.matchAll(/^\s*import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1]);
            expect({ file, imports }).toEqual({ file, imports: [] });
        }
    });

    it('declares types only — the built module exports NOTHING at runtime', () => {
        // Checked by LOADING the build, not by reading it.
        //
        // The first version of this test scanned dist/index.js as text and skipped lines starting with
        // `exports.`, meaning to ignore TypeScript's `exports.X = void 0;` boilerplate. A deliberate
        // violation proved it blind: an exported const compiles to `exports.LAYER_TOP = 'top';`, which the
        // filter removed — the check was deleting the very evidence it was looking for.
        //
        // Requiring the module cannot be fooled that way. A type has no runtime existence, so a contract
        // that is types-only loads to an empty object; an enum, a const or a helper appears immediately.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(join(__dirname, '..', 'dist', 'index.js')) as Record<string, unknown>;
        const runtimeExports = Object.keys(mod).filter((k) => k !== '__esModule');
        expect(runtimeExports).toEqual([]);
    });

    it('mentions no DOM and no Node global — it is compiled with neither lib available', () => {
        // tsconfig sets lib:["ES2022"] and types:[], so this is belt-and-braces: the compiler already
        // refuses, and this states the intent where a reader will find it if someone widens the tsconfig.
        for (const file of sourceFiles(SRC)) {
            const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
            expect({
                file,
                hit: /\b(document|window|Buffer|process|__dirname|require)\b/.exec(src)?.[0] ?? null,
            }).toEqual({ file, hit: null });
        }
    });
});
