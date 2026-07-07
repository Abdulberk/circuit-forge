/**
 * Native kicad-cli runner (TS port of scripts/lib/kicad-native.mjs — proven in M2/M3a). Provides the
 * three things the LayoutJob needs: notaryDrc (bool accept-oracle for the margin-retry), drcReport
 * (parsed, for airwires + categorized checks) and exportGlb (3D bodies via --subst-models).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface KicadOpts {
    cli?: string;
    timeoutMs?: number;
    workDir?: string;
    keep?: boolean;
}

/** Shape of kicad-cli's DRC json, parsed by pcb-core's parseDrcReport. */
export interface KicadDrcJson {
    violations?: unknown[];
    unconnected_items?: unknown[];
    [k: string]: unknown;
}

export interface NativeKicad {
    notaryDrc: (kicadPcb: string, kicadPro?: string) => Promise<boolean>;
    drcReport: (kicadPcb: string, kicadPro?: string) => Promise<KicadDrcJson>;
    exportGlb: (kicadPcb: string) => Promise<Buffer>;
}

export function makeNativeKicad(opts: KicadOpts = {}): NativeKicad {
    const cli = opts.cli ?? process.env.KICAD_CLI ?? 'kicad-cli';
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const baseDir = opts.workDir ?? tmpdir();

    const withBoard = <T>(kicadPcb: string, kicadPro: string | undefined, fn: (dir: string) => T): T => {
        const dir = mkdtempSync(join(baseDir, 'kc-'));
        try {
            writeFileSync(join(dir, 'b.kicad_pcb'), kicadPcb);
            if (kicadPro) writeFileSync(join(dir, 'b.kicad_pro'), kicadPro);
            return fn(dir);
        } finally {
            if (!opts.keep) rmSync(dir, { recursive: true, force: true });
        }
    };

    const notaryDrc = async (kicadPcb: string, kicadPro?: string): Promise<boolean> =>
        withBoard(kicadPcb, kicadPro, (dir) => {
            try {
                execFileSync(
                    cli,
                    ['pcb', 'drc', '--refill-zones', '--exit-code-violations', '--severity-error', '--format', 'json', '--output', join(dir, 'd.json'), join(dir, 'b.kicad_pcb')],
                    { stdio: 'pipe', timeout: timeoutMs },
                );
                return true;
            } catch (e) {
                if ((e as { status?: number }).status === 5) return false;
                throw e;
            }
        });

    const drcReport = async (kicadPcb: string, kicadPro?: string): Promise<KicadDrcJson> =>
        withBoard(kicadPcb, kicadPro, (dir) => {
            const out = join(dir, 'd.json');
            execFileSync(cli, ['pcb', 'drc', '--refill-zones', '--severity-error', '--format', 'json', '--output', out, join(dir, 'b.kicad_pcb')], {
                stdio: 'pipe',
                timeout: timeoutMs,
            });
            return existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as KicadDrcJson) : { violations: [], unconnected_items: [] };
        });

    const exportGlb = async (kicadPcb: string): Promise<Buffer> =>
        withBoard(kicadPcb, undefined, (dir) => {
            const out = join(dir, 'b.glb');
            execFileSync(
                cli,
                ['pcb', 'export', 'glb', '--include-tracks', '--include-pads', '--include-zones', '--include-silkscreen', '--include-soldermask', '--subst-models', '--output', out, join(dir, 'b.kicad_pcb')],
                { stdio: 'pipe', timeout: timeoutMs },
            );
            return readFileSync(out);
        });

    return { notaryDrc, drcReport, exportGlb };
}
