/**
 * TME category-ID -> internal ComponentType map.
 *
 * This is the PRIMARY, locale-independent part classifier. TME exposes a stable numeric category
 * taxonomy (`category.id`); mapping those IDs to our SPICE types is the same approach Octopart /
 * DigiKey / KiCad use — far more reliable than scanning the (localized) description text, which is
 * only kept as a last-resort fallback in component-mapper.ts.
 *
 * Only categories that map to a *single SPICE-simulatable primitive* (resistor/capacitor/inductor/
 * diode) are listed. Everything NOT here (transistors, ICs, connectors, sensors, modules, networks,
 * Zener/TVS/bridges, …) is intentionally absent → it falls through to `'generic'` (catalog-only,
 * simulatable:false) until active-device modeling lands.
 *
 * IDs harvested from the live TME v2 taxonomy (country=PL, language=en) on 2026-06-02. The tree is
 * stable, but extend this map when the "unmapped TME category" debug log surfaces a new leaf.
 */
import type { ComponentType } from '@circuit-forge/eda-core';

export const TME_CATEGORY_TYPE: Record<string, ComponentType> = {
    // --- Resistors (single resistors only; networks/thermistors/potentiometers/varistors excluded) ---
    '100299': 'resistor', // Resistors (family root)
    '100300': 'resistor', // SMD resistors
    '112312': 'resistor', // THT Resistors
    '100511': 'resistor', // Power resistors
    '100298': 'resistor', // Other Resistors
    '113148': 'resistor', // Heating resistors
    '113512': 'resistor', // Audio resistors

    // --- Capacitors ---
    '26': 'capacitor', // Capacitors (family root)
    '100560': 'capacitor', // MLCC capacitors
    '113537': 'capacitor', // MLCC SMD capacitors
    '100568': 'capacitor', // MLCC THT capacitors
    '100558': 'capacitor', // MLCC array capacitors
    '100003': 'capacitor', // Ceramic capacitors
    '100556': 'capacitor', // Electrolytic capacitors
    '112341': 'capacitor', // SMD electrolytic capacitors
    '112342': 'capacitor', // THT electrolytic capacitors
    '113265': 'capacitor', // SNAP-IN electrolytic capacitors
    '114042': 'capacitor', // Screw terminal and others el. capacitors
    '113764': 'capacitor', // SMD Hybrid Capacitors
    '112350': 'capacitor', // Film Capacitors
    '100265': 'capacitor', // THT Film Capacitors
    '112351': 'capacitor', // SMD Film Capacitors
    '100472': 'capacitor', // Polypropylene capacitors
    '100471': 'capacitor', // Standard polypropylene capacitors
    '113466': 'capacitor', // Paper capacitors
    '100263': 'capacitor', // Motor capacitors
    '112353': 'capacitor', // Lighting capacitors
    '113244': 'capacitor', // Tantalum capacitors
    '113245': 'capacitor', // SMD tantalum capacitors
    '113246': 'capacitor', // THT tantalum capacitors
    '113247': 'capacitor', // Polymer - tantalum capacitors
    '100634': 'capacitor', // SMD niobium capacitors
    '100266': 'capacitor', // SMD capacitors - others
    '113190': 'capacitor', // Supercapacitors
    '113225': 'capacitor', // Polymer and Hybrid Capacitors
    '113762': 'capacitor', // SMD Polymer Capacitors
    '113763': 'capacitor', // THT Polymer Capacitors
    '118085': 'capacitor', // THT Hybrid Capacitors
    '113511': 'capacitor', // Audio capacitors
    '113514': 'capacitor', // Audio polypropylene capacitors
    '113515': 'capacitor', // Audio electrolytic capacitors
    '113516': 'capacitor', // THT audio electrolytic capacitors

    // --- Inductors / coils ---
    '100406': 'inductor', // Inductive Components (family root)
    '112358': 'inductor', // Coils
    '112359': 'inductor', // Inductors
    '113510': 'inductor', // Audio coils
    '113553': 'inductor', // Ferrite - inductors

    // --- Diodes (rectifier-like only: universal + Schottky. Zener/TVS/bridges/modules -> generic,
    //     they need their own models for honest simulation, added with active-device support). ---
    '112141': 'diode', // Diodes (family root)
    '100179': 'diode', // Universal diodes
    '112791': 'diode', // SMD universal diodes
    '113119': 'diode', // THT universal diodes
    '112792': 'diode', // Stud mounting universal diodes
    '112793': 'diode', // Diodes - others
    '112795': 'diode', // Schottky diodes
    '112796': 'diode', // SMD Schottky diodes
    '112797': 'diode', // THT Schottky diodes
    '112798': 'diode', // Stud mounting Schottky diodes

    // --- Bipolar transistors (single NPN/PNP) -> bjt. Darlington/complementary/IGBT stay generic. ---
    '112833': 'bjt', // NPN SMD transistors
    '100180': 'bjt', // NPN THT transistors
    '112832': 'bjt', // PNP SMD transistors
    '100591': 'bjt', // PNP THT transistors

    // --- MOSFETs (single N/P channel) -> mosfet. Multi-channel/modules stay generic. ---
    '100309': 'mosfet', // N channel transistors
    '112826': 'mosfet', // SMD N channel transistors
    '112827': 'mosfet', // THT N channel transistors
    '100592': 'mosfet', // P channel transistors
    '112828': 'mosfet', // SMD P channel transistors
    '112829': 'mosfet', // THT P channel transistors

    // --- Intentionally catalog-only: structurally NOT a single SPICE primitive, but whose names would
    //     fool the text fallback (a Zener says "diode", a resistor network says "resistor"). Mapping
    //     them to 'generic' makes the structured map authoritative and blocks the wrong text guess.
    //     These get proper models once active/multi-terminal device support lands. ---
    '112321': 'generic', // Resistor networks (multi-element)
    // Zener diodes -> 'zener' (the same SPICE D device with a breakdown model generated from the
    // catalog's Zener voltage). The component-mapper falls back to 'generic' if no voltage is found.
    '100257': 'zener', // Zener diodes
    '100576': 'zener', // SMD Zener diodes
    '100254': 'zener', // THT Zener diodes
    '112799': 'zener', // Stud mounting Zener diodes
    '100253': 'generic', // Protection diodes
    // TVS: a UNIDIRECTIONAL TVS clamps like a Zener at its breakdown voltage -> 'zener'. Bidirectional
    // and unspecified TVS need back-to-back clamps (a subckt), so they stay catalog-only 'generic'.
    '112800': 'generic', // TVS SMD diodes (direction unspecified)
    '112801': 'zener', // Unidirectional TVS SMD diodes
    '112802': 'generic', // Bidirectional TVS SMD diodes
    '112803': 'generic', // TVS THT diodes (direction unspecified)
    '112804': 'zener', // Unidirectional TVS THT diodes
    '112805': 'generic', // Bidirectional TVS THT diodes
    '113178': 'generic', // Protection diodes - arrays
    '112806': 'generic', // Special diodes
    '118189': 'generic', // Diodes - Unclassified
    '113441': 'generic', // Diode modules
    '112807': 'generic', // Bridge rectifiers (multi-diode, 4-terminal)
    '112808': 'generic', // Single phase bridge rectifiers
    '100287': 'generic', // Single phase diode bridge rectifiers
    '112815': 'generic', // Three phase bridge rectifiers
};

