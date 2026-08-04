/**
 * SPICE Netlist Generator
 * Converts CircuitJson to ngspice-compatible netlist format
 */
import {
    buildZenerModel,
    normalizeControlledSourceGain,
    parseTransformerParams,
    parseTransmissionLineParams,
    resolveGenericModels,
} from '../models/library';
import type { AnalysisConfig } from '../types/analysis';
import { analysisToSpice } from '../types/analysis';
import type { CircuitJson, Component, ModelDef } from '../types/circuit';
import { SPICE_PREFIXES, COMPONENT_PINS, COMPONENT_TYPES, isDigitalType, isSimulatable } from '../types/circuit';

import { planMixedSignal, emitDigitalComponent, aInstanceName, type MixedSignalPlan } from './digital';
import { buildNetRefToNode, buildNodeMap, normalizeProbe, rewriteProbeNodeRefs } from './probe-map';
import { validateIncludePaths } from './sanitizer';
import { solverOptionTokens } from './solver-options';

// Re-exported so every existing consumer keeps importing these from where it always did. They moved for a
// reason that is about who OWNS the mapping, not about where callers should look for it.
export { buildNodeMap, rewriteProbeNodeRefs } from './probe-map';

/** All valid ComponentType values, for a fail-loud guard against an unknown type slipping through. */
const VALID_COMPONENT_TYPES = new Set<string>(COMPONENT_TYPES);

/**
 * Netlist generation options
 */
export interface NetlistOptions {
    title?: string;
    probes?: string[];
    /**
     * Extra probes to UNION with the auto-generated default probes (unlike `probes`, which REPLACES them).
     * Use this to add probes the defaults don't cover — chiefly branch-CURRENT probes (`i(R1)`), since the
     * defaults only save node voltages. Each is run through the same rewrite/drop pipeline as any other
     * probe (R/C currents → `@<dev>[i]` + savecurrents; unobservable ones are silently dropped, leaving the
     * default voltage probes intact). Ignored when `probes` is set (an explicit override already wins).
     */
    extraProbes?: string[];
    includeFiles?: string[];
    outputFormat?: 'csv' | 'raw';
    jobDir?: string; // For include path validation
    /**
     * Logic-HIGH supply voltage (volts) for digital↔analog bridges. Omit to AUTO-DETECT from the digital
     * domain's supply (default 5 V if none). Set explicitly to pin a logic family (e.g. 3.3 for 3V3 CMOS).
     */
    logicVoltage?: number;
    /**
     * Ambient simulation temperature (°C) emitted as a `.temp <T>` card — the temperature-corner axis. ngspice
     * recomputes device-model temperature physics (semiconductor IS/BF/mobility drift) at this single uniform
     * temperature. AMBIENT ONLY: it models board/ambient temperature, NOT device self-heating (junction-temp
     * rise Tj = Ta + P·Rth). Omit for the ngspice default TNOM (27 °C). A passive-only circuit is
     * temperature-flat here (no TC1/TC2 emitted), so this is a physical no-op there.
     */
    temperatureC?: number;
}

/**
 * Default diode model for circuits without explicit model
 */
/**
 * A deliberate refusal to build a deck: something about THIS circuit or THIS analysis makes a runnable
 * netlist impossible, and the message says what.
 *
 * The type is the classification. It used to be done by regex over error MESSAGES in the fuzz harness —
 * so the list of intentional refusals lived in a test script rather than with the code that raises them,
 * and rewording a message silently reclassified a deliberate refusal as a bug (or a bug as fine). With a
 * type, "was this on purpose?" has one answer and it cannot drift from the throw.
 *
 * The distinction it encodes is the one that matters to a caller: a DeckRefusal is a statement about the
 * INPUT and is actionable by whoever supplied it. Anything else escaping the generator is a statement
 * about US — an internal fault — and is a bug however loud it is.
 */
export class DeckRefusal extends Error {
    /**
     * A stable marker, checked by `isDeckRefusal` instead of `instanceof`.
     *
     * `instanceof` compares prototype identity, which silently stops matching whenever the package is
     * loaded twice — a dual CJS/ESM resolution, two copies under different hoisting, a consumer bundling
     * its own. The failure is the worst kind for this particular class: a deliberate, explained refusal
     * would be reclassified as an internal fault, which is exactly the confusion the type exists to end.
     */
    readonly isDeckRefusal = true as const;

    constructor(message: string) {
        super(message);
        this.name = 'DeckRefusal';
    }
}

/** True for a deliberate refusal to build a deck — see DeckRefusal.isDeckRefusal for why not `instanceof`. */
export function isDeckRefusal(e: unknown): e is DeckRefusal {
    return typeof e === 'object' && e !== null && (e as { isDeckRefusal?: unknown }).isDeckRefusal === true;
}

/**
 * Ask whether a deck can be built, WITHOUT building one: the refusal that generateNetlist would raise, or
 * null.
 *
 * Implemented by attempting generation rather than by re-listing the checks. A separate list of "reasons
 * we would refuse" is a second copy of the rules, and the two drift — which is the failure this whole
 * change is about. Here the question and the enforcement are literally the same code, so they cannot
 * disagree, and a caller can spend nothing to find out (the design loop can fix a circuit before paying
 * for a simulation round instead of after).
 */
export function validateDeck(
    circuit: CircuitJson,
    analysis: AnalysisConfig,
    options: NetlistOptions = {},
): DeckRefusal | null {
    try {
        generateNetlist(circuit, analysis, options);
        return null;
    } catch (e) {
        if (isDeckRefusal(e)) return e;
        throw e; // an internal fault is not an answer to "is this deck buildable?"
    }
}

const DEFAULT_DIODE_MODEL = `.model DDEFAULT D(IS=1e-14 N=1.05 RS=10 BV=100 IBV=1e-10)`;

/**
 * Generate a complete SPICE netlist from circuit JSON
 */
