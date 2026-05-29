/**
 * Simulation result types
 */

/**
 * Complete simulation result structure
 */
export interface SimulationResult {
    meta: ResultMeta;
    series: DataSeries[];
}

/**
 * Result metadata
 */
export interface ResultMeta {
    analysisType: string;
    xLabel: string;
    xUnit?: string;
    pointsCount: number;
    simulationTime?: number; // Runtime in milliseconds
}

/**
 * Data series for a single signal
 */
export interface DataSeries {
    name: string;
    unit?: string;
    points: DataPoint[];
}

/**
 * Single data point
 */
export interface DataPoint {
    x: number;
    y: number;
}

/**
 * Probe specification for output
 */
export interface Probe {
    type: 'voltage' | 'current';
    signal: string; // e.g., "v(n1)", "i(R1)"
    label?: string;
}

/**
 * Parse a probe string to determine type and signal
 */
export function parseProbe(probe: string): Probe {
    const voltageMatch = probe.match(/^v\(([^)]+)\)$/i);
    if (voltageMatch) {
        return {
            type: 'voltage',
            signal: probe.toLowerCase(),
            label: voltageMatch[1],
        };
    }

    const currentMatch = probe.match(/^i\(([^)]+)\)$/i);
    if (currentMatch) {
        return {
            type: 'current',
            signal: probe.toLowerCase(),
            label: currentMatch[1],
        };
    }

    // Default to voltage if no prefix
    return {
        type: 'voltage',
        signal: `v(${probe})`.toLowerCase(),
        label: probe,
    };
}

/**
 * Generate probe signals from circuit for default output
 */
export function generateDefaultProbes(nodeNames: string[]): string[] {
    return nodeNames
        .filter((name) => name !== '0') // Exclude ground
        .map((name) => `v(${name})`);
}

/**
 * Metrics from simulation run
 */
export interface SimulationMetrics {
    runtimeMs: number;
    peakMemBytes?: number;
    pointsCount: number;
    dataSize?: number;
}