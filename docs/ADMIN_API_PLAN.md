# Platform Admin API — Plan (not yet implemented)

> **Status: PLAN.** Grounded in a comprehensive 5-subsystem audit of the current code + Prisma schema
> (2026-07-01). Nothing here is built yet. This document is the blueprint for the admin backend that powers a
> future operator **dashboard**.

## The gap

circuit-forge has **no platform-admin surface at all.** Every endpoint is tenant-scoped: a user acts only
within their own organizations. `OrgRole` (`OWNER`/`ADMIN`/`MEMBER` on `OrgMembership`) is a **tenant** role —
the owner of *an org*, not a platform operator. There is no `isAdmin`, no `@Roles`/`RolesGuard`, no `/admin/*`
route, and no admin flag on `User`.

So today a platform operator **cannot**: see all users/orgs, adjust one org's quota, inspect or cancel a job
in another tenant, suspend an abusive account, curate the public template catalog, drain a worker, change the
LLM model without a redeploy, run a GDPR erase, or read the platform-wide audit trail. For a multi-tenant
system heading to production, that is a real operational + compliance gap.

The audit found **87 admin capabilities** across 5 subsystems. This plan organizes them into a foundation +
four phases (safe→risky), with the exact data-model deltas and the cross-cutting rules every endpoint must obey.

---

## Phase 0 — Foundation (everything depends on this; build first)

Nothing else is safe until platform-admin identity + gating + audit exist.

| Item | Detail |
|---|---|
| **Admin identity** | Add `User.platformRole` enum `NONE` (default) / `SUPPORT` / `OPERATOR` / `ADMIN`. A boolean `isPlatformAdmin` is the MVP, but the **graduated enum is recommended**: it lets `SUPPORT` read-only, `OPERATOR` mutate, `ADMIN` do destructive/config — a natural least-privilege split for the phases below. Keep the count of non-NONE accounts tiny. |
| **Guard** | `PlatformAdminGuard` extends `JwtAuthGuard`, checks the decoded `platformRole` (embed it in the JWT so no per-request DB hit). Gates **all** `/admin/*`. NOT tenant-scoped — an admin sees every org. |
| **Bootstrap** | First admin via `PLATFORM_ADMIN_EMAIL` env at seed time (idempotent upsert → set role `ADMIN`). The only out-of-band way to mint the first admin; afterward `PATCH /admin/users/:id/role` promotes others. |
| **Admin audit** | **Every admin mutation writes an `AuditLog` row** — `action` prefixed `admin.` (e.g. `admin.org.suspend`), `entityType`/`entityId` = the target, `meta = { adminActorId, adminActorEmail, before, after }`. Add `AuditLog.adminActorId` (nullable) so admin-initiated changes are distinguishable from the subject's own. This is non-negotiable: admin is the highest-trust surface. |

**Schema delta (Phase 0):** `User.platformRole` (enum, default `NONE`); `AuditLog.adminActorId String?`.

---

## Phase 1 — Read-only observability (safe, highest value/risk ratio — build second)

Pure cross-tenant reads. This alone gives an operator most of a dashboard's value at near-zero risk. All reuse
existing models; **no schema changes**.

- `GET /admin/users` — list/search all users (paginated); `GET /admin/users/:id` — profile + memberships + refresh-token families + lock state.
- `GET /admin/orgs` — list/search all orgs; `GET /admin/orgs/:id` — members + on-demand usage snapshot + effective quotas.
- `GET /admin/orgs/usage` — all orgs' usage (sim jobs/runtime/in-flight, design jobs, storage bytes, parts calls) for the current period; top-consumers view.
- `GET /admin/jobs/simulation` + `/admin/jobs/design` — cross-tenant list/filter by org/status/age; `GET /admin/jobs/{sim,design}/:id` — full detail (netlist, analysisConfig, result, metrics, error) for **any** tenant's job.
- `GET /admin/queues/{simulations,design}/health` — BullMQ depth: waiting/active/failed/stalled counts + longest-waiting age.
- `GET /admin/audit-logs` — search/filter/paginate the AuditLog **platform-wide** (it exists but has no read surface today).
- `GET /admin/health/dashboard` — system-wide deps (DB/Redis/S3) + queue health + error/latency rollup.