export function generateNetlist(circuit: CircuitJson, analysis: AnalysisConfig, options: NetlistOptions = {}): string {
    const lines: string[] = [];

    // Title
    const title = options.title || circuit.metadata?.name || 'Untitled Circuit';
    lines.push(`* ${title}`);
    lines.push(`* Generated by eda-core`);
    lines.push(`* ${new Date().toISOString()}`);
    lines.push('');

    // Build node map
    const nodeMap = buildNodeMap(circuit.nets);

    // ngspice node names are CASE-INSENSITIVE. Two distinct nets whose sanitized nodes differ only by case
    // (e.g. "out"→"x_out" and "OUT"→"x_OUT", or "sig"→"nsig" and "SIG"→"nSIG") would be silently MERGED by
    // ngspice into one node — a silently wrong netlist. Fail loud instead (mirrors the duplicate-device guard).
    const nodeOwner = new Map<string, string>(); // lower-cased node -> first net id that produced it
    for (const [netId, node] of nodeMap) {
        if (node === '0') continue; // multiple ground nets legitimately share node 0
        const key = node.toLowerCase();
        const prev = nodeOwner.get(key);
        if (prev !== undefined) {
            throw new DeckRefusal(
                `Net node-name collision: nets '${prev}' and '${netId}' both map to SPICE node '${node}' (ngspice node names are case-insensitive). Rename one so they don't differ only by case.`,
            );
        }
        nodeOwner.set(key, netId);
    }

    // An `.ac` run only excites sources that declare an AC magnitude; with none, EVERY probe is identically
    // zero at all frequencies — a meaningless all-zero result that still "succeeds" (exit 0, finite). Fail
    // loud so a frequency-response request with a DC-only source is corrected, not silently returned as flat.
    if (analysis.type === 'ac') {
        const hasAcSource = circuit.components.some(
            (c) =>
                (c.type === 'voltage_source' || c.type === 'current_source') &&
                typeof c.value === 'string' &&
                /\bac\b/i.test(c.value),
        );
        if (!hasAcSource) {
            throw new DeckRefusal(
                `AC analysis requires at least one source with an AC magnitude (e.g. value "AC 1"); none found — ` +
                    `every probe would be identically zero across the sweep.`,
            );
        }
    }

    // Reserve the SPICE instance name of every real component so the mixed-signal pre-pass can pick
    // synthesized bridge/rail device names that never collide with a user designator (mirrors the node
    // uniqueness already done for synthesized nodes). The synthesized devices are leaf/unreferenced, so a
    // collision-avoiding rename is always safe. Empty / harmless for analog-only circuits.
    const reservedDeviceNames = new Set<string>();
    for (const c of circuit.components) {
        // `ground` is node 0, not a device. Everything else that has no electrical model is decided by the
        // shared predicate, so a future non-simulatable type cannot be emitted here by accident.
        if (c.type === 'ground' || !isSimulatable(c)) continue;
        const prefix = SPICE_PREFIXES[c.type];
        const name = isDigitalType(c.type)
            ? aInstanceName(c.designator)
            : prefix
              ? spiceInstanceName(c.designator, prefix)
              : null;
        if (name) reservedDeviceNames.add(name.toLowerCase());
    }

    // Mixed-signal pre-pass: classify nets, plan analog<->digital bridges + the digital-node overrides,
    // synthesize bridge/rail devices + their models. A no-op (empty) for analog-only circuits.
    const ms = planMixedSignal(circuit, nodeMap, reservedDeviceNames, options.logicVoltage);

    /**
     * The models this deck will actually carry: what the circuit declares, PLUS the vetted generic bodies
     * its components reference by name.
     *
     * Resolved HERE rather than by the caller. It used to be the caller's job and five of them did it —
     * the design loop, two API services and two harnesses — each with the same three lines. That made
     * "will this model exist at simulation time?" a question with as many answers as there were callers,
     * and left ERC unable to be right about it: a reference the generator would satisfy and one that would
     * abort the whole run looked identical to the gate, so it could only warn about both. A step that must
     * always happen is not the caller's to remember.
     *
     * Idempotent: resolveGenericModels skips anything already declared, so a caller that still injects
     * gets exactly the same deck.
     */
    const models: ModelDef[] = [...(circuit.models ?? []), ...resolveGenericModels(circuit)];

    // Track every emitted .model/.subckt name -> body so we (a) dedup identical definitions and
    // (b) refuse to SILENTLY drop a conflicting body that reuses a name (which would emit only the
    // first and simulate the wrong device). The reserved default diode model seeds the map so a
    // caller-supplied 'DDEFAULT' can't produce a duplicate card or shadow the built-in defaults.
    const emittedModels = new Map<string, string>();

    // Check if we need default diode model
    const needsDiodeModel = circuit.components.some((c) => c.type === 'diode' && !c.model);
    if (needsDiodeModel) {
        lines.push('* Default diode model');
        lines.push(DEFAULT_DIODE_MODEL);
        lines.push('');
        emittedModels.set('DDEFAULT', DEFAULT_DIODE_MODEL);
    }

    // Circuit-level model/subckt definitions (active devices reference these by name). Emitted once,
    // before the component lines that reference them. A repeated name with an identical body is a
    // harmless duplicate (dropped); a repeated name with a DIFFERENT body is a hard error.
    if (models.length > 0) {
        const modelLines: string[] = [];
        for (const m of models) {
            const existing = emittedModels.get(m.name);
            if (existing !== undefined) {
                if (existing !== m.body) {
                    throw new DeckRefusal(
                        `Conflicting definitions for model '${m.name}': the same name is defined with two different bodies.`,
                    );
                }
                continue; // identical duplicate — already emitted
            }
            emittedModels.set(m.name, m.body);
            modelLines.push(m.body);
        }
        if (modelLines.length > 0) {
            lines.push('* Models');
            lines.push(...modelLines);
            lines.push('');
        }
    }

    // Zener models: generated parametrically from each zener component's breakdown voltage (`value`),
    // deduped by name (same voltage -> one model) and conflict-checked against everything above.
    const zenerLines: string[] = [];
    for (const c of circuit.components) {
        if (c.type !== 'zener') continue;
        const zm = c.value ? buildZenerModel(c.value) : null;
        if (!zm) continue; // a value-less / unparseable zener is skipped here and flagged by ERC
        const existing = emittedModels.get(zm.name);
        if (existing !== undefined) {
            if (existing !== zm.body) {
                throw new DeckRefusal(
                    `Conflicting definitions for model '${zm.name}': the same name is defined with two different bodies.`,
                );
            }
            continue;
        }
        emittedModels.set(zm.name, zm.body);
        zenerLines.push(zm.body);
    }
    if (zenerLines.length > 0) {
        lines.push('* Zener models');
        lines.push(...zenerLines);
        lines.push('');
    }

    // Digital / bridge models (XSPICE gate/flip-flop timing + adc/dac bridges), deduped + conflict-checked
    // alongside the rest. Empty for analog-only circuits.
    if (ms.modelCards.length > 0) {
        const digitalModelLines: string[] = [];
        for (const card of ms.modelCards) {
            const name = card.split(/\s+/)[1] ?? ''; // ".model <NAME> ..."
            const existing = emittedModels.get(name);
            if (existing !== undefined) {
                if (existing !== card) {
                    throw new DeckRefusal(
                        `Conflicting definitions for model '${name}': the same name is defined with two different bodies.`,
                    );
                }
                continue;
            }
            emittedModels.set(name, card);
            digitalModelLines.push(card);
        }
        if (digitalModelLines.length > 0) {
            lines.push('* Digital / bridge models');
            lines.push(...digitalModelLines);
            lines.push('');
        }
    }

    // Include files (with validation)
    if (options.includeFiles && options.includeFiles.length > 0) {
        if (options.jobDir) {
            validateIncludePaths(options.includeFiles, options.jobDir);
        }
        lines.push('* Include files');
        for (const file of options.includeFiles) {
            lines.push(`.include "${file}"`);
        }
        lines.push('');
    }

    // Components. A model lookup lets subckt instances bind their nodes by pinId (the macromodel's
    // declared port order) instead of trusting the authored pin-array order.
    const modelMap = new Map<string, ModelDef>();
    for (const m of models) {
        if (!modelMap.has(m.name)) modelMap.set(m.name, m);
    }
    const componentLines: string[] = [];
    // Node map for B-source EXPRESSION references: a `v(<net>)` inside a behavioral expression must read the
    // ANALOG voltage. For a pure-digital net the sanitized name belongs to the XSPICE event node (no analog
    // element pins it — referencing it from a B-source leaves the node singular in the analog matrix and the
    // expression reads gmin-degraded garbage). planMixedSignal bridges every digital net to an analog "_p"
    // twin (probeNodeForNet) — redirect expression refs there, exactly like probes. No-op for analog nets.
    const exprNodeMap = new Map(nodeMap);
    for (const [netId, twin] of ms.probeNodeForNet) exprNodeMap.set(netId, twin);
    // Maps each component's schematic designator (lower-cased) to the SPICE instance name actually
    // emitted (which spiceInstanceName may have prefixed/sanitized). Reference sites that name a device
    // by its designator — current probes i(<dev>), a .dc sweep <source> — are remapped through this so
    // they point at the real emitted name. For a composite device (transformer) the first emitted
    // sub-element name is used.
    const designatorToInstance = new Map<string, string>();
    // Digital `a`-devices have NO branch-current vector in ngspice, so an `i(<digital dev>)` probe is
    // meaningless and would abort the entire wrdata line. Collect their designator + emitted instance name
    // so such probes can be dropped (and so a digital designator is never remapped into an i() rewrite).
    const digitalDeviceRefs = new Set<string>();
    for (const component of circuit.components) {
        // Fail loud on an unknown type — otherwise an un-emittable type (e.g. a caller that skipped
        // safeValidateCircuitJson and passed type:'opamp') would be SILENTLY dropped, yielding a
        // degraded netlist that "simulates" to wrong/flat results with no error.
        if (!VALID_COMPONENT_TYPES.has(component.type)) {
            // A thyristor/IGBT is reached as type:'subckt' with model:'SCRGEN'/'IGBTGEN' (the generic
            // models exist), not as a first-class type — point the caller there instead of a bare reject.
            const t = component.type.toLowerCase();
            const hint =
                t === 'scr' || t === 'thyristor'
                    ? ` Use type:'subckt' with model:'SCRGEN' (ports anode,gate,cathode) for a thyristor.`
                    : t === 'igbt'
                      ? ` Use type:'subckt' with model:'IGBTGEN' (ports c,g,e) for an IGBT.`
                      : '';
            throw new DeckRefusal(
                `Unknown component type '${component.type}' for ${component.designator || component.id}. ` +
                    `Valid types are COMPONENT_TYPES; validate with safeValidateCircuitJson before generating.${hint}`,
            );
        }
        // Digital components (gates/flip-flops) emit XSPICE 'a'-devices via the mixed-signal plan (which
        // resolves their nodes through the bridge overrides); everything else takes the analog path.
        const digital = isDigitalType(component.type);
        const spiceLine = digital
            ? emitDigitalComponent(component, nodeMap, ms)
            : componentToSpice(component, nodeMap, modelMap, exprNodeMap);
        const emitted = Array.isArray(spiceLine) ? spiceLine : spiceLine ? [spiceLine] : [];
        const emittedName = emitted[0]?.split(/\s+/)[0];
        if (emittedName && component.designator) {
            if (digital) {
                digitalDeviceRefs.add(component.designator.toLowerCase());
                digitalDeviceRefs.add(emittedName.toLowerCase());
            } else {
                // Only ANALOG devices are remapped for i()/.dc references; an a-device has no current to probe.
                designatorToInstance.set(component.designator.toLowerCase(), emittedName);
            }
        }
        componentLines.push(...emitted); // a composite device (e.g. transformer) emits several lines

        // A transformer's synthesized winding-midpoint nodes (_wp/_ws) are NOT net-derived, so the net
        // collision guard above never saw them. Register them (only when the transformer actually emitted)
        // so a net whose sanitized node case-insensitively equals one is caught LOUD here instead of being
        // SILENTLY merged by ngspice into the winding midpoint (e.g. transformer 'N1' → node 'N1_wp' vs a
        // net that sanitizes to 'n1_wp' — a wrong netlist).
        if (component.type === 'transformer' && emitted.length > 0 && component.designator) {
            const { pMid, sMid } = transformerMidNodes(component.designator);
            for (const mid of [pMid, sMid]) {
                const key = mid.toLowerCase();
                const prev = nodeOwner.get(key);
                if (prev !== undefined) {
                    throw new DeckRefusal(
                        `Node-name collision: transformer '${component.designator}' internal node '${mid}' clashes with net '${prev}' (ngspice node names are case-insensitive). Rename the net or the transformer.`,
                    );
                }
                nodeOwner.set(key, component.designator);
            }
        }
    }
    // Synthesized mixed-signal devices: analog<->digital bridges + the constant digital rail (empty for
    // analog-only). Appended so they go through the same duplicate-device-name guard below.
    componentLines.push(...ms.deviceLines);
    // No two emitted devices may share a name — ngspice would silently redefine the first. This catches
    // a composite device's derived sub-element names (e.g. transformer T1 -> LT1P/RT1P/KT1) colliding
    // with a user-authored component's designator. ngspice device names are CASE-INSENSITIVE, so the
    // check must be too — otherwise "d1" and "D1" (or a prefixed "Dz1" vs an authored "DZ1") slip past
    // here and abort the whole run later with ngspice's opaque "device already exists, bail out".
    const seenDevices = new Set<string>();
    for (const cl of componentLines) {
        const rawName = cl.split(/\s+/)[0] ?? '';
        const name = rawName.toLowerCase();
        if (seenDevices.has(name)) {
            throw new DeckRefusal(
                `Duplicate device name '${rawName}' in the netlist — a designator or transformer sub-element collides with another component (ngspice device names are case-insensitive).`,
            );
        }
        seenDevices.add(name);
    }
    lines.push('* Components');
    lines.push(...componentLines);
    lines.push('');

    // Analysis. A .dc sweep names its swept device by the schematic designator; remap it to the emitted
    // SPICE instance name (the device may have been prefixed, e.g. source "BAT1" -> "VBAT1"), else ngspice
    // fatally aborts with "<source> is not in the circuit".
    let effectiveAnalysis = analysis;
    if (analysis.type === 'dc' && analysis.source) {
        const mapped = designatorToInstance.get(analysis.source.toLowerCase());
        if (mapped) effectiveAnalysis = { ...analysis, source: mapped };
    }
    // Initial conditions (tran only): emit a `.ic v(<node>)=<v>` card per entry (net id → sanitized node).
    // CRUCIALLY we do NOT force `uic` — we pass the caller's `uic` flag through. The two idioms are opposite:
    //   • `.ic` WITHOUT uic ("Initial Transient Solution"): ngspice solves the DC op-point with these nodes
    //     pinned, then releases them — supplies stay energized. This is the robust way to KICK a symmetric
    //     self-starting oscillator (active devices + a supply rail) off its equilibrium.
    //   • `.ic` WITH uic: ngspice SKIPS the op-point and starts every unlisted node at 0 (including supply
    //     rails). Required for pure-reactive seeding (a charged cap / LC tank: cap=V, iL=0), but it ABORTS an
    //     active oscillator because the zeroed supply collapses the timestep.
    // Forcing uic here used to break the documented oscillator use case (supply x_vdd zeroed → "timestep too
    // small"). Callers that want reactive seeding set `uic: true` explicitly; the default (no uic) self-starts.
    if (analysis.type === 'tran' && analysis.initialConditions) {
        const icLines: string[] = [];
        for (const [netId, volts] of Object.entries(analysis.initialConditions)) {
            const node = nodeMap.get(netId);
            if (node && node !== '0') icLines.push(`.ic v(${node})=${volts}`);
        }
        if (icLines.length > 0) {
            lines.push('* Initial conditions');
            lines.push(...icLines);
            lines.push('');
        }
    }
    // Control block for output. Caller-supplied probes reference a device by its designator (i(<dev>)) or
    // a node by its net id/name (v(<net>)); remap both to the names actually emitted (the device may have
    // been prefixed, the node sanitized) so they resolve in ngspice instead of yielding "no such vector".
    // Default probes (already sanitized) and any already-correct reference pass through unchanged.
    // ONE authority, shared with the assertion evaluator — see netlist/probe-map.ts. It lives there
    // rather than here precisely so the evaluator cannot keep a second, subtly different copy: it did,
    // and every way that copy fell short (ground, digital twins, differential probes) reported a
    // correct design as unverifiable. The GENERATOR consuming it is what makes drift impossible —
    // a shared helper only the consumer uses is still two implementations waiting to disagree.
    const netRefToNode = buildNetRefToNode(circuit, nodeMap, ms);
    // Default = auto-probe every node's voltage. An explicit `probes` REPLACES that; `extraProbes` ADDS to
    // it (deduped) — the seam for branch-current criteria, which the voltage-only defaults never save.
    const baseProbes = options.probes || generateDefaultProbes(circuit, nodeMap, ms);
    const rawProbes =
        !options.probes && options.extraProbes?.length
            ? [...new Set([...baseProbes, ...options.extraProbes])]
            : baseProbes;
    let needSaveCurrents = false;
    const probes = [
        ...new Set(
            rawProbes
                .map((p) =>
                    rewriteProbeNodeRefs(rewriteProbeDeviceRefs(normalizeProbe(p), designatorToInstance), netRefToNode),
                )
                .filter((p) => p.trim().length > 0) // a probe that reduced to nothing (e.g. v(gnd)) is dropped
                .filter((p) => !isDigitalCurrentProbe(p, digitalDeviceRefs)) // i(<digital a-device>) has no current vector → drop (else it aborts the whole wrdata line)
                .map((p) => {
                    // Make analog current probes outputtable: keep native i() for V/L/E/H, rewrite R/C to @<dev>[i]
                    // (+ savecurrents) in op/dc/tran, drop everything else (diodes, multi-terminal devices, and R/C
                    // in AC where @<dev>[i] is unresolvable) — so no i() term can abort the shared wrdata line.
                    const { token, savecurrents } = rewriteCurrentProbeVector(p, seenDevices, analysis.type);
                    if (savecurrents) needSaveCurrents = true;
                    return token;
                })
                .filter((p) => p.trim().length > 0), // a current probe on an unsupported/multi-terminal device was dropped
        ),
    ];

    // If the caller EXPLICITLY asked for probes but every one was dropped (e.g. only i(D1)/i(Q1), or v(0)),
    // the deck would emit no `wrdata` line and ngspice would exit 0 with no output.csv — an opaque empty
    // result. Fail loud with the specific probes that aren't observable so the caller can pick a real one
    // (a diode/transistor terminal current is read via a series sense resistor; ground has no voltage vector).
    if (options.probes && options.probes.length > 0 && probes.length === 0) {
        throw new DeckRefusal(
            `None of the requested probes are observable in ngspice batch mode: ${options.probes.join(', ')}. ` +
                `A TRANSISTOR terminal current (i(Q…)/i(M…)) is ambiguous — a 3- or 4-terminal device has no ` +
                `single branch current, so probe a series resistor's current i(R…) instead. Diode currents ` +
                `(i(D…)) ARE available in op/dc/tran but not in ac. Ground v(0) has no vector — probe a ` +
                `non-ground node.`,
        );
    }

    // `.options` card: solver tuning from analysis.options (each token re-validated against an anchored
    // numeric pattern by solverOptionTokens — these strings land verbatim on a netlist line, so an
    // unvalidated value would be netlist injection; invalid ones are silently dropped in favor of ngspice
    // defaults) + `savecurrents` when an R/C current probe was rewritten to `@<dev>[i]` (it makes ngspice
    // store every device current — real matrix/IO overhead we don't want on the common voltage-only run).
    // solverOptionTokens is shared with applySolverOptions (solver-options.ts) so a worker-side remedy can
    // never emit a token the generator wouldn't.
    const optionTokens: string[] = solverOptionTokens(analysis.options);
    if (needSaveCurrents) optionTokens.push('savecurrents');
    if (optionTokens.length > 0) {
        lines.push('* Options');
        lines.push(`.options ${optionTokens.join(' ')}`);
        lines.push('');
    }

    // `.temp` card: ambient simulation temperature for a temperature-corner run (AMBIENT ONLY — ngspice
    // recomputes device-model temp physics; it does NOT model self-heating/Tj). Guarded to a finite number
    // because it lands verbatim on a netlist line (a non-numeric value would be netlist injection).
    if (options.temperatureC !== undefined && Number.isFinite(options.temperatureC)) {
        lines.push('* Temperature corner (ambient)');
        lines.push(`.temp ${options.temperatureC}`);
        lines.push('');
    }

    lines.push('* Analysis');
    // For `.noise`, the analysis card embeds the output PROBE, which must be node-remapped like a wrdata probe —
    // analysisToSpice has no circuit context, so rewrite it here and pass a cloned config. (The noise input
    // source must carry an AC magnitude for a meaningful result — that is the caller's responsibility.)
    if (effectiveAnalysis.type === 'noise' || effectiveAnalysis.type === 'sens') {
        // keepGroundFirstSingleEnded: a .noise/.sens output is a magnitude/PSD (sign irrelevant) and MUST
        // resolve to a real node, so a ground-first differential v(0,X) is kept as the sanitized single-ended
        // v(x_X) rather than dropped — otherwise `out` would be '' and the `|| raw` fallback below would emit
        // an unsanitized net id that ngspice can't resolve.
        const out = rewriteProbeNodeRefs(
            rewriteProbeDeviceRefs(effectiveAnalysis.output, designatorToInstance),
            netRefToNode,
            true,
        ).trim();
        lines.push(analysisToSpice({ ...effectiveAnalysis, output: out || effectiveAnalysis.output }));
    } else {
        lines.push(analysisToSpice(effectiveAnalysis));
    }

    // `.meas` measurement cards (extrema/timing/integral) — placed BEFORE .control. UNLIKE `.four`, these CARDS
    // survive the control block's `quit` (they run as part of `run`). Output lands in the listing (parsed by
    // parseMeasurements), not the wrdata CSV — and .meas rides on the existing run, so output.csv is unaffected.
    // Probes are node-remapped EXACTLY like wrdata probes; the card is built from VALIDATED fields (no raw
    // statement passthrough). REPORT-ONLY: never gates the verdict.
    if (effectiveAnalysis.type === 'tran' && effectiveAnalysis.measurements) {
        for (const ms of effectiveAnalysis.measurements) {
            const probe = rewriteProbeNodeRefs(
                rewriteProbeDeviceRefs(ms.probe, designatorToInstance),
                netRefToNode,
            ).trim();
            if (!probe) continue;
            if (ms.type === 'when') {
                if (typeof ms.value !== 'number' || !Number.isFinite(ms.value)) continue;
                const edge = (ms.edge ?? 'cross').toUpperCase();
                lines.push(`.meas tran ${ms.name} WHEN ${probe}=${ms.value} ${edge}=1`);
            } else {
                lines.push(`.meas tran ${ms.name} ${ms.type.toUpperCase()} ${probe}`);
            }
        }
    }
    lines.push('');

    // Fourier is emitted as the `fourier` COMMAND inside the .control block (below), NOT as a top-level `.four`
    // card: the control block ends with `quit`, which exits ngspice BEFORE it would process a `.four` card's
    // end-of-run output (so the card prints nothing). The `fourier` command runs inside the block, before quit.
    // Probes are node-remapped EXACTLY like wrdata probes, restricted to voltage probes (fourier on a rewritten
    // `@dev[i]` current vector is unreliable), and de-duped. The fundamental is re-validated against a SPICE-value
    // pattern (it lands raw on a command line). REPORT-ONLY: parsed from the listing, never gates the verdict.
    const fourierCmds: string[] = [];
    if (
        effectiveAnalysis.type === 'tran' &&
        effectiveAnalysis.fourier &&
        /^[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?\s*[a-zA-Z]*$/.test(effectiveAnalysis.fourier.fundamentalFreq)
    ) {
        const freq = effectiveAnalysis.fourier.fundamentalFreq;
        const fProbes = [
            ...new Set(
                effectiveAnalysis.fourier.probes
                    .map((p) =>
                        rewriteProbeNodeRefs(rewriteProbeDeviceRefs(p, designatorToInstance), netRefToNode).trim(),
                    )
                    .filter((p) => /^v\(/i.test(p)),
            ),
        ];
        for (const p of fProbes) fourierCmds.push(`  fourier ${freq} ${p}`);
    }

    // `.tf` DC small-signal transfer function — emitted as the `tf` CONTROL COMMAND + an EXPLICIT print of its
    // three result vectors (the auto-echo is unreliable after `run`). Rides on the `op` run (which already writes
    // the wrdata series), so NO runner change. Output probe is node-remapped like a wrdata probe; the source is a
    // validated designator. The print's vector names embed the probe (`output_impedance_at_<probe>`) and the
    // lowercased source (`<src>#input_impedance`), matching how ngspice names them. REPORT-ONLY.
    const tfCmds: string[] = [];
    if (effectiveAnalysis.type === 'op' && effectiveAnalysis.tf) {
        const out = rewriteProbeNodeRefs(
            rewriteProbeDeviceRefs(effectiveAnalysis.tf.output, designatorToInstance),
            netRefToNode,
        ).trim();
        const src = effectiveAnalysis.tf.inputSource;
        // Only emit `tf` when the input source ACTUALLY EXISTS in the circuit — a `tf` against a missing source
        // makes ngspice error and fails the whole run, even though the op-point + series are valid. Skipping it
        // keeps the run clean (transferFunction is simply absent). REPORT-ONLY: never worth failing the sim.
        const srcExists = circuit.components.some(
            (c) => c.designator && c.designator.toUpperCase() === src.toUpperCase(),
        );
        if (out && srcExists && /^[A-Za-z][A-Za-z0-9]*[0-9]+$/.test(src)) {
            tfCmds.push(`  tf ${out} ${src}`);
            tfCmds.push(`  print transfer_function output_impedance_at_${out} ${src.toLowerCase()}#input_impedance`);
        }
    }

    lines.push('* Control block');
    lines.push('.control');
    lines.push('  set filetype=ascii');
    lines.push('  run');

    if (effectiveAnalysis.type === 'noise') {
        // Noise output is NOT node voltages: write the per-frequency SPECTRUM (in the noise1 plot) to the CSV,
        // then PRINT the integrated TOTALS (in the noise2 plot). The default v(probe) wrdata would FAIL here
        // ("no such vector") because the current plot holds no node-voltage vectors.
        lines.push('  setplot noise1');
        lines.push('  wrdata output.csv onoise_spectrum inoise_spectrum');
        lines.push('  setplot noise2');
        lines.push('  print onoise_total inoise_total');
    } else if (effectiveAnalysis.type === 'sens') {
        // Sensitivity has no series to wrdata — the `.sens` run populates a scalar table that only reaches the
        // listing via an explicit `print all`. (The runner treats sens as a no-series analysis: no output.csv.)
        lines.push('  print all');
    } else {
        if (probes.length > 0) {
            const probeList = probes.join(' ');
            lines.push(`  wrdata output.csv ${probeList}`);
        }
        // Fourier/tf AFTER run (the vectors must exist) and BEFORE quit (else they never execute).
        for (const fc of fourierCmds) lines.push(fc);
        for (const tc of tfCmds) lines.push(tc);
    }

    lines.push('  quit');
    lines.push('.endc');
    lines.push('');
    lines.push('.end');

    return lines.join('\n');
}

/**
 * SPICE identifies a device by the FIRST letter of its name (R=resistor, D=diode, Q=BJT, …). The
 * schematic designator usually already starts with that letter, but it need not: a Zener's natural
 * designator is "Z1" while its SPICE device letter is "D", and diodes are often "CR1"/"LED1". Emitting
 * the designator verbatim would then yield an invalid or misparsed element ("Z1" is not a SPICE device;
 * "CR1" would parse as a capacitor). Prepend the device's SPICE prefix whenever the designator doesn't
 * already start with it (case-insensitive), so the emitted element type is always correct regardless of
 * the schematic naming convention.
 *
 * The designator is first stripped to a single SPICE-safe token: SPICE tokenizes a card on whitespace,
 * so a designator with an internal space (e.g. "C 1") would shift the node columns and wire the device
 * to a phantom node — strip whitespace and other token-breaking characters first (mirrors node-name
 * sanitization), so the emitted element is always well-formed.
 */
function spiceInstanceName(designator: string, prefix: string): string {
    const safe = designator.replace(/[^A-Za-z0-9_]/g, '');
    return safe.toLowerCase().startsWith(prefix.toLowerCase()) ? safe : `${prefix}${safe}`;
}

/**
 * Rewrite device-by-name current references — i(<designator>) — in a probe so they point at the SPICE
 * instance name actually emitted (which spiceInstanceName may have prefixed/sanitized, e.g. "FB1"→"LFB1",
 * "Z1"→"DZ1"). `map` is keyed by the lower-cased schematic designator. v(...) node references are left
 * untouched (handled by rewriteProbeNodeRefs), as is any i(...) arg that isn't a known device.
 */
function rewriteProbeDeviceRefs(probe: string, map: Map<string, string>): string {
    return probe.replace(/\bi\s*\(\s*([^)]+?)\s*\)/gi, (whole, name: string) => {
        const mapped = map.get(name.trim().toLowerCase());
        return mapped ? `i(${mapped})` : whole;
    });
}

/**
 * True if `probe` is a current probe `i(<x>)` whose target is a digital component (its designator or its
 * emitted XSPICE `a`-device name). Such a probe must be DROPPED: an event-driven `a`-device has no branch-
 * current vector, so `i(...)` on it is unresolvable and aborts the ENTIRE wrdata line (losing every other
 * probe on it). Matches a probe consisting solely of one `i(name)` term.
 */
function isDigitalCurrentProbe(probe: string, digitalRefs: Set<string>): boolean {
    const m = probe.trim().match(/^i\s*\(\s*([^),]+?)\s*\)$/i);
    const name = m?.[1];
    return name !== undefined && digitalRefs.has(name.trim().toLowerCase());
}

