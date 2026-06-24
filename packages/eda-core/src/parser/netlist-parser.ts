/**
 * SPICE Netlist Parser
 * Parses SPICE netlists back to CircuitJson (for import functionality)
 */
import type { CircuitJson, Component, Net, ComponentType, ModelDef } from '../types/circuit';
import type { AnalysisConfig, TranAnalysis, AcAnalysis, DcAnalysis, OpAnalysis, SolverOptions } from '../types/analysis';

/**
 * Parse result including circuit and detected analysis
 */
export interface NetlistParseResult {
    circuit: CircuitJson;
    analysis?: AnalysisConfig;
    title?: string;
    errors: string[];
    warnings: string[];
}

/**
 * Component prefix to type mapping
 */
const PREFIX_TO_TYPE: Record<string, ComponentType> = {
    R: 'resistor',
    C: 'capacitor',
    L: 'inductor',
    V: 'voltage_source',
    I: 'current_source',
    E: 'vcvs',
    G: 'vccs',
    B: 'bsource',
    S: 'switch',
    D: 'diode',
    Q: 'bjt',
    M: 'mosfet',
    J: 'jfet',
    X: 'subckt',
    T: 'tline',
};

/**
 * Parse a SPICE netlist to CircuitJson
 */
export function parseNetlist(netlist: string): NetlistParseResult {
    // Fold SPICE line-continuations ('+' at start of a line continues the previous logical line) BEFORE
    // anything else — real-world .model / long .subckt / source cards from KiCad/LTspice are routinely
    // wrapped this way, and our own generator may wrap too. Each logical line keeps its FIRST source line
    // number for warnings.
    const logical = foldContinuations(netlist.split('\n'));
    const components: Component[] = [];
    const netSet = new Set<string>();
    const errors: string[] = [];
    const warnings: string[] = [];
    let title: string | undefined;
    let analysis: AnalysisConfig | undefined;
    // Round-trip carriers: .model/.subckt bodies become circuit.models; .options/.ic attach to the analysis.
    const models: ModelDef[] = [];
    const seenModelNames = new Set<string>();
    let solverOptions: SolverOptions | undefined;
    let initialConditions: Record<string, number> | undefined;

    // First logical line is usually the title (when it is neither a directive nor a comment).
    if (logical.length > 0 && logical[0] && !logical[0].text.startsWith('.') && !logical[0].text.startsWith('*')) {
        title = logical[0].text.trim();
    }

    let componentCounter: Record<string, number> = {};

    for (let i = 0; i < logical.length; i++) {
        const entry = logical[i]!;
        const line = entry.text.trim();
        const lineNo = entry.lineNo;

        // Skip empty lines and comments
        if (line === '' || line.startsWith('*')) {
            continue;
        }

        const lower = line.toLowerCase();

        // Directives — analysis, plus the round-trip-critical cards the parser used to silently drop.
        if (line.startsWith('.')) {
            // .subckt NAME port... <body...> .ends  — capture the whole block as one ModelDef body, so a
            // re-export emits an identical macromodel (without this the subckt body is lost and the
            // re-exported deck references an undefined subcircuit and no longer simulates).
            if (lower.startsWith('.subckt')) {
                const header = line.split(/\s+/);
                const name = header[1];
                const bodyLines = [line];
                let j = i + 1;
                for (; j < logical.length; j++) {
                    const inner = logical[j]!.text.trim();
                    bodyLines.push(inner);
                    if (inner.toLowerCase().startsWith('.ends')) break;
                }
                if (j >= logical.length) {
                    warnings.push(`Line ${lineNo}: .subckt '${name ?? '?'}' has no matching .ends — captured to end of file`);
                }
                if (name && !seenModelNames.has(name.toLowerCase())) {
                    seenModelNames.add(name.toLowerCase());
                    // Ports are the node tokens after the name, excluding any params: / key=value tail.
                    const portStart = header.slice(2);
                    const ports: string[] = [];
                    for (const tok of portStart) {
                        if (tok.includes('=') || tok.toLowerCase() === 'params:') break;
                        ports.push(tok);
                    }
                    models.push({ name, device: 'subckt', body: bodyLines.join('\n'), ...(ports.length ? { ports } : {}) });
                }
                i = j; // consume through .ends
                continue;
            }

            // .model NAME TYPE(params...)  — a device model card (bjt/mosfet/jfet/diode/switch/digital).
            if (lower.startsWith('.model')) {
                const tok = line.split(/\s+/);
                const name = tok[1];
                const typeToken = tok[2];
                if (name && typeToken && !seenModelNames.has(name.toLowerCase())) {
                    seenModelNames.add(name.toLowerCase());
                    models.push({ name, device: inferModelDevice(typeToken), body: line });
                }
                continue;
            }

            // .options ... — solver tuning; round-trips onto analysis.options. (savecurrents/flags that the
            // generator re-derives from probes are intentionally not carried back.)
            if (lower.startsWith('.options') || lower.startsWith('.option')) {
                solverOptions = { ...solverOptions, ...parseOptionsLine(line) };
                continue;
            }

            // .ic v(node)=val ... — transient initial conditions; round-trips onto a tran analysis.
            if (lower.startsWith('.ic')) {
                initialConditions = { ...initialConditions, ...parseIcLine(line) };
                continue;
            }

            // .include / .lib / .param are not represented in CircuitJson yet — surface as a warning rather
            // than a silent drop so a lossy import is visible to the caller.
            if (lower.startsWith('.include') || lower.startsWith('.lib') || lower.startsWith('.param')) {
                warnings.push(`Line ${lineNo}: directive not imported (not represented in CircuitJson): ${line}`);
                continue;
            }

            const parsedAnalysis = parseDirective(line);
            if (parsedAnalysis) {
                analysis = parsedAnalysis;
            }
            continue;
        }

        // Mutual coupling (Kxxx Ly Lz coeff) couples existing inductors by name — it is a relationship,
        // not a standalone component, so it can't be reconstructed into a CircuitJson component. A
        // generated transformer round-trips as its raw windings; the coupling is export-only. Skip it
        // with an explicit note rather than a misleading "could not parse" error.
        if (/^k/i.test(line)) {
            warnings.push(`Line ${lineNo}: mutual coupling not imported (export-only): ${line}`);
            continue;
        }

        // Parse component
        const parsed = parseComponentLine(line, componentCounter);
        if (parsed) {
            components.push(parsed.component);
            parsed.nets.forEach((n) => netSet.add(n));
            componentCounter = parsed.counter;
        } else {
            warnings.push(`Line ${lineNo}: Could not parse: ${line}`);
        }
    }

    // Attach the round-trip carriers to the analysis (the generator emits .options for any analysis and .ic
    // only for tran). If solver options/ICs appeared without an analysis, keep them off (nothing to emit them
    // onto) — that only happens for hand-written decks with no analysis card.
    if (analysis) {
        if (solverOptions && Object.keys(solverOptions).length > 0) analysis.options = solverOptions;
        if (initialConditions && Object.keys(initialConditions).length > 0 && analysis.type === 'tran') {
            (analysis as TranAnalysis).initialConditions = initialConditions;
        }
    }

    // Build nets array
    const nets: Net[] = Array.from(netSet).map((netName) => ({
        id: netName,
        name: netName,
        isGround: netName === '0' || netName.toLowerCase() === 'gnd',
    }));

    // Add ground if not present but components reference node 0
    if (!nets.find((n) => n.isGround) && netSet.has('0')) {
        // Already handled above
    }

    // Add ground component if there's a ground net. Designator must end in a digit ("GND1", not
    // "GND") — the CircuitJson schema enforces IEEE-style refdes, and the parser's own output must
    // pass the schema (import → editor round-trip).
    const groundNet = nets.find((n) => n.isGround);
    if (groundNet) {
        components.push({
            id: 'gnd1',
            type: 'ground',
            designator: 'GND1',
            pins: [{ pinId: '1', netId: groundNet.id }],
        });
    }

    return {
        circuit: {
            version: '1.0',
            components,
            nets,
            ...(models.length > 0 ? { models } : {}),
            metadata: {
                name: title,
            },
        },
        analysis,
        title,
        errors,
        warnings,
    };
}

