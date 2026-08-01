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
export { buildObjectTree, nodeAt } from './tree/object-tree';
export type { ObjectKind, ObjectRef, TreeNode, ObjectTree } from './tree/object-tree';