/** SPICE device letters with a NATIVE branch-current vector in batch mode — `i(<dev>)` works as-is. */
const NATIVE_CURRENT_DEVICES = new Set(['V', 'L', 'E', 'H']); // voltage sources, inductors, vcvs, ccvs
/**
 * Two-terminal elements whose current is reliably reachable via `.options savecurrents` + the `@<dev>[i]`
 * vector form. Verified on ngspice-41: `@r1[i]`/`@c1[i]` resolve in op, dc and tran, case-insensitively,
 * but NOT in ac (no small-signal device-current vector), where the bad token would abort the shared
 * wrdata line.
 */
const SAVECURRENTS_DEVICES = new Set(['R', 'C']); // resistor, capacitor

/**
 * Devices whose current lives under a DIFFERENT `@<dev>[…]` parameter than plain `i`.
 *
 * A diode's is `id`, and it needs no `savecurrents`. This used to be excluded outright, on the recorded
 * grounds that "it only resolves in tran (it errors in op)" — RE-MEASURED on ngspice-41 and that is not
 * true: `.op` ✓, `.dc` ✓, `.tran` ✓, `.ac` ✗ (the same one mode R/C also fails in). The exclusion cost
 * every diode current in the product, which on a real board is most of the interesting branches — a
 * rectifier, an LED, a clamp, a freewheel path.
 *
 * NOT extended to BJT/MOSFET here: those have three or four terminal currents (`ic`/`ib`/`ie`,
 * `id`/`is`/`ig`/`ib`) and `i(Q1)` does not say which one is meant. Guessing a terminal would be worse
 * than refusing, so they keep refusing until the probe language can name a terminal.
 */