/**
 * Fold SPICE line-continuations. A line whose first non-blank character is '+' continues the PREVIOUS
 * logical line (the '+' is replaced by a single space). Blank lines and '*' comments never continue and
 * never receive a continuation. Each returned entry keeps the 1-based source line number of its FIRST
 * physical line (for accurate warnings). A leading '+' with no prior logical line is kept as-is (it will
 * fail to parse and surface a warning, which is the honest outcome for a malformed deck).
 */
function foldContinuations(rawLines: string[]): { text: string; lineNo: number }[] {
    const out: { text: string; lineNo: number }[] = [];
    for (let i = 0; i < rawLines.length; i++) {
        const raw = rawLines[i] ?? '';
        const trimmed = raw.trim();
        const isContinuation = trimmed.startsWith('+');
        const prev = out[out.length - 1];
        // Continue only onto a real prior statement (not a comment/blank/title we'd corrupt).
        if (isContinuation && prev && prev.text.trim() !== '' && !prev.text.trim().startsWith('*')) {
            prev.text += ' ' + trimmed.slice(1).trim();
        } else {
            out.push({ text: raw, lineNo: i + 1 });
        }
    }
    return out;
}

/** Infer the ModelDef.device tag from a `.model NAME <TYPE>(...)` type token. `device` is informational
 *  (the generator emits the body verbatim and dedups by name), so an unrecognized type falls back to
 *  'diode' without affecting round-trip fidelity. */
