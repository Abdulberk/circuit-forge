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
    // NOTE: 'A' (XSPICE digital) is deliberately ABSENT — one 'A' device maps to many ComponentTypes
    // depending on its CFD_* model, so digital lines are handled separately (parseDigitalLine), not here.
};

/**
 * Reverse of the generator's DIGITAL_BASENAME map: a CFD_* model base name -> the digital ComponentType
 * that emitted it. (CFD_ADC/CFD_DAC are analog<->digital BRIDGES, not components — recognized separately
 * and skipped on import.) A custom-timing variant is suffixed CFD_<TYPE>_<n>; the trailing _<n> is stripped
 * before lookup. Lets a digital 'A'-device line round-trip back to its gate / flip-flop / latch / tristate type.
 */
const CFD_MODEL_TO_TYPE: Record<string, ComponentType> = {
    CFD_AND: 'logic_and', CFD_OR: 'logic_or', CFD_NAND: 'logic_nand', CFD_NOR: 'logic_nor',
    CFD_XOR: 'logic_xor', CFD_XNOR: 'logic_xnor', CFD_NOT: 'logic_not', CFD_BUF: 'logic_buffer',
    CFD_DFF: 'dff', CFD_JKFF: 'jkff', CFD_TFF: 'tff', CFD_DLATCH: 'dlatch', CFD_TRI: 'tristate',
};

/** Fixed XSPICE port orders (match the generator's emitDigitalComponent emission), for mapping a bare
 *  node list on a sequential/tristate 'A'-device back to named pins. Gates are variable-arity (handled
 *  separately: all-but-last nodes are inputs in1..inN, last node is the output). */
const DIGITAL_PORT_ORDER: Partial<Record<ComponentType, string[]>> = {
    dff: ['d', 'clk', 'set', 'rst', 'q', 'qb'],
    jkff: ['j', 'k', 'clk', 'set', 'rst', 'q', 'qb'],
    tff: ['t', 'clk', 'set', 'rst', 'q', 'qb'],
    dlatch: ['d', 'en', 'set', 'rst', 'q', 'qb'],
    tristate: ['in1', 'en', 'out'],
};

/** A node synthesized by the mixed-signal planner: a split digital twin (`<net>_d`) or a probe mirror
 *  (`<net>_p`), optionally uniquified with a trailing `_<n>`. Used to decide which side of a bridge is the
 *  REAL net (the other side) when re-merging a split mixed net on import. */
const SYNTH_NODE = /(?:_d|_p)(?:_\d+)?$/i;
/** The synthesized constant digital-LOW rail node (`dlogic_lo`, analog twin `dlogic_lo_a`, uniquified
 *  `dlogic_lo_<n>`). A flip-flop set/rst tied here was AUTO-tied (absent in the authored circuit) and is
 *  dropped on import so the re-export re-synthesizes it. */
const LOW_RAIL_NODE = /^dlogic_lo(?:_a)?(?:_\d+)?$/i;

/**
 * Parse a SPICE netlist to CircuitJson
 */