const PARAM_CURRENT_DEVICES: Record<string, string> = { D: 'id' }; // diode / zener / LED all emit a D card

/**
 * Make a current probe `i(<inst>)` actually outputtable by ngspice `-b`, keyed on the emitted device letter:
 *   • V/L/E/H — native branch current → keep `i(<inst>)` (no `.options` needed).
 *   • R/C     — NO native i() in batch mode; rewrite to the device-current vector `@<inst>[i]` and signal
 *     the caller to emit `.options savecurrents`. (Verified: `@r1[i]`/`@c1[i]` return the current.)
 *   • anything else (diode/zener `D`, multi-terminal Q/M/J, sources, switches, behavioral, bridges) has no
 *     single, mode-portable current vector, and an UNKNOWN device name would error too → DROP (return ''),
 *     exactly like the digital guard, so the bad term can't abort the whole `wrdata` line and kill co-probes.
 * Non-current probes (`v(...)`) and compound expressions pass through untouched. `emitted` is the set of
 * real (lower-cased) device names actually in the deck. Returns `{ token, savecurrents }`.
 */
function rewriteCurrentProbeVector(
    probe: string,
    emitted: Set<string>,
    analysisType: string,
): { token: string; savecurrents: boolean } {
    const m = probe.trim().match(/^i\s*\(\s*([^),]+?)\s*\)$/i);
    if (!m || m[1] === undefined) return { token: probe, savecurrents: false }; // not a sole current probe
    const name = m[1].trim();
    if (!emitted.has(name.toLowerCase())) return { token: '', savecurrents: false }; // unknown device → would abort; drop
    const letter = name[0]?.toUpperCase() ?? '';
    if (NATIVE_CURRENT_DEVICES.has(letter)) return { token: `i(${name})`, savecurrents: false };
    if (SAVECURRENTS_DEVICES.has(letter)) {
        // The `@<dev>[i]` device-current vector resolves in op/dc/tran but NOT in AC (ngspice has no
        // small-signal device-current vector for R/C — `no such vector @R1[i]`), and the bad token would
        // abort the whole shared wrdata line, losing every co-probe. So DROP R/C current probes in AC.
        if (analysisType === 'ac') return { token: '', savecurrents: false };
        return { token: `@${name}[i]`, savecurrents: true };
    }
    const param = PARAM_CURRENT_DEVICES[letter];
    if (param) {
        // Same one exclusion as R/C: no small-signal device-current vector in ac.
        if (analysisType === 'ac') return { token: '', savecurrents: false };
        // savecurrents is REQUIRED, exactly as it is for R/C. Measured on ngspice-41: without it,
        // `@d1[id]` writes 108 rows carrying ONE distinct value — a frozen constant, with no warning and
        // a valid-looking CSV. With it, 67 distinct values that agree with the series resistor's own
        // current to 3.5e-5.
        //
        // This shipped wrong for a day because the deck that verified it also probed a resistor, which
        // sets the flag for its own reasons — so the diode's number was correct by coincidence. A
        // cross-check that only holds when an unrelated probe happens to be present is not a cross-check.
        return { token: `@${name}[${param}]`, savecurrents: true };
    }
    return { token: '', savecurrents: false }; // multi-terminal / exotic → drop (can't probe a single current)
}

