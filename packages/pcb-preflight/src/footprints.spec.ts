import type { Component } from '@circuit-forge/eda-core';

import { resolveFootprint, normalizeFootprint, isLedDiode, soicForPinCount } from './footprints';

const mk = (over: Partial<Component>): Component => ({
    id: 'c1',
    type: 'resistor',
    designator: 'R1',
    pins: [
        { pinId: '1', netId: 'a' },
        { pinId: '2', netId: 'b' },
    ],
    ...over,
});

describe('normalizeFootprint', () => {
    it('maps catalog spellings to footprinter spellings', () => {
        expect(normalizeFootprint('SOIC-8')).toBe('soic8');
        expect(normalizeFootprint('TO-92')).toBe('to92');
        expect(normalizeFootprint('SOD-123')).toBe('sod123');
        expect(normalizeFootprint(' 0603 ')).toBe('0603');
    });
});

describe('isLedDiode (approval condition 4: LED = diode + led_* model)', () => {
    it('detects led model refs case-insensitively', () => {
        expect(isLedDiode({ type: 'diode', model: 'led_red' })).toBe(true);
        expect(isLedDiode({ type: 'diode', model: 'LEDRED' })).toBe(true);
        expect(isLedDiode({ type: 'diode', model: 'D1N4148' })).toBe(false);
        expect(isLedDiode({ type: 'resistor', model: 'led_red' })).toBe(false);
        expect(isLedDiode({ type: 'diode' })).toBe(false);
    });
});

describe('resolveFootprint', () => {
    it('an explicit component.footprint override ALWAYS wins (normalized)', () => {
        const r = resolveFootprint(mk({ footprint: 'SOIC-8', type: 'subckt' }));
        expect(r).toEqual({ footprint: 'soic8', source: 'override' });
    });

    it('passives default to 0603, properties.size selects the imperial code', () => {
        expect(resolveFootprint(mk({}))?.footprint).toBe('0603');
        expect(resolveFootprint(mk({ properties: { size: '0805' } }))?.footprint).toBe('0805');
        expect(resolveFootprint(mk({ properties: { size: 'weird' } }))?.footprint).toBe('0603');
    });

    it('diode -> sod123; led-diode -> 0603; bjt -> sot23 (to92 via properties.package)', () => {
        expect(resolveFootprint(mk({ type: 'diode' }))?.footprint).toBe('sod123');
        expect(resolveFootprint(mk({ type: 'diode', model: 'led_red' }))?.footprint).toBe('0603');
        expect(resolveFootprint(mk({ type: 'bjt' }))?.footprint).toBe('sot23');
        expect(resolveFootprint(mk({ type: 'bjt', properties: { package: 'TO92' } }))?.footprint).toBe('to92');
    });

    it('subckt uses the SOIC ladder by pin count; beyond 16 requires an override', () => {
        const pins5 = Array.from({ length: 5 }, (_, i) => ({ pinId: `p${i}`, netId: 'n' }));
        expect(resolveFootprint(mk({ type: 'subckt', pins: pins5 }))?.footprint).toBe('soic8');
        const pins20 = Array.from({ length: 20 }, (_, i) => ({ pinId: `p${i}`, netId: 'n' }));
        expect(resolveFootprint(mk({ type: 'subckt', pins: pins20 }))).toBeNull();
        expect(soicForPinCount(14)).toBe('soic14');
        expect(soicForPinCount(16)).toBe('soic16');
    });

    it('sources are connectorized to pinrow2; unknown types resolve to null (never a guess)', () => {
        expect(resolveFootprint(mk({ type: 'voltage_source' }))?.footprint).toBe('pinrow2');
        expect(resolveFootprint(mk({ type: 'ground' }))).toBeNull();
        expect(resolveFootprint(mk({ type: 'generic' }))).toBeNull();
    });
});