export function parseNetlist(netlist: string): NetlistParseResult {
    // Fold SPICE line-continuations ('+' at start of a line continues the previous logical line) BEFORE
    // anything else — real-world .model / long .subckt / source cards from KiCad/LTspice are routinely
    // wrapped this way, and our own generator may wrap too. Each logical line keeps its FIRST source line
    // number for warnings.
    const logical = foldContinuations(netlist.split('\n'));
    // Re-merge mixed-signal nets that the generator SPLIT (a mixed net's digital pins were moved onto a
    // synthesized `<net>_d` node, bridged back to the analog `<net>` by an adc/dac a-device). Pre-scan the
    // bridges to map each synthesized node back to its real net, so digital pins re-attach to the same net
    // the analog devices use. Empty for a netlist with no digital bridges (analog import is unaffected).
    const digitalMerge = buildDigitalMergeMap(logical);
    const canonNode = (n: string): string => digitalMerge.get(n) ?? n;
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
            // .control ... .endc — an ngspice OUTPUT/SWEEP control block, NOT circuit topology. Its body is
            // dotless commands (set/run/wrdata/let/alter/print/plot, and sometimes the analysis itself like
            // `tran 1u 1m`). Without consuming the block, every dotless body line falls through to
            // parseComponentLine and is misread as a component by its first letter (T→tline, D→diode,
            // L→inductor, …), injecting PHANTOM devices + phantom nets that then re-export + simulate to a
            // wrong answer. Consume the whole block like .subckt/.ends; recover an analysis command if one is
            // stated inside it (equivalent to the `.tran`/`.ac`/`.dc`/`.op` dot-card).
            if (lower.startsWith('.control')) {
                let j = i + 1;
                for (; j < logical.length; j++) {
                    const body = logical[j]!.text.trim();
                    if (body.toLowerCase().startsWith('.endc')) break;
                    const head = body.split(/\s+/)[0]?.toLowerCase();
                    if (head === 'tran' || head === 'ac' || head === 'dc' || head === 'op') {
                        const a = parseDirective('.' + body);
                        if (a) analysis = a;
                    }
                }
                if (j >= logical.length) {
                    warnings.push(`Line ${lineNo}: .control block has no matching .endc — skipped to end of file`);
                }
                i = j; // consume through .endc
                continue;
            }

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
                    // Do NOT populate ModelDef.ports for a PARSED subckt. The instance that references it was
                    // reconstructed with POSITIONAL pinIds ('1'..'N') in port order; if we also set ModelDef.ports
                    // to the recovered names, the generator's pin-resolution expects those NAMES on the instance
                    // and throws 'missing pin' on re-export. Leaving ports undefined keeps the positional binding
                    // (which is already correct), so the macromodel round-trips + re-simulates.
                    models.push({ name, device: 'subckt', body: bodyLines.join('\n') });
                }
                i = j; // consume through .ends
                continue;
            }

            // .model NAME TYPE(params...)  — a device model card (bjt/mosfet/jfet/diode/switch/digital).
            if (lower.startsWith('.model')) {
                const tok = line.split(/\s+/);
                const name = tok[1];
                const typeToken = tok[2];
                // Skip the engine-synthesized digital/bridge models (namespaced CFD_*): they are regenerated
                // from the digital components on export, so carrying them in circuit.models would duplicate
                // them (and shuffle their section). Caller-supplied models (bjt/diode/subckt) are kept.
                if (name && /^cfd_/i.test(name)) continue;
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

        const firstTok = line.split(/\s+/)[0] ?? '';

        // The synthesized constant digital-LOW rail source (vxsynN <node> 0 DC 0) is regenerated on export —
        // import it as a real voltage_source and we'd emit a spurious extra source. Skip it.
        if (/^vxsyn\d/i.test(firstTok)) {
            warnings.push(`Line ${lineNo}: synthesized digital LOW rail not imported (export-only): ${line}`);
            continue;
        }

        // XSPICE 'a'-device: a digital gate/flip-flop/tristate (mapped back via its CFD_* model) OR a
        // synthesized adc/dac bridge (CFD_ADC/CFD_DAC — regenerated on export, so skipped). 'A' is never an
        // analog component prefix, so any 'A' line is digital.
        if (/^a/i.test(firstTok)) {
            const d = parseDigitalLine(line, componentCounter, canonNode);
            if (d === 'bridge') continue; // synthesized analog<->digital bridge — re-synthesized on export
            if (d) {
                components.push(d.component);
                d.nets.forEach((n) => netSet.add(n));
                componentCounter = d.counter;
            } else {
                warnings.push(`Line ${lineNo}: Could not parse digital device: ${line}`);
            }
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
 * Build the synthesized-node -> real-net merge map from the adc/dac bridge a-devices in a (folded) netlist.
 * A mixed net is emitted as a real analog node `<net>` plus a synthesized digital twin `<net>_d`, joined by
 * a bridge `axsynN [<net>] [<net>_d] CFD_ADC` (or the dac direction); a pure-digital net gets a probe mirror
 * `<net>_p`. Mapping the synthesized side back to the real side lets digital pins re-attach to the net the
 * analog devices use, so a round-tripped mixed-signal circuit reconnects instead of fragmenting.
 */
function buildDigitalMergeMap(logical: { text: string; lineNo: number }[]): Map<string, string> {
    const merge = new Map<string, string>();
    for (const e of logical) {
        const line = e.text.trim();
        const tok = line.split(/\s+/);
        const inst = tok[0] ?? '';
        if (!/^a/i.test(inst)) continue;
        const modelBase = (tok[tok.length - 1] ?? '').replace(/_\d+$/i, '').toUpperCase();
        if (modelBase !== 'CFD_ADC' && modelBase !== 'CFD_DAC') continue; // only bridges carry a merge
        const m = line.match(/\[\s*([^\]\s]+)\s*\]\s*\[\s*([^\]\s]+)\s*\]/);
        if (!m) continue;
        const a = m[1]!;
        const b = m[2]!;
        // The rail bridge ([dlogic_lo_a] [dlogic_lo]) joins two synthesized nodes — nothing real to merge to.
        if (LOW_RAIL_NODE.test(a) || LOW_RAIL_NODE.test(b)) continue;
        // Merge the synthesized side (the `_d`/`_p` twin) into the real net (the other side).
        if (SYNTH_NODE.test(a) && !SYNTH_NODE.test(b)) merge.set(a, b);
        else if (SYNTH_NODE.test(b) && !SYNTH_NODE.test(a)) merge.set(b, a);
    }
    return merge;
}