/**
 * A transformer's two synthesized internal winding-midpoint nodes (the L→R series junctions). Deterministic
 * from the designator so the emitter and the case-insensitive node-collision guard agree on the exact names.
 */
export function transformerMidNodes(designator: string): { pMid: string; sMid: string } {
    return { pMid: `${designator}_wp`, sMid: `${designator}_ws` };
}

/**
 * Convert a component to a SPICE line
 */
function componentToSpice(
    component: Component,
    nodeMap: Map<string, string>,
    modelMap?: Map<string, ModelDef>,
    // For B-source expressions only: nodeMap overlaid with the analog "_p" twins of digital nets, so a
    // v(<digital net>) reference reads the bridged analog copy instead of the raw XSPICE event node.
    exprNodeMap?: Map<string, string>,
): string | string[] | null {
    const { type, designator, value, model, pins } = component;

    // Not emitted to SPICE: `ground` is node 0, `generic` is a catalog-only part with no simulatable
    // model. Both are skipped (not an error) so a circuit can carry real parts that aren't simulatable.
    if (type === 'ground' || !isSimulatable(component)) {
        return null;
    }

    // Transformer = two magnetically-coupled inductor windings. It is a COMPOSITE: one component expands
    // to two L lines (primary/secondary, across p+,p- and s+,s-) plus a K coupling statement. Nodes are
    // bound by pinId (canonical p+,p-,s+,s-) so winding polarity/dot-sense is correct regardless of the
    // authored pin order. Sub-element names derive from the designator (T1 -> LT1P, LT1S, KT1).
    if (type === 'transformer') {
        const tp = parseTransformerParams(component.properties);
        if (!tp) return null; // ERC flags missing/invalid winding inductances
        const [pp, pn, sp, sn] = orderedNodes(component, nodeMap);
        const lPri = `L${designator}P`;
        const lSec = `L${designator}S`;
        // A series winding resistance (DCR) gives each winding a finite DC path. Without it an ideal source
        // driving an ideal inductor makes the MNA matrix structurally singular (ngspice limps through
        // gmin-stepping or fails to converge). The default 1 mΩ is negligible at signal levels but removes
        // the singularity; note that on a high-L / low-f transformer the L/R magnetizing time constant is then
        // huge, so a turn-on DC flux barely decays in-window — set the `windingResistance` property to a
        // realistic ohmic value for faithful settling. Internal nodes carry the L->R series connection.
        const RSER = tp.dcr ?? '1m';
        const { pMid, sMid } = transformerMidNodes(designator);
        const out = [
            `${lPri} ${pp} ${pMid} ${tp.lp}`,
            `R${designator}P ${pMid} ${pn} ${RSER}`,
            `${lSec} ${sp} ${sMid} ${tp.ls}`,
            `R${designator}S ${sMid} ${sn} ${RSER}`,
            `K${designator} ${lPri} ${lSec} ${tp.k}`,
        ];
        // A galvanically-isolated winding (NEITHER terminal at ground) has no DC reference, so the MNA
        // matrix is singular (the whole point of many transformers is isolation, so this is common).
        // Tie each isolated winding to ground through a very large bleeder (negligible load) to anchor it.
        const BLEED = '1G';
        if (pp !== '0' && pn !== '0') out.push(`R${designator}PG ${pn} 0 ${BLEED}`);
        if (sp !== '0' && sn !== '0') out.push(`R${designator}SG ${sn} 0 ${BLEED}`);
        return out;
    }

    // Lossless transmission line: `T<inst> a+ a- b+ b- Z0=.. TD=..`. Nodes bound canonically by pinId so
    // the two ports are correct regardless of authored order; the instance name must start with 'T', so
    // prefix one when the (schematic) designator doesn't (e.g. U1 -> TU1).
    if (type === 'tline') {
        const tl = parseTransmissionLineParams(component.properties);
        if (!tl) return null; // ERC flags missing/invalid Z0/TD(or F)
        const inst = spiceInstanceName(designator, 'T');
        const spec = tl.td ? `TD=${tl.td}` : `F=${tl.f}${tl.nl ? ` NL=${tl.nl}` : ''}`;
        return `${inst} ${orderedNodes(component, nodeMap).join(' ')} Z0=${tl.z0} ${spec}`;
    }

    // Arbitrary behavioral source: `B<inst> + - V=<expr>` (or I=<expr>). The expression's v(...) node
    // references use the circuit's net IDs and are rewritten to the sanitized SPICE node names; i(...)
    // (a device-by-name reference) is left untouched. Instance name is B-prefixed if needed.
    if (type === 'bsource') {
        // Require a single-line V=/I= expression with a NON-EMPTY right-hand side (a bare "V=" emits an
        // empty B-card that fatally aborts ngspice). A newline could inject a netlist line. Skip here +
        // flag in ERC otherwise.
        if (!value || /[\r\n]/.test(value) || !/^\s*[VI]\s*=\s*\S/i.test(value)) return null;
        const inst = spiceInstanceName(designator, 'B');
        const [np, nn] = orderedNodes(component, nodeMap);
        // Expression refs use exprNodeMap (digital nets → their analog twins); pins stay on nodeMap.
        return `${inst} ${np} ${nn} ${rewriteExprNodeRefs(value, exprNodeMap ?? nodeMap)}`;
    }

    // Any type without a SPICE element prefix is non-emittable — skip it gracefully rather than throw,
    // mirroring the parser/ERC which tolerate unknown types (keeps the netlist resilient).
    const prefix = SPICE_PREFIXES[type];
    if (!prefix) {
        return null;
    }

    // Get node names for pins
    const nodes = pins.map((pin) => {
        const node = nodeMap.get(pin.netId);
        if (!node) {
            throw new DeckRefusal(`Net not found: ${pin.netId} for component ${designator}`);
        }
        return node;
    });

    // Generate SPICE line based on component type
    switch (type) {
        case 'resistor':
        case 'capacitor':
        case 'inductor': {
            // A passive value is a SINGLE magnitude token ('1k', '4.7uF', '100n') — internal whitespace is
            // never meaningful, but SPICE tokenizes the card on spaces, so a stray space ('1 k') would shift
            // 'k' into an extra column and ngspice misparses it as a model/param (broken deck, no output).
            // Collapse it so a human/AI value like '1 k' just works. (Sources keep their spaces — 'DC 5 AC 1'
            // is a legitimate multi-token value — so they are intentionally NOT normalized here.)
            const v = (value ?? '').replace(/\s+/g, '') || '0';
            return `${spiceInstanceName(designator, prefix)} ${nodes.join(' ')} ${v}`;
        }

        // A source is POLARIZED: SPICE reads `V<name> n+ n- <value>`, and reversing n+/n- sign-flips the
        // supply/stimulus (the deck still simulates, but the verdict is computed against an inverted source).
        // Bind by pinId in canonical (+,-) order — like every other polarized device (diode/bjt/mosfet) —
        // NOT the authored pin-array order, so a source authored [-,+] is not silently reverse-connected.
        case 'voltage_source':
        case 'current_source':
            return `${spiceInstanceName(designator, prefix)} ${orderedNodes(component, nodeMap).join(' ')} ${value || 'DC 0'}`;

        // Linear voltage-controlled sources. Nodes are bound by pinId in canonical order
        // (out+ out- ctrl+ ctrl-) so authored order is irrelevant; `value` is the gain (E, V/V) or the
        // transconductance (G, A/V). Without it the line is incomplete, so skip (ERC flags MISSING_VALUE).
        case 'vcvs':
        case 'vccs': {
            // The gain MUST be a single real number; a stray "DC "/keyword/expression would make ngspice
            // reinterpret the line as a behavioral source and fatally abort the run. Normalize, else skip.
            const gain = value ? normalizeControlledSourceGain(value) : null;
            if (!gain) return null;
            return `${spiceInstanceName(designator, prefix)} ${orderedNodes(component, nodeMap).join(' ')} ${gain}`;
        }

        // A diode is POLARIZED: it must emit anode then cathode. Bind by pinId (canonical order) like the
        // zener/bjt/mosfet cases — NOT the authored pin-array order — so a diode whose pins were listed
        // [cathode, anode] (pinIds correct) is not silently reverse-mounted (which rectifies the wrong half).
        case 'diode':
            return `${spiceInstanceName(designator, prefix)} ${orderedNodes(component, nodeMap).join(' ')} ${model || 'DDEFAULT'}`;

        // A Zener is the SPICE diode device with a breakdown model generated from `value` (the Zener
        // voltage). Nodes are emitted in canonical anode,cathode order (by pinId) so polarity — which
        // is what makes a Zener clamp/regulate — is correct regardless of the authored pin order.
        case 'zener': {
            if (!value) return null;
            const zm = buildZenerModel(value);
            if (!zm) return null;
            // A Zener's SPICE device letter is 'D' even though its designator is naturally "Z…"/"ZD…";
            // spiceInstanceName prepends the 'D' so the element is a real diode, not an invalid 'Z' device.
            return `${spiceInstanceName(designator, prefix)} ${orderedNodes(component, nodeMap).join(' ')} ${zm.name}`;
        }

        // Active devices are model-based. Nodes are emitted in the canonical pin order (bjt c,b,e /
        // mosfet d,g,s,b / jfet d,g,s) resolved by pinId, NOT by the authored array order. Without a
        // model name the device can't be a valid SPICE line, so skip it (ERC flags MODEL_REQUIRED).
        case 'bjt':
        case 'mosfet':
        case 'jfet':
        case 'switch': {
            if (!model) return null;
            return `${spiceInstanceName(designator, prefix)} ${orderedNodes(component, nodeMap).join(' ')} ${model}`;
        }

        // A subcircuit instance (e.g. an op-amp). Variable-arity: nodes are emitted in the AUTHORED pin
        // order, which MUST match the referenced `.subckt` port order (the generator cannot reorder
        // because the port names are macromodel-specific). The SPICE instance line must start with 'X',
        // so one is prefixed when the (schematic) designator doesn't already — e.g. U1 -> XU1.
        case 'subckt': {
            if (!model) return null;
            const inst = spiceInstanceName(designator, 'X');
            const def = modelMap?.get(model);
            // Macromodel with DECLARED ports: bind by pinId (authored order irrelevant); nodesForPinOrder
            // throws on a missing/extra named port.
            if (def?.ports && def.ports.length > 0) {
                return `${inst} ${nodesForPinOrder(component, nodeMap, def.ports).join(' ')} ${model}`;
            }
            // User-defined subckt with only a body: we must bind in authored order (no named ports to reorder
            // by), so validate the authored pin COUNT against the `.subckt` header's port count. A mismatch
            // would otherwise mis-wire SILENTLY — an unmapped port binds to global node 0 (wrong answer), or
            // a surplus node is absorbed — with ngspice exiting 0 and no diagnostic anywhere.
            if (def?.body) {
                const header = def.body.match(/^\s*\.subckt\s+\S+\s+(.+)$/im);
                if (header?.[1]) {
                    const portCount = header[1]
                        .trim()
                        .split(/\s+/)
                        .filter(
                            (tok) => tok.length > 0 && !tok.includes('=') && tok.toLowerCase() !== 'params:',
                        ).length;
                    if (portCount > 0 && portCount !== nodes.length) {
                        throw new DeckRefusal(
                            `Subckt '${model}' (${inst}) is wired with ${nodes.length} pin(s) but its .subckt body declares ${portCount} port(s) — ` +
                                `list exactly those ports, in the .subckt header order.`,
                        );
                    }
                }
            }
            return `${inst} ${nodes.join(' ')} ${model}`;
        }

        default:
            // Forward-compatible: a known-but-non-emittable type is skipped, not fatal.
            return null;
    }
}