function inferModelDevice(typeToken: string): ModelDef['device'] {
    const t = typeToken.replace(/\(.*$/, '').trim().toLowerCase(); // strip a trailing "(params..."
    if (t === 'npn' || t === 'pnp') return 'bjt';
    if (t === 'nmos' || t === 'pmos') return 'mosfet';
    if (t === 'njf' || t === 'pjf') return 'jfet';
    if (t === 'sw' || t === 'csw') return 'switch';
    if (t.startsWith('d_') || t.endsWith('_bridge')) return 'digital'; // XSPICE code models + adc/dac bridges
    return 'diode'; // 'd' and anything else
}

/** Parse a `.options k=v k=v flag` card into the SolverOptions we round-trip. Unknown keys/flags
 *  (e.g. savecurrents, which the generator re-derives from probes) are ignored. */
function parseOptionsLine(line: string): SolverOptions {
    const opts: SolverOptions = {};
    const body = line.replace(/^\s*\.options?\s*/i, '');
    for (const tok of body.split(/\s+/)) {
        const m = /^([a-z0-9]+)\s*=\s*(\S+)$/i.exec(tok);
        if (!m) continue;
        const key = m[1]!.toLowerCase();
        const val = m[2]!;
        switch (key) {
            case 'reltol': opts.reltol = val; break;
            case 'abstol': opts.abstol = val; break;
            case 'vntol': opts.vntol = val; break;
            case 'gmin': opts.gmin = val; break;
            case 'method': if (val.toLowerCase() === 'trap' || val.toLowerCase() === 'gear') opts.method = val.toLowerCase() as 'trap' | 'gear'; break;
            case 'itl4': { const n = parseInt(val, 10); if (Number.isFinite(n)) opts.itl4 = n; break; }
        }
    }
    return opts;
}

/** Parse a `.ic v(node)=val v(node2)=val2` card into an initial-conditions map keyed by NODE id. */
function parseIcLine(line: string): Record<string, number> {
    const ic: Record<string, number> = {};
    const re = /v\(\s*([^)=\s]+)\s*\)\s*=\s*([+-]?\d*\.?\d+(?:e[+-]?\d+)?)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
        const node = m[1]!;
        const val = Number(m[2]);
        if (Number.isFinite(val)) ic[node] = val;
    }
    return ic;
}

/**
 * Parse a single component line
 */
