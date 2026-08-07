/**
 * The editor kernel.
 *
 * Framework-free and renderer-free by construction: no React, no DOM, no Node. It compiles with
 * `lib:["ES2022"]` and `types:[]`, so the compiler refuses a `document` or a `Buffer` rather than a
 * convention someone has to remember, and `boundary.spec.ts` asserts the dependency allowlist and proves
 * the package installs standalone.
 *
 * That discipline is the whole point. This code is meant to be lifted into a separate frontend workspace
 * VERBATIM, and a promise like that only holds if it is enforced from the first commit — checked at the
 * end, the fix is a rewrite.
 */
export { buildObjectTree, nodeAt, isPlaceablePart, isDrawnOnSheet } from './tree/object-tree';
export type { ObjectKind, ObjectRef, TreeNode, ObjectTree } from './tree/object-tree';

/**
 * Editing. Pure, total, immutable — every one returns the new document or a refusal that names the field and
 * the reason, so a caller can put the message beside the input rather than showing "something went wrong".
 */
export { setDesignator, setNetName, setValue } from './document/edits';
export { connectPins, disconnectPin, movePinToNet, splitNet } from './document/nets';
export { addComponent, deleteComponent, duplicateComponents, type NewPart } from './document/parts';
export type { EditResult, EditRefusal } from './document/edits';

/**
 * The commit kernel: transactions, undo, redo, and the record of what each revision touched.
 *
 * A commit is all-or-nothing, so a compound edit is safe to interrupt. `touched` names the objects that
 * changed by IDENTITY rather than by id — the input an incremental checker needs, recorded now because
 * adding it later would touch every edit.
 */
export {
    HISTORY_LIMIT,
    adopt,
    beginHistory,
    canRedo,
    canUndo,
    commit,
    commitUi,
    isEmptyTouch,
    redo,
    touchedBetween,
    undo,
} from './document/history';
export type { CommitResult, EditorDocument, History, Revision, Touched } from './document/history';
export { sameJson } from './document/same-json';

/**
 * Schematic symbol geometry, in unitless local coordinates. `basis` says whether the symbol is a
 * conventional drawing or one derived from the part's own pins — which is the difference between knowledge
 * and a guess, and it is stated rather than left to be inferred.
 */
export { symbolFor, DRAWN_TYPES, UNDRAWN_BY_DESIGN } from './schematic/symbols';
export type { SymbolGeometry, SymbolPin, SymbolStroke } from './schematic/symbols';
export { PIN_GRID } from './schematic/symbols';
export { orientSymbol, type Orientation } from './schematic/orient';

/**
 * Wire routing for a schematic sheet.
 *
 * The topology decision — a net is a SET of terminals, so its wires are spokes from one point and never a
 * chain — lives here rather than in a renderer, because it is a claim about the netlist and not about
 * pixels. A renderer that had to re-derive it would be the second authority this codebase keeps paying for.
 */
export { routeSheet } from './schematic/route';
export type {
    Box,
    Fallback,
    Junction,
    Point,
    RoutedSheet,
    RoutedWire,
    RouteNet,
    RoutePin,
    RouteShape,
} from './schematic/route';

/**
 * Where the parts sit, and the sheet the router is given.
 *
 * One authority. A renderer that computed its own placement, or a test that reproduced it by hand, would be
 * pinning a sheet nobody sees — which is exactly what happened when the canvas owned this.
 */
export { placeParts, bodiesOf, netsOf, groundGlyphs } from './schematic/layout';
export { alignParts, spreadParts, type AlignEdge, type SpreadAxis } from './schematic/align';
export type { PlacedPart } from './schematic/layout';