/**
 * Resolve a fixed-arity component's nodes in the canonical COMPONENT_PINS order (by pinId), so a BJT
 * always emits `c b e` and a MOSFET `d g s b` regardless of the order pins were authored in.
 */
function orderedNodes(component: Component, nodeMap: Map<string, string>): string[] {
    return nodesForPinOrder(component, nodeMap, COMPONENT_PINS[component.type]);
}

/**
 * Resolve a component's nodes in an explicit pinId order (used for fixed-arity types via COMPONENT_PINS,
 * and for subckt instances via the macromodel's declared port order). Throws if a required pin is absent.
 */
function nodesForPinOrder(component: Component, nodeMap: Map<string, string>, pinIds: string[]): string[] {
    return pinIds.map((pinId) => {
        const pin = component.pins.find((p) => p.pinId === pinId);
        if (!pin) {
            throw new DeckRefusal(`Component ${component.designator} (${component.type}) is missing pin '${pinId}'`);
        }
        const node = nodeMap.get(pin.netId);
        if (!node) {
            throw new DeckRefusal(`Net not found: ${pin.netId} for component ${component.designator}`);
        }
        return node;
    });
}

/**
 * Rewrite the `v(...)` node references inside a behavioral-source (B) expression from the circuit's net
 * IDs to the sanitized SPICE node names (the rest of the netlist uses sanitized names, so an un-rewritten
 * `v(in)` would reference a non-existent node). `i(...)` references a DEVICE by name (not a net), so it is
 * left untouched; unknown/literal args (numbers, '0') pass through.
 */