/**
 * Parse an XSPICE 'a'-device line back into a digital Component, or the sentinel 'bridge' for a synthesized
 * adc/dac bridge the caller should skip, or null for an unrecognized a-device. Node names are run through
 * `canon` to re-merge split mixed nets; an auto-tied set/rst on the synthesized LOW rail is dropped (the
 * generator re-ties it on export). The designator keeps the emitted 'A'-prefixed instance name (e.g. AU1).
 */
function parseDigitalLine(
    line: string,
    counter: Record<string, number>,
    canon: (n: string) => string,
): { component: Component; nets: string[]; counter: Record<string, number> } | 'bridge' | null {
    const tok = line.split(/\s+/);
    if (tok.length < 3) return null;
    const inst = tok[0]!;
    const modelBase = (tok[tok.length - 1] ?? '').replace(/_\d+$/i, '').toUpperCase();
    if (modelBase === 'CFD_ADC' || modelBase === 'CFD_DAC') return 'bridge';
    const type = CFD_MODEL_TO_TYPE[modelBase];
    if (!type) return null;

    // Node tokens between the instance name and the model name, with bracket grouping flattened, canon()'d.
    const nodes = tok
        .slice(1, -1)
        .join(' ')
        .replace(/[[\]]/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(canon);
    if (nodes.length < 2) return null;

    counter['A'] = (counter['A'] || 0) + 1;
    const id = `a${counter['A']}`;
    let pins: { pinId: string; netId: string }[];

    if (type.startsWith('logic_')) {
        // Gate: every node but the last is an input (in1..inN), the last node is the output.
        const out = nodes[nodes.length - 1]!;
        const inputs = nodes.slice(0, -1);
        pins = inputs.map((netId, i) => ({ pinId: `in${i + 1}`, netId }));
        pins.push({ pinId: 'out', netId: out });
    } else {
        const order = DIGITAL_PORT_ORDER[type];
        if (!order || nodes.length < order.length) return null;
        pins = [];
        order.forEach((pinId, i) => {
            const netId = nodes[i]!;
            // Drop an auto-tied set/rst on the synthesized LOW rail (it was absent in the authored circuit).
            if ((pinId === 'set' || pinId === 'rst') && LOW_RAIL_NODE.test(netId)) return;
            pins.push({ pinId, netId });
        });
    }

    const nets = pins.map((p) => p.netId);
    return { component: { id, type, designator: inst, pins }, nets, counter };
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