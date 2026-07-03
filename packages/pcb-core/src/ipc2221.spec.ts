import { ipc2221WidthMm } from './ipc2221';

describe('ipc2221WidthMm — current → minimum trace width (anchored to known IPC-2221 chart points)', () => {
    it('matches the canonical 1A / 10°C / 1oz external = ~0.30mm', () => {
        const r = ipc2221WidthMm({ currentA: 1 });
        expect(r.widthMm).toBeCloseTo(0.3, 2);
        expect(r.clamped).toBe(false);
    });

    it('scales up with current (3A ≈ 1.37mm, 5A ≈ 2.77mm)', () => {
        expect(ipc2221WidthMm({ currentA: 3 }).widthMm).toBeCloseTo(1.367, 2);
        expect(ipc2221WidthMm({ currentA: 5 }).widthMm).toBeCloseTo(2.765, 2);
    });

    it('internal layers run WIDER than external for the same current (k 0.024 vs 0.048)', () => {
        const ext = ipc2221WidthMm({ currentA: 1, layer: 'external' }).widthMm;
        const int = ipc2221WidthMm({ currentA: 1, layer: 'internal' }).widthMm;
        expect(int).toBeGreaterThan(ext);
        expect(int).toBeCloseTo(0.781, 2);
    });

    it('heavier copper and higher ΔT both reduce the required width', () => {
        expect(ipc2221WidthMm({ currentA: 1, copperOz: 2 }).widthMm).toBeCloseTo(0.15, 2);
        expect(ipc2221WidthMm({ currentA: 1, deltaTC: 20 }).widthMm).toBeCloseTo(0.197, 2);
    });

    it('CLAMPS above the chart envelope and flags it — never silent extrapolation', () => {
        const hot = ipc2221WidthMm({ currentA: 60 }); // > 35A chart bound
        expect(hot.clamped).toBe(true);
        expect(hot.notes.join(' ')).toMatch(/current.*above IPC-2221 envelope/);

        const thin = ipc2221WidthMm({ currentA: 1, deltaTC: 5 }); // ΔT < 10 bound
        expect(thin.clamped).toBe(true);
        expect(thin.notes.join(' ')).toMatch(/ΔT.*below IPC-2221 envelope/);
    });

    it('caps the width at the 400mil chart ceiling (a bus, not a track) and flags it', () => {
        const huge = ipc2221WidthMm({ currentA: 35, deltaTC: 10, copperOz: 0.5 });
        expect(huge.widthMm).toBeLessThanOrEqual(400 * 0.0254 + 1e-9);
        expect(huge.clamped).toBe(true);
    });
});