function rewriteExprNodeRefs(expr: string, nodeMap: Map<string, string>): string {
    // ngspice node names are case-insensitive, so resolve the expression's net id case-insensitively
    // (the AI may write v(IN) for net "in"); otherwise the un-rewritten ref would be a phantom node.
    const lc = new Map<string, string>();
    for (const [netId, node] of nodeMap) lc.set(netId.toLowerCase(), node);
    return expr.replace(/\bv\s*\(\s*([^)]*)\)/gi, (_m, args: string) => {
        const mapped = args
            .split(',')
            .map((a) => {
                const id = a.trim();
                return lc.get(id.toLowerCase()) ?? id; // unknown/literal args (numbers, '0') pass through
            })
            .join(',');
        return `V(${mapped})`;
    });
}

/**
 * Generate default probes (all node voltages). For a pure-digital net, the raw event node is unreliable
 * through `wrdata`, so the mixed-signal plan bridged it to an analog node — probe THAT instead.
 */
/**
 * Cap on AUTO-generated voltage probes. A pathologically large circuit would otherwise emit a `wrdata`
 * line with hundreds of columns — a wide CSV the worker then parses into one in-memory series per column.
 * Plotting more than this many nodes is not a real use case here, and any probe a caller actually NEEDS
 * (e.g. a verification criterion) is supplied explicitly via `options.probes`/`extraProbes`, which are NOT
 * subject to this cap. Keeps the default voltage sweep bounded without affecting normal designs (<<64 nodes).
 */