---

## Phase 2 — Tenant control (mutations; moderate risk, high ops value — build third)

The day-to-day operator actions. Each is audit-logged (Phase 0).

**Users** (reuse existing lifecycle fields — no schema delta):
- `PATCH /admin/users/:id/lock` — lock/unlock (reuse `User.lockedUntil`).
- `POST /admin/users/:id/logout-all` — revoke all sessions (set `RefreshToken.revokedAt` for all live families).
- `PATCH /admin/users/:id/email-verified` — override (reuse `User.emailVerified`); `POST .../force-reset-password`.
- `PATCH /admin/users/:id/role` — promote/demote platformRole (Phase 0 enum).

**Orgs:**
- `PATCH /admin/orgs/:id` — rename.
- `PATCH /admin/orgs/:id/suspend` — suspend/reinstate. **Delta:** `Organization.suspendedAt DateTime?` + `suspendReason String?`; the quota/enqueue gates + a guard on tenant writes check it → `403 ORGANIZATION_SUSPENDED` (reads still allowed).
- `POST|DELETE|PATCH /admin/orgs/:id/members` — manage memberships in any org (reuse `OrgsService` + `OrgMembership`).

**Jobs:**
- `POST /admin/jobs/simulation/:id/cancel` + `/retry`; same for design. (RUNNING-cancel reuses the existing cooperative-abort path; retry re-enqueues.)

**Quotas** — the headline gap (quotas are `QUOTA_*` **env-global** today, no per-org override):
- `PATCH /admin/orgs/:id/quota` — set per-org overrides. **Delta:** `OrgQuotaOverride` table `{ orgId @unique, simConcurrent Int?, simJobsPerMonth Int?, simRuntimeMsPerMonth Int?, designConcurrent Int?, designJobsPerMonth Int?, storageBytes Int?, partsCallsPerMonth Int? , updatedAt }`. `UsageService.limit()` reads the override first, falls back to env. This is the single most-requested ops lever.
- `POST /admin/orgs/:id/usage/:metric/reset` — corrective reset (refund / quota-bug fix).

---

## Phase 3 — Platform control & runtime ops (bigger surface / higher blast radius — build fourth)