function parseComponentLine(
    line: string,
    counter: Record<string, number>,
): { component: Component; nets: string[]; counter: Record<string, number> } | null {
    const parts = line.split(/\s+/);
    if (parts.length < 3) {
        return null;
    }

    const designator = parts[0] || '';
    const prefix = designator.charAt(0).toUpperCase();
    const type = PREFIX_TO_TYPE[prefix];

    if (!type) {
        return null; // Unknown component type
    }

    // Update counter for ID generation
    counter[prefix] = (counter[prefix] || 0) + 1;
    const id = `${prefix.toLowerCase()}${counter[prefix]}`;

    let component: Component;
    const nets: string[] = [];

    switch (type) {
        case 'resistor':
        case 'capacitor':
        case 'inductor': {
            // Format: R1 node1 node2 value
            const node1 = parts[1] || '0';
            const node2 = parts[2] || '0';
            const value = parts.slice(3).join(' ') || '0';

            nets.push(node1, node2);

            component = {
                id,
                type,
                designator,
                value,
                pins: [
                    { pinId: '1', netId: node1 },
                    { pinId: '2', netId: node2 },
                ],
            };
            break;
        }

        case 'voltage_source':
        case 'current_source': {
            // Format: V1 node+ node- value
            const nodePos = parts[1] || '0';
            const nodeNeg = parts[2] || '0';
            const value = parts.slice(3).join(' ') || 'DC 0';

            nets.push(nodePos, nodeNeg);

            component = {
                id,
                type,
                designator,
                value,
                pins: [
                    { pinId: '+', netId: nodePos },
                    { pinId: '-', netId: nodeNeg },
                ],
            };
            break;
        }

        case 'switch': {
            // Format: S1 n+ n- nc+ nc- model   (voltage-controlled switch)
            const op = parts[1] || '0';
            const on = parts[2] || '0';
            const cp = parts[3] || '0';
            const cn = parts[4] || '0';
            const model = parts[5];

            nets.push(op, on, cp, cn);

            component = {
                id,
                type,
                designator,
                model,
                pins: [
                    { pinId: '+', netId: op },
                    { pinId: '-', netId: on },
                    { pinId: 'c+', netId: cp },
                    { pinId: 'c-', netId: cn },
                ],
            };
            break;
        }

        case 'bsource': {
            // Format: B1 n+ n- V=<expr>  (or I=<expr>) — arbitrary behavioral source.
            const np = parts[1] || '0';
            const nn = parts[2] || '0';
            const value = parts.slice(3).join(' ');

            nets.push(np, nn);

            component = {
                id,
                type,
                designator,
                value,
                pins: [
                    { pinId: '+', netId: np },
                    { pinId: '-', netId: nn },
                ],
            };
            break;
        }

        case 'vcvs':
        case 'vccs': {
            // Only the LINEAR form is supported on import. A POLY / VALUE= / {expr} (behavioral) form
            // would bind keywords as phantom control nodes, so skip it (the caller logs a parse warning)
            // instead of silently corrupting the circuit.
            if (/\b(poly|value)\b|[={}]/i.test(line)) {
                return null;
            }
            // Format: E1/G1 out+ out- ctrl+ ctrl- gain   (linear voltage-controlled source)
            const op = parts[1] || '0';
            const on = parts[2] || '0';
            const cp = parts[3] || '0';
            const cn = parts[4] || '0';
            const value = parts.slice(5).join(' ') || '0';

            nets.push(op, on, cp, cn);

            component = {
                id,
                type,
                designator,
                value,
                pins: [
                    { pinId: '+', netId: op },
                    { pinId: '-', netId: on },
                    { pinId: 'c+', netId: cp },
                    { pinId: 'c-', netId: cn },
                ],
            };
            break;
        }

        case 'diode': {
            // Format: D1 anode cathode model
            const anode = parts[1] || '0';
            const cathode = parts[2] || '0';
            const model = parts[3];

            nets.push(anode, cathode);

            component = {
                id,
                type,
                designator,
                model,
                pins: [
                    { pinId: 'anode', netId: anode },
                    { pinId: 'cathode', netId: cathode },
                ],
            };
            break;
        }

        case 'bjt': {
            // Format: Q1 nc nb ne model  (collector base emitter)
            const c = parts[1] || '0';
            const b = parts[2] || '0';
            const e = parts[3] || '0';
            const model = parts[4];

            nets.push(c, b, e);

            component = {
                id,
                type,
                designator,
                model,
                pins: [
                    { pinId: 'c', netId: c },
                    { pinId: 'b', netId: b },
                    { pinId: 'e', netId: e },
                ],
            };
            break;
        }

        case 'mosfet': {
            // Format: M1 nd ng ns nb model  (drain gate source bulk)
            const d = parts[1] || '0';
            const g = parts[2] || '0';
            const s = parts[3] || '0';
            const bulk = parts[4] || '0';
            const model = parts[5];

            nets.push(d, g, s, bulk);

            component = {
                id,
                type,
                designator,
                model,
                pins: [
                    { pinId: 'd', netId: d },
                    { pinId: 'g', netId: g },
                    { pinId: 's', netId: s },
                    { pinId: 'b', netId: bulk },
                ],
            };
            break;
        }

        case 'jfet': {
            // Format: J1 nd ng ns model  (drain gate source)
            const d = parts[1] || '0';
            const g = parts[2] || '0';
            const s = parts[3] || '0';
            const model = parts[4];

            nets.push(d, g, s);

            component = {
                id,
                type,
                designator,
                model,
                pins: [
                    { pinId: 'd', netId: d },
                    { pinId: 'g', netId: g },
                    { pinId: 's', netId: s },
                ],
            };
            break;
        }

        case 'tline': {
            // Format: T1 a+ a- b+ b- Z0=<z> TD=<t>   (or the F=/NL= frequency form)
            const ap = parts[1] || '0';
            const an = parts[2] || '0';
            const bp = parts[3] || '0';
            const bn = parts[4] || '0';
            // A '=' in a node slot means the line is truncated (a param leaked into the node positions);
            // reject so it surfaces as a parse warning instead of inventing phantom nodes from keywords.
            if ([ap, an, bp, bn].some((n) => n.includes('='))) {
                return null;
            }
            nets.push(ap, an, bp, bn);

            const rest = parts.slice(5).join(' ');
            const z0 = /\bZ0\s*=\s*(\S+)/i.exec(rest)?.[1];
            const td = /\bTD\s*=\s*(\S+)/i.exec(rest)?.[1];
            const f = /\bF\s*=\s*(\S+)/i.exec(rest)?.[1];
            const nl = /\bNL\s*=\s*(\S+)/i.exec(rest)?.[1];

            component = {
                id,
                type,
                designator,
                properties: {
                    ...(z0 ? { z0 } : {}),
                    ...(td ? { td } : {}),
                    ...(f ? { f } : {}),
                    ...(nl ? { nl } : {}),
                },
                pins: [
                    { pinId: 'a+', netId: ap },
                    { pinId: 'a-', netId: an },
                    { pinId: 'b+', netId: bp },
                    { pinId: 'b-', netId: bn },
                ],
            };
            break;
        }

        case 'subckt': {
            // Format: Xname n1 n2 ... nN subcktName  (variable-arity; the LAST token is the model name).
            // Port names aren't recoverable from the instance line, so pins get index-based ids in order.
            const model = parts[parts.length - 1];
            const nodeTokens = parts.slice(1, parts.length - 1);
            nodeTokens.forEach((n) => nets.push(n));

            component = {
                id,
                type,
                designator,
                model,
                pins: nodeTokens.map((netId, idx) => ({ pinId: String(idx + 1), netId })),
            };
            break;
        }

        default:
            return null;
    }

    return { component, nets, counter };
}

