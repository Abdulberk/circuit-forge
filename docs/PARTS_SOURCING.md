# Component Catalog (Parts Sourcing) — Frontend Integration Guide

> Real manufacturer parts inside Circuit Forge — search a ~1.3M-part catalog, filter by
> manufacturer/category facets, inspect parametrics + live pricing/stock + datasheet, and drop a
> real part onto the schematic. Backend is **built, tested, and live-verified**; this is the
> contract + everything the frontend needs to consume it. Complements `FRONTEND_BRIEF.md` §4.4.11 / §6.
>
> **Backend module:** `apps/api/src/parts/` · **Swagger tag:** `parts` · **Base URL:** `http://localhost:3001`
> **Last verified:** 2026-05-31 against the live TME v2 API.

---

## 1. What it is & why

We provide a **Flux.ai-style part picker** backed by a real distributor catalog. The data source is
**TME (Transfer Multisort Elektronik)** via their v2 REST API — chosen because their terms *permit*
displaying their data in a third-party commercial app (with attribution), unlike DigiKey/Octopart
which forbid it. The backend wraps TME behind a **supplier-agnostic provider**, so DigiKey/LCSC can
be added later without changing the frontend contract.

- **~1.3M parts**, **1045 manufacturers**, full category tree — all queried **live** (we don't host a catalog).
- **Supplier credentials are server-side only** (`TME_*` env). The client never talks to TME and never sees a key.
- Attribution: when you display TME-sourced data, show a small **"Pricing & availability: TME"** credit.

---

## 2. Endpoints (authoritative contract)

All endpoints are **JWT-guarded** (`Authorization: Bearer <accessToken>`). No global prefix.

| Method | Path | Query | Returns | Throttle\* |
|---|---|---|---|---|
| GET | `/parts/search` | `q` (**required**, 1–100), `manufacturerId?` (≤50), `categoryId?` (≤50), `page?` (1–1000) | `SearchResult` | 30 / 60s |
| GET | `/parts/manufacturers` | — | `ManufacturerRef[]` (~1045, sorted desc by count) | 60 / 60s |
| GET | `/parts/categories` | — | `CategoryNode[]` (nested tree) | 60 / 60s |
| GET | `/parts/:symbol` | — | `CatalogPart` (full detail) | 30 / 60s |
| GET | `/parts/:symbol/component` | — | `MappedComponent` | 30 / 60s |

\* **Throttle limits are declared but NOT currently enforced** app-wide (no global `ThrottlerGuard` yet —
a known follow-up). Don't rely on `429`s; still **debounce** the search box client-side (~300ms).

`:symbol` is the **TME symbol** = `CatalogPart.supplierId` (e.g. `NE555P`, `WR06X1002FTL`) — **not** the MPN.
URL-encode it.

---

## 3. Data shapes (TypeScript)

```ts
// Search result
interface SearchResult {
  items: CatalogPart[];
  page: number;          // echoes the requested page (1-based)
  pageSize: number;      // number of items on this page (TME returns ~20/page)
  total?: number;        // usually ABSENT — TME does not return a grand total here
}

// A normalized, supplier-agnostic part
interface CatalogPart {
  mpn: string;                 // manufacturer part number, e.g. "NE555P"
  manufacturer: string;        // e.g. "TEXAS INSTRUMENTS"
  description: string;
  category?: string;           // e.g. "Watchdog and reset circuits"
  footprint?: string;          // package/case, e.g. "0603", "DIP8", "SOIC-8"
  photo?: string;              // absolute https thumbnail URL
  datasheetUrl?: string;       // see gotcha: may be a .txt redirect link, not always a PDF
  parameters: CatalogParameter[];  // EMPTY in search results; populated in detail
  priceBreaks: PriceBreak[];       // EMPTY in search results; populated in detail
  stock?: number;              // available quantity (can be 0)
  unitCost?: number;           // price for qty 1 (or smallest tier); absent if no price tiers
  currency?: string;           // ISO code, e.g. "EUR"
  supplier: string;            // "tme"
  supplierId: string;          // the TME symbol — pass this as :symbol
}

interface CatalogParameter { name: string; value: string; } // e.g. { name: "Resistance", value: "10kΩ" }
interface PriceBreak { amount: number; price: number; currency: string; special?: boolean; } // per-qty tier; currency always set

interface ManufacturerRef { id: string; name: string; productsCount: number; } // facet, with counts (Flux-style)

interface CategoryNode {            // facet tree, with counts
  id: string;
  parentId: string | null;
  name: string;
  productsCount: number;
  children: CategoryNode[];
}

// GET /parts/:symbol/component — a real part mapped toward a CircuitJson component
interface MappedComponent {
  simulatable: boolean;       // true => `component` is set and can be simulated
  reason?: string;            // why NOT simulatable (ICs/transistors/connectors)
  component?: PartialComponent;
  catalog: CatalogPart;       // always present (the full part detail)
}

// PARTIAL — no id / designator / pins (the schematic layer assigns those)
interface PartialComponent {
  type: 'resistor' | 'capacitor' | 'inductor' | 'diode'; // the simulatable types we map today
  value?: string;             // SPICE value, e.g. "10K", "100n" (passives only)
  footprint?: string;
  mpn?: string;
  manufacturer?: string;
  sourcing?: ComponentSourcing;
}
```

The shared `Component` type (from **`@circuit-forge/eda-core@1.1.0`**, published to npm) gained these
optional, backward-compatible fields — merge `PartialComponent` straight onto a new `Component`:

```ts
interface ComponentSourcing {
  supplier: string;       // "tme"
  supplierId: string;     // TME symbol
  unitCost?: number;
  currency?: string;
  stock?: number;
  datasheetUrl?: string;
}
// Component also now has optional: mpn?, manufacturer?, footprint?, sourcing?
```

---

## 4. The Part Picker (how to build the UI)

A modal or editor side-panel:

1. **Search box** (debounced ~300ms) → `GET /parts/search?q=…`. Render `items` as a result list
   (mpn, manufacturer, description, photo, category).
2. **Facets** (Flux-style, with counts):
   - `GET /parts/manufacturers` → checkbox/typeahead list; clicking sets `manufacturerId` on the next search.
   - `GET /parts/categories` → tree; selecting sets `categoryId`.
   - Load these once on open (they're cached server-side ~24h, so cheap).
3. **Detail pane** → on selecting a result, `GET /parts/:symbol` (using `supplierId`) → show parameters
   table, **price tiers** (`priceBreaks`), **stock**, datasheet link, photo.
4. **Insert** → `GET /parts/:symbol/component`:
   - If `simulatable: true` → take `component`, **assign `id` + the next free `designator`** (`R1`, `R2`, …;
     must match `^[A-Z][A-Z0-9]*[0-9]+$`) + **pins from `COMPONENT_PINS[type]`** (eda-core), and add it to the
     editor's `CircuitJson`. The `value`/`footprint`/`mpn`/`manufacturer`/`sourcing` are ready to keep.
   - If `simulatable: false` → it's an IC/transistor/connector (no SPICE type yet). Show the catalog
     metadata + a **"view / add to BOM, not simulatable yet"** affordance instead of Insert. Don't block search/inspection.

---

## 5. Things to watch (gotchas) — read this

1. **`q` is required.** Facet-only browsing (manufacturer/category with no keyword) is **not supported yet** —
   a search always needs a phrase. (TME's API allows phrase *or* category-only; we currently require `q`.)
2. **`:symbol` = `supplierId`, not `mpn`.** Use the `supplierId` from search results.
3. **`simulatable` flag is the whole game.** Passives (R/L/C) + diodes map to a simulatable component;
   **ICs/transistors/op-amps/connectors are catalog-only** (`simulatable:false`, `component` omitted) — there's
   no transistor/IC type in `CircuitJson` yet (the "active-component" roadmap item). Always branch on this.
4. **`component` is PARTIAL** — no `id`/`designator`/`pins`. The editor owns those (generate a unique
   designator ending in a digit; wire pins from `COMPONENT_PINS[type]`). Don't expect a ready-to-render component.
5. **Pagination:** TME returns ~**20 items/page**, pass `page` (1-based). **`total` is usually absent** — use a
   "load more / next page" pattern (there's a next page if `pageSize === 20`), not a numbered pager with totals.
6. **Weird/blocked search phrases return empty, not an error.** TME's WAF rejects payloads like `<script>` or
   SQLi-looking strings; the backend turns that into **`200` with `items: []`**. So always handle "no results"
   gracefully — never assume an error.
7. **Unknown symbol → `404`.** `GET /parts/DOES_NOT_EXIST` (and `…/component`) returns 404.
8. **Facets are cached ~24h** server-side. Fast, but they won't reflect TME catalog changes within a day. Fine to cache hard on the client too.
9. **`datasheetUrl` is best-effort** — for some parts TME only has a `.txt` redirect link, not a real PDF. Label it "datasheet" and open in a new tab; don't assume PDF.
10. **`footprint` may be missing** for some categories (e.g. inductors expose no standard case code). It comes from the part's "Case" parameter.
11. **Pricing:** `priceBreaks` are **NET** prices in the part's `currency` (default **EUR**, server-configurable),
    one tier per minimum quantity. `currency` is always set (never empty). `stock` can be `0`; `unitCost` can be absent.
12. **Throttle not enforced yet** (see §2) — debounce search yourself.
13. **Default market:** `country=PL`, `currency=EUR` (server env). If you target a specific market later, that's a one-line server env change, not a frontend concern.

---

## 6. Error handling (status → UX)

Standard NestJS error envelope (`{ statusCode, message, error }`). Map:

| Status | When | Frontend |
|---|---|---|
| `400` | missing `q`, bad `page`/ids, malformed symbol | inline validation; fix the query |
| `401` | missing/expired JWT | refresh token / re-auth (same as every other endpoint) |
| `404` | unknown `:symbol` | "part not found" |
| `502` | upstream/TME error (transient — backend already retries once) | "catalog temporarily unavailable, try again" toast |
| `503` | catalog not configured (`TME_*` unset) or TME auth failed | "component catalog is unavailable" banner |

Search WAF-rejections do **not** error — they return `200 { items: [] }` (gotcha #6).

---

## 7. How it works server-side (context, not required reading)

- **Provider abstraction:** `PartProvider` interface; `TmeProvider` today. Endpoints/DTOs are supplier-agnostic.
- **Auth:** TME v2 OAuth2 `client_credentials` → Bearer (≈300s), cached with refresh-ahead + single-flight.
- **Resilience:** per-request timeout, one-shot 401 re-auth, one transient (5xx/network) retry, a concurrency
  limiter (≤4 in-flight, under TME's ~5 req/s). On detail, the search lookup is primary; parameters/data/files
  are best-effort (a transient failure there degrades to empty, not a 502).
- **Caching:** in-memory TTL — manufacturers/categories ~24h, search ~60s, with a 1000-entry cap.
- **Mapping:** `CatalogPart → CircuitJson` infers `type` from category/description, extracts the value from
  catalog parameters (rejecting ranges/tolerances and non-finite values), footprint from "Case".

---

## 8. Verify it yourself (Swagger `/docs`)

1. `POST /auth/login` `{ "email": "...", "password": "..." }` → copy `accessToken` → **Authorize 🔒**.
2. `GET /parts/manufacturers` → ~1045 `{ id, name, productsCount }`.
3. `GET /parts/categories` → tree with counts.
4. `GET /parts/search?q=NE555` → results; copy a `supplierId`.
5. `GET /parts/NE555P` → 13 params, 8 price tiers, stock, datasheet (IC).
6. `GET /parts/NE555P/component` → `simulatable:false` + reason.
7. `GET /parts/WR06X1002FTL/component` → `simulatable:true`, `type:resistor`, `value:"10K"`, `footprint:"0603"`, `sourcing` populated.

Edge cases to confirm: `GET /parts/ZZZNONEXIST999` → `404`; `GET /parts/search?q=<script>alert(1)</script>` →
`200 { items: [] }`; `GET /parts/search?q=resistor&page=2` ≠ `page=1`.

Ready-to-use IDs: manufacturers — TI=`77`, Vishay=`36`, Microchip=`632`, Murata=`147`, Yageo=`442`,
Nexperia=`1241`, onsemi=`41`, STM=`35`; categories — Semiconductors=`112140`, Passives=`112309`, Connectors=`46`.

---

## 9. Known limitations & roadmap

- **Active components (biggest one):** ICs/transistors/op-amps are searchable but **not simulatable**
  (`simulatable:false`) — `CircuitJson` has no transistor/IC/`.model`/`.subckt` type yet. Until that lands,
  the picker is "full catalog for browsing/BOM, passives+diodes for simulation."
- **Global rate limiting** (`ThrottlerGuard`) and an **HTTP body-size limit** are pending app-wide hardening.
- **Facet-only browsing** (no keyword) and a **result `total`/count** are not exposed yet.
- More suppliers (DigiKey/LCSC) can be added behind `PartProvider` without changing this contract.
