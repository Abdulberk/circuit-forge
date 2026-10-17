/**
 * The generic part library: one definition per part a user can place without a catalogue.
 *
 * KiCad, Altium and Flux never place a valueless part: a new resistor arrives as 10k, a capacitor as 100n.
 * Before this, `addComponent` produced a resistor with no value at all, so every part placed from the
 * palette was an ERC finding and a netlist the simulator refused until somebody typed a number.
 *
 * Pure data, read by every surface that places a part (palette, keyboard placement, context menu), so the
 * default a part arrives with cannot differ between them. A catalogue part is the same shape with sourcing
 * attached; see docs/WEB_APP.md §2.
 */
import { COMPONENT_PINS, type ComponentType } from '@circuit-forge/eda-core';

import type { NewPart } from '../document/parts';

/** Where a part is listed in the palette. */
export type PartGroup = 'passive' | 'source' | 'semiconductor';

export interface GenericPart {
    /** Stable id, `generic:<name>`. Several definitions may share a component type (NPN and PNP are both `bjt`). */
    id: string;
    /** What the palette shows. */
    label: string;
    /** Words a search should match beyond the label: designator letter, common names. */
    keywords: readonly string[];
    group: PartGroup;
    /** The new part, minus the designator, which the kernel allocates. Always carries a value or a model. */
    part: Omit<NewPart, 'designator'>;
}

const def = (id: string, label: string, group: PartGroup, part: GenericPart['part'], keywords: string[] = []) => ({
    id: `generic:${id}`,
    label,
    group,
    part,
    keywords,
});

/**
 * Every generic part, in palette order.
 *
 * Values are the ones a designer reaches for first. Models name entries of eda-core's vetted generic
 * library; the netlist generator injects their `.model` bodies, so no model text lives here.
 */
export const GENERIC_PARTS: readonly GenericPart[] = [
    def('resistor', 'Resistor', 'passive', { type: 'resistor', value: '10k' }, ['r', 'res']),
    def('capacitor', 'Capacitor', 'passive', { type: 'capacitor', value: '100n' }, ['c', 'cap']),
    def('inductor', 'Inductor', 'passive', { type: 'inductor', value: '10u' }, ['l', 'coil']),
    def('voltage-source', 'Voltage source', 'source', { type: 'voltage_source', value: 'DC 5' }, [
        'v',
        'battery',
        'supply',
    ]),
    def('current-source', 'Current source', 'source', { type: 'current_source', value: 'DC 1m' }, ['i']),
    def('diode', 'Diode', 'semiconductor', { type: 'diode', model: 'DDEFAULT' }, ['d', 'rectifier']),
    def('led-red', 'LED (red)', 'semiconductor', { type: 'diode', model: 'LEDRED' }, ['d', 'led', 'light']),
    def('zener', 'Zener diode', 'semiconductor', { type: 'zener', value: '5.1' }, ['d', 'zener', 'regulator']),
    def('npn', 'NPN transistor', 'semiconductor', { type: 'bjt', model: 'QGENNPN' }, ['q', 'bjt', 'transistor']),
    def('pnp', 'PNP transistor', 'semiconductor', { type: 'bjt', model: 'QGENPNP' }, ['q', 'bjt', 'transistor']),
    def('nmos', 'N-channel MOSFET', 'semiconductor', { type: 'mosfet', model: 'MGENNMOS' }, [
        'q',
        'm',
        'fet',
        'mosfet',
    ]),
    def('pmos', 'P-channel MOSFET', 'semiconductor', { type: 'mosfet', model: 'MGENPMOS' }, [
        'q',
        'm',
        'fet',
        'mosfet',
    ]),
];

/** The definition a palette entry or keyboard shortcut names, or undefined. */
export const genericPart = (id: string): GenericPart | undefined => GENERIC_PARTS.find((p) => p.id === id);

/** The default definition for a component type — what a bare "add a resistor" means. */
export const defaultPartFor = (type: ComponentType): GenericPart | undefined =>
    GENERIC_PARTS.find((p) => p.part.type === type);

/** Palette search: label or keyword prefix, case-insensitive. An empty query lists everything. */
export function searchGenericParts(query: string): GenericPart[] {
    const q = query.trim().toLowerCase();
    if (q === '') return [...GENERIC_PARTS];
    return GENERIC_PARTS.filter((p) => p.label.toLowerCase().includes(q) || p.keywords.some((k) => k.startsWith(q)));
}

/** Whether every type here can be created blank: fixed-arity types only, so the kernel never refuses one. */
export const isPlaceableType = (type: ComponentType): boolean => (COMPONENT_PINS[type] ?? []).length > 0;