- **Worker kill-switch:** `POST /admin/workers/{simulation,design}/pause|resume` — cleanest mechanism is BullMQ `queue.pause()/resume()` (pauses consumption; in-flight drains). No custom signaling needed.
- **Queue maintenance:** `POST /admin/queues/:name/purge` (obliterate stuck/orphaned entries — recall the dry-run's stale-queue cruft) + requeue. Audit each action.
- **Runtime config without redeploy** — `GET|PATCH /admin/config`. **Delta:** `RuntimeConfig` singleton `{ llmModel, simTimeoutMs, simSandboxMode, rateLimitLimit/Ttl, designMcEnabled, designMaxRounds, readOnlyMode, maintenance {active,message,eta}, featureFlags Json, updatedBy, updatedAt, changelog Json }`. **Cost/caveat:** the API + worker must read these from the DB (cached + invalidated) instead of env at point-of-use — a real env→DB-config refactor, do it deliberately. Includes a **maintenance / read-only mode** (a guard rejects writes with `503` + banner).
- **Platform templates:** `POST|GET|PATCH|DELETE /admin/templates` — curate the public starter catalog every tenant sees. **Delta:** `Template.isFeatured Boolean` + `creatorId String?` (reuse `orgId=null` = public).
- **Catalog ops:** `POST /admin/parts/cache/invalidate` + `GET /admin/parts/health` (TME token expiry / last-sync / error rate — add `lastTokenFetchAt`/`lastTokenFetchError` to the token cache). Optional `GET /admin/assets` + `/admin/orgs/:id/assets` (view/aggregate storage; admin-delete an asset).

---

## Phase 4 — Compliance & lifecycle (destructive — most caution; build last / as-needed)

- **GDPR export:** `POST /admin/users/:id/export` → background job + S3 signed-URL `.zip` (circuits, projects, sim results, audit events).
- **GDPR erase (soft):** `POST /admin/users/:id/erase` + `/admin/orgs/:id/erase`. **Delta:** `User.deletedAt`, `Organization.deletedAt` (indexed) + queries filter them; choose audit-preservation vs anonymize (`RefreshToken.anonymizedAt`, `AuditLog.anonymizedAt`). Prefer **soft-delete**; hard `DELETE /admin/users/:id` (full cascade) only as an explicit escalation.
- **Audit retention:** `POST /admin/audit-logs/retention` — retention days + purge schedule + exclude-security-events. **Delta:** `AuditLogRetentionPolicy` + a cron/worker purge.
- **Impersonation / act-as** (support debugging) — **highest risk; defer or gate to `ADMIN` only.** If built: short-TTL token with no refresh family, every acted request stamped `meta.adminActorId`, loud audit + banner. Optional `User.lastActedAsAt`.

---

## Cross-cutting rules (apply to every endpoint)

1. **Audit everything that mutates** (Phase 0 rule) — the admin trail is itself a compliance artifact.
2. **Soft-delete over hard-delete**; destructive routes require an explicit confirm flag and are `ADMIN`-only.
3. **Least privilege via `platformRole`:** SUPPORT ⊂ read (Phase 1), OPERATOR ⊂ mutate (Phase 2–3), ADMIN ⊂ destructive/config (Phase 3 config + Phase 4).
4. **Rate-limit + (ideally) MFA + IP allowlist** on `/admin/*` — it is the platform's privilege-escalation crown-jewels.
5. **Suspension/soft-delete/quota gates** must be enforced in the SHARED path (UsageService + a tenant-write guard), not per-controller, so a suspended org or over-quota tenant is blocked everywhere at once.

---

## Consolidated schema deltas

| Delta | Enables | Phase |
|---|---|---|
| `User.platformRole` enum (+ JWT claim) | admin identity + graduated access | 0 |
| `AuditLog.adminActorId String?` | attributable admin trail | 0 |
| `Organization.suspendedAt` + `suspendReason` | suspend/reinstate an org | 2 |
| `OrgQuotaOverride` table | per-org quota overrides (env-global today) | 2 |
| `Template.isFeatured` + `creatorId?` | platform template curation | 3 |
| `RuntimeConfig` singleton (+ env→DB read refactor) | change model/limits/maintenance without redeploy | 3 |
| TME token-cache `lastTokenFetchAt`/`Error` | catalog health | 3 |
| `User.deletedAt` / `Organization.deletedAt` (soft-delete) | GDPR erase | 4 |
| `AuditLogRetentionPolicy` (+ purge cron) | audit retention | 4 |
| (optional) `QuotaBump`, `UserQuota`, `ConfigOverride`, `GenericModelOverride` | temp bumps, per-user ceilings, non-secret runtime tweaks | later |

---

## Decisions for the founder (before implementation)

1. **`platformRole` enum vs a plain `isPlatformAdmin` boolean?** (Recommended: enum — the least-privilege split pays off across the phases.)
2. **How far to go now?** Recommended first cut = **Phase 0 + Phase 1** (foundation + read-only dashboard): huge operator visibility, near-zero risk, no destructive surface. Phases 2–4 follow as the dashboard needs them.
3. **⚠️ Security-park intersection (honest flag):** Phase 0 IS core authorization — the platform's crown-jewels. You parked broad security work "for now." *Planning* it is safe (done here); *implementing* the admin auth means building that authz layer carefully (guard, JWT claim, MFA/allowlist, admin audit) — that intersects the parked security scope and warrants a focused, reviewed pass (not something to sneak in loosely). Recommend lifting the park **specifically for the admin-auth foundation** when we build Phase 0.

*Full 87-capability inventory (all priorities + per-subsystem detail) is preserved in the audit run output.*