/**
 * Parse analysis directives
 */
function parseDirective(line: string): AnalysisConfig | null {
    const lower = line.toLowerCase();
    const parts = line.split(/\s+/);

    if (lower.startsWith('.tran')) {
        // .tran step stop [start] [max]
        const step = parts[1];
        const stop = parts[2];
        const start = parts[3];

        if (step && stop) {
            const analysis: TranAnalysis = {
                type: 'tran',
                stepTime: step,
                stopTime: stop,
            };
            if (start) {
                analysis.startTime = start;
            }
            return analysis;
        }
    }

    if (lower.startsWith('.ac')) {
        // .ac dec|oct|lin points fstart fstop
        const variation = parts[1]?.toLowerCase() as 'dec' | 'oct' | 'lin';
        const points = parseInt(parts[2] || '10', 10);
        const startFreq = parts[3];
        const stopFreq = parts[4];

        if (variation && startFreq && stopFreq) {
            const analysis: AcAnalysis = {
                type: 'ac',
                variation,
                points,
                startFreq,
                stopFreq,
            };
            return analysis;
        }
    }

    if (lower.startsWith('.dc')) {
        // .dc source start stop increment
        const source = parts[1];
        const startVal = parts[2];
        const stopVal = parts[3];
        const increment = parts[4];

        if (source && startVal && stopVal && increment) {
            const analysis: DcAnalysis = {
                type: 'dc',
                source,
                startVal,
                stopVal,
                increment,
            };
            return analysis;
        }
    }

    if (lower.startsWith('.op')) {
        const analysis: OpAnalysis = {
            type: 'op',
        };
        return analysis;
    }

    return null;
}

/**
 * Extract probes from a netlist (looks for wrdata or print commands)
 */
export function extractProbes(netlist: string): string[] {
    const probes: string[] = [];
    const lines = netlist.split('\n');

    for (const line of lines) {
        const trimmed = line.trim().toLowerCase();

        // A probe token is v(...), i(...), or the device-current vector @<dev>[i] (emitted for R/C/D currents,
        // which have no native i() in batch mode). Capturing @... keeps the extracted probe list aligned with
        // the wrdata columns — otherwise the parser would map columns to a short list and lose/shift series.
        const isProbeToken = (p: string) => p.startsWith('v(') || p.startsWith('i(') || p.startsWith('@');

        // Look for wrdata command
        if (trimmed.startsWith('wrdata')) {
            const parts = trimmed.split(/\s+/).slice(2); // Skip 'wrdata' and filename
            probes.push(...parts.filter(isProbeToken));
        }

        // Look for print command
        if (trimmed.startsWith('print') || trimmed.startsWith('.print')) {
            const parts = trimmed.split(/\s+/).slice(1);
            probes.push(...parts.filter(isProbeToken));
        }
    }

    return [...new Set(probes)]; // Remove duplicates
}