/** Look up a stable TME category id; returns undefined when the id is unmapped. */
export function typeFromCategoryId(categoryId: string | undefined): ComponentType | undefined {
    if (!categoryId) return undefined;
    return TME_CATEGORY_TYPE[categoryId];
}

/**
 * Polarity/class of an active-device category, used to pick the right generic model
 * (npn/pnp for bjt, nmos/pmos for mosfet). Keyed by the same stable TME category ids.
 */
export const TME_ACTIVE_SUBTYPE: Record<string, 'npn' | 'pnp' | 'nmos' | 'pmos'> = {
    '112833': 'npn', // NPN SMD transistors
    '100180': 'npn', // NPN THT transistors
    '112832': 'pnp', // PNP SMD transistors
    '100591': 'pnp', // PNP THT transistors
    '100309': 'nmos', // N channel transistors
    '112826': 'nmos', // SMD N channel transistors
    '112827': 'nmos', // THT N channel transistors
    '100592': 'pmos', // P channel transistors
    '112828': 'pmos', // SMD P channel transistors
    '112829': 'pmos', // THT P channel transistors
};

/** Active-device polarity for a category id, or undefined. */
export function subtypeFromCategoryId(categoryId: string | undefined): string | undefined {
    if (!categoryId) return undefined;
    return TME_ACTIVE_SUBTYPE[categoryId];
}

/**
 * TME LED leaf categories (harvested live 2026-06-11). An LED is electrically a diode with a
 * color-class forward voltage — the mapper picks a generic LED model (LEDRED/LEDYEL/LEDGRN/LEDBLU)
 * by parsing the color from the part description; a colorless LED stays catalog-only (never silently
 * a 0.7V DDEFAULT diode).
 */
export const TME_LED_CATEGORY_IDS = new Set<string>([
    '112896', // THT LEDs Round
    '113363', // SMD colour LEDs
]);

export function isLedCategory(categoryId: string | undefined, categoryName: string | undefined): boolean {
    if (categoryId && TME_LED_CATEGORY_IDS.has(categoryId)) return true;
    // Fallback for unmapped LED leaves: the category NAME (not the description, which mentions LED for
    // accessories too) clearly identifying an LED family.
    return (
        !!categoryName && /\bLEDs?\b/i.test(categoryName) && !/driver|holder|lens|spacer|display/i.test(categoryName)
    );
}
