/**
 * SPICE Netlist Parser
 * Parses SPICE netlists back to CircuitJson (for import functionality)
 */
import type { CircuitJson, Component, Net, ComponentType } from '../types/circuit';
import type { AnalysisConfig, TranAnalysis, AcAnalysis, DcAnalysis, OpAnalysis } from '../types/analysis';

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
    D: 'diode',
    Q: 'bjt',
    M: 'mosfet',
};

/**
 * Parse a SPICE netlist to CircuitJson
 */
export function parseNetlist(netlist: string): NetlistParseResult {
    const lines = netlist.split('\n');
    const components: Component[] = [];
    const netSet = new Set<string>();
    const errors: string[] = [];
    const warnings: string[] = [];
    let title: string | undefined;
    let analysis: AnalysisConfig | undefined;

    // First line is usually the title
    if (lines.length > 0 && !lines[0]?.startsWith('.') && !lines[0]?.startsWith('*')) {
        title = lines[0]?.trim();
    }

    let componentCounter: Record<string, number> = {};

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]?.trim() || '';

        // Skip empty lines and comments
        if (line === '' || line.startsWith('*')) {
            continue;
        }

        // Parse directives
        if (line.startsWith('.')) {
            const parsedAnalysis = parseDirective(line);
            if (parsedAnalysis) {
                analysis = parsedAnalysis;
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
            warnings.push(`Line ${i + 1}: Could not parse: ${line}`);
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

    // Add ground component if there's a ground net
    const groundNet = nets.find((n) => n.isGround);
    if (groundNet) {
        components.push({
            id: 'gnd1',
            type: 'ground',
            designator: 'GND',
            pins: [{ pinId: '1', netId: groundNet.id }],
        });
    }

    return {
        circuit: {
            version: '1.0',
            components,
            nets,
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

        // Look for wrdata command
        if (trimmed.startsWith('wrdata')) {
            const parts = trimmed.split(/\s+/).slice(2); // Skip 'wrdata' and filename
            probes.push(...parts.filter((p) => p.startsWith('v(') || p.startsWith('i(')));
        }

        // Look for print command
        if (trimmed.startsWith('print') || trimmed.startsWith('.print')) {
            const parts = trimmed.split(/\s+/).slice(1);
            probes.push(...parts.filter((p) => p.startsWith('v(') || p.startsWith('i(')));
        }
    }

    return [...new Set(probes)]; // Remove duplicates
}