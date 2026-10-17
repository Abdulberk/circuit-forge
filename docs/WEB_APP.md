# Web app (`apps/web`) — plan and current state

Decided on 2026-10-17: **monorepo**. The web interface lives in this repo as `apps/web` (Next.js), and it
grows out of the studio prototype rather than starting from zero: the editor kernel, the API client, the
document lifecycle (autosave, conflicts, recovery) and their 300+ tests are kept; the shell, the theme and
the navigation are rebuilt.

## 1. Are the API contracts ready?

**Partly.** What exists:

|                           | State                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAPI                   | Live at `/docs-json`: 83 paths, 101 operations, 44 request DTOs.                                                                                |
| Response types in OpenAPI | **0 of 101.** No controller declares `@ApiOkResponse({ type })`, so a generated client would have typed requests and `unknown` responses.       |
| Domain types              | `@circuit-forge/eda-core` (`CircuitJson`, `UiJson`, `AnalysisConfig`, `SimulationResult`) with Zod validators. Usable directly in the monorepo. |
| Hand-typed client         | `apps/web/lib/api` (from the studio): auth with single-flight refresh, errors, polling, ~15 resources.                                          |
| Contract tests            | `live-api.e2e.spec.ts`: 31 tests against the running API + Postgres. This is what actually holds the contract today.                            |

**Decision.** Keep the hand-typed client and its live contract tests as the source of truth for now. Add
response DTOs to the controllers module by module (auth, orgs, projects, working-copy, versions first);
switch to `openapi-typescript` codegen only once a module's responses are typed, so the generated types
never claim more than the server declares.

## 2. Library / component model

### What exists

- A component in `CircuitJson` is `type + pins + value/model + optional mpn/manufacturer/footprint/sourcing`.
  There is **no part definition**: symbol, footprint and simulation model are each derived separately.
- **Symbols** (`editor-core/symbols.ts`): 6 of 32 types are drawn (R, C, L, D, V, GND); the rest are a
  labelled box built from the pins. LEDs draw as plain diodes.
- **Footprints** (`pcb-preflight/footprints.ts`): explicit `component.footprint` wins, else a curated default
  per type (0603 passives, SOIC ladder by pin count).
- **Simulation models**: `eda-core` generic model library; the parts API attaches a `ModelDef` for actives.
- **Real parts**: `GET /parts/search` + `GET /parts/:symbol/component` (TME, ~1.3M parts) → `MappedComponent`.
- **Two unrelated ways to add a part**: a type dropdown (`addComponent`, no value) and the catalogue panel.
- **Gaps that hurt today**: new generic parts arrive with no value; catalogue parts mapped to `generic`
  (connectors, bridges, resistor networks) cannot be placed at all because `generic` has no pin list;
  the `SYMBOL_PACK` asset type exists and nothing reads it.

### Target model

One concept, a **part definition**, that everything else reads:

```
PartDefinition
  id            'generic:resistor' | 'tme:WR06X1002FTL' | 'user:<assetId>'
  componentType eda-core ComponentType
  pins          ordered [{ id, name, electrical: 'passive'|'input'|'output'|'power'|... }]
  symbol        built-in symbol id, or a symbol from a symbol pack; derived box only as a last resort
  defaultValue  '10k', '100n', 'DC 5' …  (KiCad/Altium: a placed part is never valueless)
  model?        ModelDef (simulation)
  footprint?    footprinter string
  sourcing?     mpn, manufacturer, supplier ids, price/stock (catalogue parts only)
```

- **Generic library** (in `editor-core`, pure data): one definition per placeable type with a sensible
  default value. The palette and keyboard placement read it. _First step, done in this branch._
- **Catalogue parts** become definitions on the server side (`/parts/:symbol/component` already returns
  most of it); the missing piece is a **pin list for `generic` parts** (from catalogue parameters or a
  pin-count fallback) so every catalogue part can be placed.
- **Symbols per definition** instead of per type: LED, op-amp (subckt with named ports), BJT/MOSFET with
  polarity from the model, logic gates. This is review stage 4.
- The document format does not change: an instance still carries its own type, pins, value, model and
  sourcing, so simulation, PCB and AI keep reading `CircuitJson` as they do now.

## 3. The web app

| Concern      | Choice                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| Framework    | Next.js 15 App Router, React 19 (same versions as before; Next 16 when the repo moves)                     |
| Styling      | Tailwind CSS v4 with design tokens as CSS variables; light and dark themes                                 |
| Routes       | `/login`, `/projects`, `/projects/[projectId]` (editor). Every view has its own URL; refresh and back work |
| Server state | API client + hooks (TanStack Query when the screens multiply)                                              |
| Editor state | `editor-core` commit kernel via `useDocument` (unchanged)                                                  |

### Roadmap (from the design review)

1. ✅ Draw like KiCad (stored wires) — #315
2. Shell, theme, routes (this branch) → then sign-up, org panel, versions UI
3. Edit like KiCad: net labels, power symbols, no-connect, place-at-cursor, Ctrl+K
4. Real symbols per part definition; catalogue `generic` parts placeable
5. Simulation panel, 6. AI chat panel, 7. PCB tab, 8. BOM and polish
