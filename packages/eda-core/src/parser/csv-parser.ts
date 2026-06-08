/**
 * CSV Parser for ngspice wrdata output
 * Parses simulation output into structured JSON format
 */
import type { SimulationResult, DataSeries, DataPoint, ResultMeta } from '../types/simulation';

/**
 * Parse ngspice wrdata CSV output to SimulationResult
 * 
 * wrdata format:
 * - Whitespace-separated values
 * - First column is X axis (time, frequency, voltage depending on analysis)
 * - Subsequent columns are Y values for each probe
 */
export function parseCsv(
    csvContent: string,
    probeNames: string[],
    analysisType: string = 'tran',
): SimulationResult {
    const lines = csvContent.trim().split('\n');

    if (lines.length === 0) {
        return createEmptyResult(analysisType);
    }

    // Initialize series for each probe
    const series: DataSeries[] = probeNames.map((name) => ({
        name,
        points: [],
    }));

    // Parse each line.
    // ngspice `wrdata` (ascii) repeats the scale (x) column BEFORE each vector, so a row
    // for N probes is laid out as: x y1 x y2 x y3 ...  (2 columns per probe). We detect
    // that interleaved layout by width and fall back to a single leading x column
    // (x y1 y2 y3 ...) for other producers.
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('*')) {
            continue; // Skip empty lines and comments
        }

        const values = trimmed.split(/\s+/).map(parseFloat);

        if (values.length < 2) {
            continue; // Need at least X and one Y value
        }

        // AC `wrdata` writes each COMPLEX vector as (freq, real, imag) — 3 columns per probe — so the row is
        // freq re0 im0 freq re1 im1 …  We collapse the complex value to its MAGNITUDE sqrt(re^2+im^2) (the
        // frequency-response amplitude). Without this the generic (x,y)-pair layout below mis-aligns AC output.
        const acComplex = analysisType === 'ac' && values.length >= 3 * probeNames.length;
        const interleaved = values.length >= 2 * probeNames.length;

        for (let i = 0; i < probeNames.length; i++) {
            let x: number | undefined;
            let y: number | undefined;
            if (acComplex) {
                x = values[3 * i];
                const re = values[3 * i + 1];
                const im = values[3 * i + 2];
                y = re !== undefined && im !== undefined ? Math.hypot(re, im) : undefined;
            } else if (interleaved) {
                x = values[2 * i];
                y = values[2 * i + 1];
            } else {
                x = values[0];
                y = values[i + 1];
            }
            if (x !== undefined && y !== undefined && !isNaN(x) && !isNaN(y)) {
                series[i]?.points.push({ x, y });
            }
        }
    }

    // Build metadata
    const meta = buildMeta(analysisType, series);

    return { meta, series };
}

/**
 * Build result metadata
 */
function buildMeta(analysisType: string, series: DataSeries[]): ResultMeta {
    const pointsCount = series[0]?.points.length || 0;

    let xLabel = 'time';
    let xUnit: string | undefined = 's';

    switch (analysisType) {
        case 'tran':
            xLabel = 'time';
            xUnit = 's';
            break;
        case 'ac':
            xLabel = 'frequency';
            xUnit = 'Hz';
            break;
        case 'dc':
            xLabel = 'voltage';
            xUnit = 'V';
            break;
        case 'op':
            xLabel = 'point';
            xUnit = undefined;
            break;
    }

    return {
        analysisType,
        xLabel,
        xUnit,
        pointsCount,
    };
}

/**
 * Create an empty result
 */
function createEmptyResult(analysisType: string): SimulationResult {
    return {
        meta: {
            analysisType,
            xLabel: 'time',
            pointsCount: 0,
        },
        series: [],
    };
}

/**
 * Parse ngspice raw ASCII format (alternative parser)
 */
export function parseRawAscii(
    rawContent: string,
    analysisType: string = 'tran',
): SimulationResult {
    const lines = rawContent.split('\n');

    let inData = false;
    let variables: string[] = [];
    const dataBlocks: number[][] = [];

    for (const line of lines) {
        const trimmed = line.trim();

        // Parse header
        if (trimmed.startsWith('No. Variables:')) {
            // Number of variables
        } else if (trimmed.startsWith('No. Points:')) {
            // Parse number of points (for reference, not used directly)
        } else if (trimmed.startsWith('Variables:')) {
            inData = false;
            // Next lines will be variable names
        } else if (trimmed.match(/^\d+\s+[\w()]+/)) {
            // Variable definition line: "0 time time"
            const parts = trimmed.split(/\s+/);
            if (parts[1]) {
                variables.push(parts[1]);
            }
        } else if (trimmed === 'Values:' || trimmed === 'Binary:') {
            inData = true;
        } else if (inData && trimmed !== '') {
            // Parse data values
            const values = trimmed.split(/\s+/).map((v) => {
                // Handle complex numbers (take real part)
                if (v.includes(',')) {
                    return parseFloat(v.split(',')[0] || '0');
                }
                return parseFloat(v);
            });

            if (values.length > 0 && !values.some(isNaN)) {
                dataBlocks.push(values);
            }
        }
    }

    // Convert to series format
    const series: DataSeries[] = [];

    if (variables.length > 1 && dataBlocks.length > 0) {
        // First variable is usually time/frequency
        for (let i = 1; i < variables.length; i++) {
            const points: DataPoint[] = [];

            for (const block of dataBlocks) {
                const x = block[0];
                const y = block[i];
                if (x !== undefined && y !== undefined) {
                    points.push({ x, y });
                }
            }

            series.push({
                name: variables[i] || `var${i}`,
                points,
            });
        }
    }

    return {
        meta: buildMeta(analysisType, series),
        series,
    };
}

/**
 * Detect output format from content
 */
export function detectOutputFormat(content: string): 'csv' | 'raw' | 'unknown' {
    const firstLines = content.split('\n').slice(0, 10).join('\n');

    if (firstLines.includes('Plotname:') || firstLines.includes('No. Variables:')) {
        return 'raw';
    }

    // CSV-like format (just numbers separated by whitespace)
    const firstDataLine = content.split('\n').find((l) => {
        const trimmed = l.trim();
        return trimmed !== '' && !trimmed.startsWith('*') && !trimmed.startsWith('#');
    });

    if (firstDataLine && /^[\d.eE+\-\s]+$/.test(firstDataLine.trim())) {
        return 'csv';
    }

    return 'unknown';
}

/**
 * Auto-parse output based on detected format
 */
export function parseSimulationOutput(
    content: string,
    probeNames: string[],
    analysisType: string = 'tran',
): SimulationResult {
    const format = detectOutputFormat(content);

    switch (format) {
        case 'csv':
            return parseCsv(content, probeNames, analysisType);
        case 'raw':
            return parseRawAscii(content, analysisType);
        default:
            throw new Error(`Unknown output format. Content starts with: ${content.substring(0, 100)}`);
    }
}