const MAX_DEFAULT_PROBES = 64;

function generateDefaultProbes(circuit: CircuitJson, nodeMap: Map<string, string>, ms?: MixedSignalPlan): string[] {
    const probes: string[] = [];

    for (const net of circuit.nets) {
        if (net.isGround) continue;
        const probeNode = ms?.probeNodeForNet.get(net.id) ?? nodeMap.get(net.id);
        if (probeNode) {
            probes.push(`v(${probeNode})`);
        }
    }

    // Bound the default sweep width on huge circuits (see MAX_DEFAULT_PROBES). Explicit/extra probes are
    // added by the caller and bypass this cap, so verification is never starved.
    return probes.length > MAX_DEFAULT_PROBES ? probes.slice(0, MAX_DEFAULT_PROBES) : probes;
}

/**
 * Get all unique node names from a circuit
 */
export function getNodeNames(circuit: CircuitJson): string[] {
    const nodeMap = buildNodeMap(circuit.nets);
    return Array.from(nodeMap.values());
}

/**
 * Validate that a netlist is syntactically correct (basic check)
 */
export function validateNetlist(netlist: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const lines = netlist.split('\n');

    let hasEnd = false;
    let hasAnalysis = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]?.trim() || '';

        // Skip comments and empty lines
        if (line.startsWith('*') || line === '') {
            continue;
        }

        // Check for .end
        if (line.toLowerCase() === '.end') {
            hasEnd = true;
        }

        // Check for analysis
        if (
            line.toLowerCase().startsWith('.tran') ||
            line.toLowerCase().startsWith('.ac') ||
            line.toLowerCase().startsWith('.dc') ||
            line.toLowerCase().startsWith('.op')
        ) {
            hasAnalysis = true;
        }
    }

    if (!hasEnd) {
        errors.push('Netlist missing .end statement');
    }

    if (!hasAnalysis) {
        errors.push('Netlist missing analysis command (.tran, .ac, .dc, or .op)');
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}
