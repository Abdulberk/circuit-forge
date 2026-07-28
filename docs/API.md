# Circuit Forge — REST API Reference

Complete, source-derived reference for the Circuit Forge backend API (NestJS). Every statement here is grounded in the code under [apps/api/src](../apps/api/src); file links are provided throughout. Where the running code diverges from older docs or from environment configuration, the discrepancy is called out explicitly.

- **Source of truth:** [apps/api/src](../apps/api/src)
- **Verified live:** 2026-07-28 (re-derived from the controllers)

---

## 1. Overview

### Base URL

| Environment | Base URL |
|-------------|----------|
| Default (`.env.example` ships `PORT=3000`) | `http://localhost:3000` |
| If you set `PORT=3001` (see LOCAL_SETUP) | `http://localhost:3001` |

The server binds to `process.env.PORT` (falling back to `3000`) in [main.ts](../apps/api/src/main.ts):

```ts
const port = process.env.PORT || 3000;
await app.listen(port);
```

The shipped `.env.example` sets `PORT=3000`. Some machines move it to 3001 because another local project holds 3000 — that is a per-machine choice, not a repo default, so substitute your own port in the URLs below.

> **Latent config mismatch:** the `API_PORT` variable present in `.env`/compose is **not read anywhere** in the code — only `PORT` is consulted. Setting `API_PORT` alone has no effect.

Config is loaded by `ConfigModule.forRoot` in [app.module.ts](../apps/api/src/app.module.ts) with `isGlobal: true` and `envFilePath: ['.env.local', '.env', '../../.env']` — per-package files win, and the monorepo root `.env` (two levels up) is the fallback.

### Swagger / OpenAPI

Interactive docs are served at **`/docs`** — but only outside production unless `ENABLE_SWAGGER=true` is set, so a deployed instance does not publish its own surface by default. Locally it is always on. It is reached at (e.g. `http://localhost:3001/docs`). Configured in [main.ts](../apps/api/src/main.ts) via `DocumentBuilder`:

- Title: `Circuit Forge API`
- Description: `AI Circuit Generator & Simulator API`
- Version: `1.0`
- Bearer auth registered (`.addBearerAuth()`), surfaced in Swagger UI as an "Authorize" button.

### Global ValidationPipe

A single global `ValidationPipe` is applied in [main.ts](../apps/api/src/main.ts):

```ts
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
);
```

| Option | Value | Effect |
|--------|-------|--------|
| `whitelist` | `true` | Strips any request-body properties not declared on the DTO. |
| `forbidNonWhitelisted` | `true` | Rejects (400) requests that contain properties not declared on the DTO, rather than silently stripping. |
| `transform` | `true` | Transforms payloads into DTO class instances and coerces primitive types (e.g. query `limit`/`offset` strings → numbers via `@Type(() => Number)`). |

All `class-validator` decorators on the DTOs (documented per endpoint below) are enforced by this pipe. Validation failures produce HTTP `400` with the standard Nest error envelope.

### CORS

CORS is enabled with an **explicit origin allowlist** in [main.ts](../apps/api/src/main.ts) (lines 56–68): the allowed origins come from the comma-separated `CORS_ORIGINS` env var; if it's unset, the server falls back to the localhost dev origins `http://localhost:3000` and `http://localhost:5173` — never a wildcard. `credentials: true`, methods `GET, POST, PUT, PATCH, DELETE, OPTIONS`, allowed headers `Content-Type, Authorization`, `maxAge: 3600`.

```ts
const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',').map((o) => o.trim()).filter(Boolean);
app.enableCors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 3600,
});
```

### Rate limiting (throttler)

Global throttling is configured in [app.module.ts](../apps/api/src/app.module.ts) via `ThrottlerModule.forRoot([...])` with two named tiers, and is **enforced globally** via a global `ThrottlerGuard` bound through `APP_GUARD` (app.module.ts:71):

| Tier name | `ttl` (ms) | `limit` (requests) | Meaning |
|-----------|-----------:|-------------------:|---------|
| `default` | `60000` | `120` | Sustained per-route budget. Routes with no `@Throttle` decorator inherit this — 120 requests per 60 seconds. |
| `burst` | `1000` | `30` | Universal short-window guard against hammering; not route-overridable — max 30 requests per 1 second. |

Every `@Throttle({ default: { limit, ttl } })` decorator on a specific route overrides the `default` tier's limit/ttl for that route only (the `burst` tier still applies underneath). Throttling is disabled under `NODE_ENV=test` (`skipIf`) so test suites firing request bursts from one IP aren't rate-limited. Per-route overrides seen in the code include quick-sim (10/60s), version-based simulation (30/60s), AI generate/edit (5/60s), explain-circuit (10/60s), agentic design (3/60s), verify-design (10/60s), and netlist/parts import-export-search routes (30/60s, parts facets 60/60s).

### Error envelope

A global `AllExceptionsFilter` normalizes **every** error response — the framework shape is not what reaches the client. `error` is stripped; `code` is always present:

```json
{
  "statusCode": 400,
  "code": "BAD_REQUEST",
  "message": ["email must be an email"],
  "timestamp": "2026-07-28T09:12:44.101Z",
  "path": "/auth/register"
}
```

Structured fields thrown by a service are preserved alongside those keys, which is how a quota rejection
carries its detail:

```json
{
  "statusCode": 429, "code": "QUOTA_EXCEEDED",
  "metric": "layout_concurrent", "used": 2, "limit": 2, "period": "2026-07",
  "message": "Quota exceeded for layout_concurrent: 2 of 2 used this period."
}
```

**Branch on `code`, not on `error`** (which no longer exists) and not on the message text. A 429 is either
`QUOTA_EXCEEDED` (an org limit) or `TOO_MANY_REQUESTS` (the IP throttle) — different remedies, so clients
must distinguish them. On an unexpected 500 the real error is logged server-side only and `message` stays
`"Internal server error"`.

Exceptions thrown by services map to these status codes:

| Status | Thrown by | Typical cause |
|-------:|-----------|---------------|
| 400 | `BadRequestException`, `ValidationPipe`, `ParseUUIDPipe` | Invalid body/query, malformed UUID path param, asset not in storage. |
| 401 | `UnauthorizedException`, `JwtAuthGuard` | Missing/invalid/expired access token; bad credentials; invalid refresh token. |
| 403 | `ForbiddenException` | Not a member of the org, or insufficient role. |
| 404 | `NotFoundException` | Resource not found (or membership-gated "not found or access denied"). |
| 409 | `ConflictException` | Email already registered. |

---

## 2. Authentication & Authorization Model

### Token model

Authentication is JWT-based. Tokens are produced by `AuthService.generateTokens` in [auth.service.ts](../apps/api/src/auth/auth.service.ts).

| Token | Signing secret | Expiry | Where configured |
|-------|----------------|--------|------------------|
| **Access token** | `JWT_SECRET` | `15m` | `JwtModule.registerAsync` signOptions in [auth.module.ts](../apps/api/src/auth/auth.module.ts) |
| **Refresh token** | `JWT_REFRESH_SECRET` | `7d` | per-call `signAsync` override in [auth.service.ts](../apps/api/src/auth/auth.service.ts) |

JWT payload (`JwtPayload` in [auth.service.ts](../apps/api/src/auth/auth.service.ts)):

```ts
{ sub: string /* user id */, email: string }
```

Access tokens carry `{ sub, email }`. **Refresh tokens additionally carry a `jti`** that keys a server-side
`RefreshToken` row — refresh is stateful, not just a second signature.

### Password hashing

Passwords are hashed with **argon2** (`argon2.hash`) on register and verified with `argon2.verify` on login — see [auth.service.ts](../apps/api/src/auth/auth.service.ts). The hash is stored in `User.passwordHash` ([schema.prisma](../apps/api/prisma/schema.prisma)). Plaintext passwords are never stored.

### Register / login / refresh / logout flow

1. **Register** (`POST /auth/register`): creates the `User` (with argon2 hash), then creates a **personal organization** named `"<name>'s Workspace"` with an `OrgMembership` of role `OWNER` for the new user, then returns access + refresh tokens. Duplicate email → `409 Conflict`.
2. **Login** (`POST /auth/login`): looks up user by email, verifies password with argon2, returns tokens. Any failure → `401` with generic `"Invalid credentials"`.
3. **Refresh** (`POST /auth/refresh`): **rotating and single-use.** Every refresh JWT has a server-side row
   keyed by its `jti`. The row is claimed atomically and a fresh access + refresh pair is issued; the old
   refresh token is dead the moment it is used.

   > **Clients must store the NEW refresh token and never replay the old one.** Presenting an
   > already-used token is treated as theft: the **entire token family is revoked** and the event is
   > audited, logging that session out everywhere. A client that keeps re-sending its original refresh
   > token destroys its own session on the second call.

   Bad signature, missing `jti`, no row, hash mismatch, expired, or already revoked → `401`.
4. **Logout** (`POST /auth/logout`): **server-side and stateful.** Takes a body — `LogoutDto
   { refreshToken?, allDevices? }` — verifies the token (expired ones are still accepted, so a stale
   session can be cleaned up) and revokes its family, or every session for the user when `allDevices` is
   true. Returns `204 No Content`. Sending no body is a no-op.
5. **Account lifecycle**: `POST /auth/verify-email`, `/auth/resend-verification`, `/auth/forgot-password`,
   `/auth/reset-password` — each `204 No Content` with its own throttle. The forgot/resend routes answer the
   same 204 whether or not the address exists, so they cannot be used to enumerate accounts.

### Using the Bearer token

Protected endpoints expect the access token in the HTTP `Authorization` header:

```
Authorization: Bearer <accessToken>
```

The `JwtStrategy` ([jwt.strategy.ts](../apps/api/src/auth/strategies/jwt.strategy.ts)) extracts the token with `ExtractJwt.fromAuthHeaderAsBearerToken()`, validates the signature against `JWT_SECRET` (with `ignoreExpiration: false`), then calls `AuthService.validateUser(payload.sub)`. `validateUser` loads the user selecting `{ id, email, name, createdAt }`; if the user no longer exists it throws `401`. The returned object becomes `request.user`.

### Guards

| Guard | File | Behavior |
|-------|------|----------|
| `JwtAuthGuard` | [jwt-auth.guard.ts](../apps/api/src/auth/guards/jwt-auth.guard.ts) | Extends `AuthGuard('jwt')`. Honors the `@Public()` metadata key (`IS_PUBLIC_KEY`) via `Reflector` — if a handler/class is marked public it bypasses auth. Otherwise requires a valid access token, else `401`. |
| `LocalAuthGuard` | [local-auth.guard.ts](../apps/api/src/auth/guards/local-auth.guard.ts) | Extends `AuthGuard('local')` (passport-local, `usernameField: 'email'`). **Defined but not attached to any route** — login uses `LoginDto` + `AuthService.login` directly, not this guard. |
| `OptionalJwtAuthGuard` | [optional-jwt-auth.guard.ts](../apps/api/src/auth/guards/optional-jwt-auth.guard.ts) | Extends `AuthGuard('jwt')` but overrides `handleRequest` to return `null` (instead of throwing) when the token is missing/invalid. Used on public-readable template endpoints so anonymous and authenticated callers both work; `request.user` is `null` when unauthenticated. |

### Decorators

| Decorator | File | Purpose |
|-----------|------|---------|
| `@CurrentUser()` | [current-user.decorator.ts](../apps/api/src/auth/decorators/current-user.decorator.ts) | Param decorator returning `request.user` (the object produced by `JwtStrategy.validate`: `{ id, email, name, createdAt }`, or `null` under `OptionalJwtAuthGuard`). |
| `@Public()` | [public.decorator.ts](../apps/api/src/auth/decorators/public.decorator.ts) | `SetMetadata(IS_PUBLIC_KEY, true)` — marks a route to bypass `JwtAuthGuard`. (Defined; not currently applied to any handler.) |

### RBAC roles

Roles live on `OrgMembership.role` (`OrgRole` enum in [schema.prisma](../apps/api/prisma/schema.prisma)):

| Role | Notes |
|------|-------|
| `OWNER` | Assigned to the creator of an organization (register flow and `POST /orgs`). |
| `ADMIN` | Elevated org role. |
| `MEMBER` | Default role (`@default(MEMBER)` in schema). |

There are **two independent role axes**. Tenant roles (`OrgMembership.role`) govern who may touch an org's
data; **platform roles** (`User.platformRole`: `NONE` < `SUPPORT` < `OPERATOR` < `ADMIN`) govern the
cross-tenant operator surface under `/admin/*` and are enforced **declaratively** by `@PlatformRoles(min)` +
`PlatformAdminGuard`, which reads the role live from the database on every request — so revoking access does
not wait for a JWT to expire. See §3.19.

For **tenant** roles there is no `@Roles` decorator or RolesGuard — authorization is enforced imperatively inside services through `OrgsService.checkMembership(orgId, userId, requiredRoles?)` (alias `requireMembership`) in [orgs.service.ts](../apps/api/src/orgs/orgs.service.ts):

- If the user has no membership in the org → `403 Forbidden` (`"Not a member of this organization"`).
- If `requiredRoles` is passed and the membership role is not in it → `403` (`"Insufficient permissions"`).

Role-gated operations in the current code:

| Operation | Required roles |
|-----------|----------------|
| Delete project (`DELETE /projects/:projectId`) | `OWNER`, `ADMIN` |
| Delete template (`DELETE /templates/:templateId`) | `OWNER`, `ADMIN` |
| Delete asset (`DELETE /assets/:assetId`) | `OWNER`, `ADMIN` |

All other org-scoped reads/writes require **membership only** (any role).

---

## 3. Endpoints by Module

Notes that apply to every table:

- **Auth** = whether a valid token is required, plus the guard enforcing it.
- **Role** = role enforced by the service via `checkMembership`/`requireMembership` (membership-only means any role suffices).
- DTO field types and validation come from each module's `dto/index.ts`.
- "Response shape" is derived from the service method actually returning the value (Prisma selects/includes included where relevant).

### 3.1 Auth — `[auth.controller.ts](../apps/api/src/auth/auth.controller.ts)`

Controller prefix: `auth`. No guard on the controller — all routes are open. Login/refresh override the success code to `200`; logout to `204`.

| Method | Path | Auth | Role | Request body | Response |
|--------|------|------|------|--------------|----------|
| POST | `/auth/register` | No | — | `RegisterDto` | `201` `TokensResponse` |
| POST | `/auth/login` | No | — | `LoginDto` | `200` `TokensResponse` |
| POST | `/auth/refresh` | No | — | `RefreshDto` | `200` `TokensResponse` |
| POST | `/auth/logout` | No | — | none | `204` empty body |

**DTOs** ([auth/dto/index.ts](../apps/api/src/auth/dto/index.ts)):

`RegisterDto`
| Field | Type | Validation |
|-------|------|------------|
| `email` | string | `@IsEmail()` |
| `password` | string | `@IsString()` `@MinLength(8)` `@MaxLength(100)` |
| `name` | string | `@IsString()` `@MinLength(1)` `@MaxLength(100)` |

`LoginDto`
| Field | Type | Validation |
|-------|------|------------|
| `email` | string | `@IsEmail()` |
| `password` | string | `@IsString()` |

`RefreshDto`
| Field | Type | Validation |
|-------|------|------------|
| `refreshToken` | string | `@IsString()` |

**`TokensResponse`** (returned by register/login/refresh — see [auth.service.ts](../apps/api/src/auth/auth.service.ts)):

```json
{
  "accessToken": "<jwt, 15m>",
  "refreshToken": "<jwt, 7d>",
  "user": { "id": "...", "email": "...", "name": "..." }
}
```

> The `user` object contains exactly `id`, `email`, `name` — it does **not** include `createdAt` (older docs showed `createdAt`; that is incorrect for these responses). Logout returns an **empty 204** body, not a `{ "message": ... }` object.

### 3.2 Organizations — `[orgs.controller.ts](../apps/api/src/orgs/orgs.controller.ts)`

Controller prefix: `orgs`. Entire controller is `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()` — **all routes require a valid access token**.

| Method | Path | Auth | Role | Request body | Response |
|--------|------|------|------|--------------|----------|
| GET | `/orgs` | Yes (`JwtAuthGuard`) | membership implied | none | `200` array of the caller's orgs |
| POST | `/orgs` | Yes (`JwtAuthGuard`) | — (creator becomes OWNER) | `CreateOrgDto` | `201` created `Organization` |
| GET | `/orgs/:orgId` | Yes (`JwtAuthGuard`) | membership | none | `200` org + `role` |

**DTO** ([orgs/dto/index.ts](../apps/api/src/orgs/dto/index.ts)):

`CreateOrgDto`
| Field | Type | Validation |
|-------|------|------------|
| `name` | string | `@IsString()` `@MinLength(1)` `@MaxLength(100)` |

**Responses** (from [orgs.service.ts](../apps/api/src/orgs/orgs.service.ts)):

- `GET /orgs` → `findAllForUser`: queries the caller's `OrgMembership` rows and returns each org spread with its `role`: `[{ id, name, createdAt, updatedAt, role }]`.
- `POST /orgs` → `create`: creates the org with the caller as an `OWNER` membership and returns the raw `Organization` record: `{ id, name, createdAt, updatedAt }` (the membership is created but **not** included in the response).
- `GET /orgs/:orgId` → `findOne`: requires the caller to have a membership; returns the org spread with `role`: `{ id, name, createdAt, updatedAt, role }`. If no membership exists → `404` (`"Organization not found or access denied"`).

> Older docs showed `members` arrays / nested `membership` objects in these responses — those two responses return the org fields plus a single `role` string. Members are NOT absent from the API, though — `GET /orgs/:orgId/members` lists them, and `PATCH`/`DELETE /orgs/:orgId/members/:userId` change and remove them (OWNER/ADMIN).

### 3.3 Projects — `[projects.controller.ts](../apps/api/src/projects/projects.controller.ts)`

Controller has **no path prefix** (`@Controller()`); full paths are declared per route. Entire controller is `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`.

| Method | Path | Auth | Role | Request body | Response |
|--------|------|------|------|--------------|----------|
| GET | `/orgs/:orgId/projects` | Yes (`JwtAuthGuard`) | membership | none | `200` array of `Project` |
| POST | `/orgs/:orgId/projects` | Yes (`JwtAuthGuard`) | membership | `CreateProjectDto` | `201` created `Project` |
| GET | `/projects/:projectId` | Yes (`JwtAuthGuard`) | membership (of project's org) | none | `200` `Project` + `org` |
| PATCH | `/projects/:projectId` | Yes (`JwtAuthGuard`) | membership | `UpdateProjectDto` | `200` updated `Project` |
| DELETE | `/projects/:projectId` | Yes (`JwtAuthGuard`) | `OWNER` or `ADMIN` | none | `200` `{ "success": true }` |

**DTOs** ([projects/dto/index.ts](../apps/api/src/projects/dto/index.ts)):

`CreateProjectDto`
| Field | Type | Validation |
|-------|------|------------|
| `name` | string | `@IsString()` `@MinLength(1)` `@MaxLength(100)` |
| `description` | string? | `@IsOptional()` `@IsString()` `@MaxLength(2000)` |

`UpdateProjectDto`
| Field | Type | Validation |
|-------|------|------------|
| `name` | string? | `@IsOptional()` `@IsString()` `@MinLength(1)` `@MaxLength(100)` |
| `description` | string? | `@IsOptional()` `@IsString()` `@MaxLength(2000)` |

**Responses** (from [projects.service.ts](../apps/api/src/projects/projects.service.ts)):

- `findAllForOrg`: checks membership, returns the org's projects ordered by `updatedAt desc`. Each `Project` = `{ id, orgId, name, description, createdAt, updatedAt }`.
  **Paginated** — the response is `{ items, total, limit, offset, hasMore }`, not a bare array, and accepts `?limit` (default 50, max 100) and `?offset`. Calling `.map()` on it directly will crash.
- `findOne`: loads the project **including its `org`** (`{ ...project, org: { id, name, createdAt, updatedAt } }`), then checks the caller's membership of `project.orgId`. Missing project → `404`.
- `create`: checks membership, creates and returns the `Project`.
- `update`: re-resolves via `findOne` (membership-checked), conditionally updates `name` and/or `description` (only applies `name` if truthy; applies `description` if `!== undefined`), returns the updated `Project`.
- `delete`: re-resolves via `findOne`, then requires `OWNER`/`ADMIN`, deletes the project (cascades versions per schema). Controller returns `{ "success": true }`.

### 3.4 Versions — `[versions.controller.ts](../apps/api/src/versions/versions.controller.ts)`

No controller prefix; full paths per route. Entire controller is `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`.

| Method | Path | Auth | Role | Request body | Response |
|--------|------|------|------|--------------|----------|
| GET | `/projects/:projectId/versions` | Yes (`JwtAuthGuard`) | membership (via project) | none | `200` array of version summaries |
| POST | `/projects/:projectId/versions` | Yes (`JwtAuthGuard`) | membership (via project) | `CreateVersionDto` | `201` created `ProjectVersion` |
| GET | `/versions/:versionId` | Yes (`JwtAuthGuard`) | membership (via project) | none | `200` `ProjectVersion` + `project` |

**DTO** ([versions/dto/index.ts](../apps/api/src/versions/dto/index.ts)):

`CreateVersionDto`
| Field | Type | Validation |
|-------|------|------------|
| `circuitJson` | object (`Record<string, unknown>`) | `@IsObject()` |
| `uiJson` | object (`Record<string, unknown>`) | `@IsObject()` |

**Responses** (from [versions.service.ts](../apps/api/src/versions/versions.service.ts)):

- `findAllForProject`: authorizes via `ProjectsService.findOne` (membership), returns versions ordered by `versionNumber desc`, **selecting only** `{ id, versionNumber, createdAt, createdByUserId }` (no circuit/UI JSON in the list).
  **Paginated** — `{ items, total, limit, offset, hasMore }` with `?limit`/`?offset`, not a bare array.
- `GET /versions/:versionId/bom` — the aggregated bill of materials for a version. JSON by default, or a CSV attachment when the client asks for it.
- `create`: authorizes via project, computes the next `versionNumber` (`lastVersion.versionNumber + 1`, starting at 1), persists `circuitJson` + `uiJson` with `createdByUserId = caller`, returns the full `ProjectVersion` row: `{ id, projectId, versionNumber, createdByUserId, circuitJson, uiJson, createdAt }`.
- `findOne`: loads the version **including `project`**, authorizes via the project's org membership, returns the full version with the nested `project`. Missing version → `404`.

### 3.5 Templates — `[templates.controller.ts](../apps/api/src/templates/templates.controller.ts)`

Controller prefix: `templates`. Guards are applied **per route** (mixed): list and get use `OptionalJwtAuthGuard` (auth optional); create and delete use `JwtAuthGuard` (auth required). `:templateId` is validated with `ParseUUIDPipe`.

| Method | Path | Auth | Role | Request / query | Response |
|--------|------|------|------|------------------|----------|
| GET | `/templates` | Optional (`OptionalJwtAuthGuard`) | membership **iff** `orgId` query given | query: `ListTemplatesQueryDto` | `200` array of `Template` |
| POST | `/templates` | Yes (`JwtAuthGuard`) | membership **iff** `orgId` in body | `CreateTemplateDto` | `201` created `Template` |
| GET | `/templates/:templateId` | Optional (`OptionalJwtAuthGuard`) | membership **iff** template is org-scoped | path: `templateId` (UUID) | `200` `Template` |
| DELETE | `/templates/:templateId` | Yes (`JwtAuthGuard`) | `OWNER`/`ADMIN` of template's org | path: `templateId` (UUID) | `200` `{ "deleted": true }` |

**DTOs** ([templates/dto/index.ts](../apps/api/src/templates/dto/index.ts)):

`CreateTemplateDto`
| Field | Type | Validation |
|-------|------|------------|
| `orgId` | string? | `@IsOptional()` `@IsUUID()` (omit/null ⇒ public template) |
| `name` | string | `@IsString()` |
| `tags` | string[]? | `@IsOptional()` `@IsArray()` `@IsString({ each: true })` |
| `circuitJson` | object (`Record<string, any>`) | `@IsObject()` |
| `analysisConfig` | object? | `@IsOptional()` — `{ analysis, probes? }`, validated on write (malformed → 400) and persisted, so a template can carry the analysis it is meant to be run with |

`ListTemplatesQueryDto`
| Field | Type | Validation |
|-------|------|------------|
| `orgId` | string? | `@IsOptional()` `@IsUUID()` |
| `tag` | string? | `@IsOptional()` `@IsString()` |
| `limit` | number? | `@IsOptional()` `@Type(() => Number)` `@IsInt()` `@Min(1)` (default 50) |
| `offset` | number? | `@IsOptional()` `@Type(() => Number)` `@IsInt()` `@Min(0)` (default 0) |

**Behavior / responses** (from [templates.service.ts](../apps/api/src/templates/templates.service.ts)):

- `findAll`: if `orgId` is given, the caller must be authenticated **and** a member (anonymous → `403 "Authentication required to view org templates"`), and only that org's templates are returned. Without `orgId`, only **public** templates (`orgId = null`) are returned. Optional `tag` filter uses `tags has tag`. Paginated by `take = limit ?? 50`, `skip = offset ?? 0`, ordered `createdAt desc`. Returns `Template[]` = `{ id, orgId, name, description, tags, circuitJson, createdAt, updatedAt }`.
- `create`: if `orgId` provided, requires membership (any role); else creates a **public** template (MVP allows any authenticated user — code comment notes production would gate this behind an admin role). Returns the created `Template`.
- `findOne`: loads by id; if not found → `404`. If the template is org-scoped, requires the caller to be authenticated (`403` if anonymous) and a member. Public templates are returned to anyone. Returns the `Template`.
- `delete`: `404` if missing; **public templates cannot be deleted** (`403 "Public templates cannot be deleted"`); for org templates requires membership and then `OWNER`/`ADMIN` (`403` otherwise). Returns `{ "deleted": true }`.

> **UUID pitfall (seed data):** `GET /templates/:templateId` and `DELETE /templates/:templateId` run `ParseUUIDPipe` on the path param, and `CreateTemplateDto.orgId`/`ListTemplatesQueryDto.orgId` are `@IsUUID()`. The seeded **public templates** have human-readable IDs like `template-rc-low-pass-filter`, and the seeded **demo org id is `demo-org-id`** ([seed.ts](../apps/api/prisma/seed.ts)) — none of these are valid UUIDs. Consequently: fetching a seeded template by its seed id returns `400` (UUID parse failure), and passing `orgId=demo-org-id` to the templates endpoints fails validation with `400`. List public templates (`GET /templates` with no `orgId`) works fine and returns the 5 seeded templates.

### 3.6 Assets — `[assets.controller.ts](../apps/api/src/assets/assets.controller.ts)`

No controller prefix; full paths per route. Entire controller is `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()` — **all routes require auth**. UUID path params (`orgId`, `assetId`) are validated with `ParseUUIDPipe`. Backed by S3/MinIO via the AWS SDK in [assets.service.ts](../apps/api/src/assets/assets.service.ts) (bucket `S3_BUCKET` default `circuitforge`, endpoint `S3_ENDPOINT` default `http://localhost:9000`).

| Method | Path | Auth | Role | Request / query | Response |
|--------|------|------|------|------------------|----------|
| POST | `/orgs/:orgId/assets/models/presign` | Yes (`JwtAuthGuard`) | membership | `PresignUploadDto` | `201` `{ uploadUrl, s3Key }` |
| POST | `/orgs/:orgId/assets/models/commit` | Yes (`JwtAuthGuard`) | membership | `CommitAssetDto` | `201` created `Asset` |
| GET | `/orgs/:orgId/assets/models` | Yes (`JwtAuthGuard`) | membership | query `type?` | `200` array of `Asset` |
| GET | `/assets/:assetId` | Yes (`JwtAuthGuard`) | membership (of asset's org) | none | `200` `Asset` |
| GET | `/assets/:assetId/download` | Yes (`JwtAuthGuard`) | membership | none | `200` `{ downloadUrl }` |
| DELETE | `/assets/:assetId` | Yes (`JwtAuthGuard`) | `OWNER`/`ADMIN` | none | `200` `{ deleted: true }` |

**DTOs** ([assets/dto/index.ts](../apps/api/src/assets/dto/index.ts)):

`PresignUploadDto`
| Field | Type | Validation |
|-------|------|------------|
| `name` | string | `@IsString()` |
| `contentType` | string | `@IsString()` |
| `sizeBytes` | number | `@IsInt()` `@Min(1)` `@Max(10485760)` (10 MB) |
| `sha256` | string | `@IsString()` `@IsHash('sha256')` |

`CommitAssetDto`
| Field | Type | Validation |
|-------|------|------------|
| `s3Key` | string | `@IsString()` (the key returned by presign) |
| `name` | string | `@IsString()` |
| `contentType` | string | `@IsString()` |
| `sizeBytes` | number | `@IsInt()` `@Min(1)` |
| `sha256` | string | `@IsString()` `@IsHash('sha256')` |

**Behavior / responses** (from [assets.service.ts](../apps/api/src/assets/assets.service.ts)):

- `presignUpload`: requires membership; generates an S3 key `orgs/<orgId>/models/<uuid>/<name>` and a **presigned PUT URL** (`PutObjectCommand`, 1-hour expiry, with `ContentType`/`ContentLength`). Returns `{ uploadUrl, s3Key }`. The client PUTs the file to `uploadUrl` directly.
- `commitAsset`: requires membership; issues a `HeadObjectCommand` to confirm the object exists (`400 "Asset not found in storage..."` if not); enforces the `s3Key` begins with `orgs/<orgId>/` (`400` otherwise); creates an `Asset` row with `type = 'SPICE_MODEL'`. Returns the created `Asset` = `{ id, orgId, type, name, description, contentType, sizeBytes, s3Key, sha256, createdAt }`.
- `listAssets`: requires membership; optional `type` query filters `Asset.type`; returns assets ordered `createdAt desc`.
  **Paginated** — `{ items, total, limit, offset, hasMore }` with `?limit`/`?offset`, not a bare array.
- `getAsset`: loads by id (`404` if missing), then requires membership of the asset's org; returns the `Asset`.
- `getDownloadUrl`: resolves the asset (membership-checked) and returns `{ downloadUrl }` — a **presigned GET URL** (`GetObjectCommand`, 1-hour expiry).
- `deleteAsset`: resolves the asset, requires `OWNER`/`ADMIN` (else `400 "Only admins can delete assets"`), deletes the **DB row only** (the S3 object is intentionally left in place to avoid accidental data loss). Returns `{ deleted: true }`.

### 3.7 Simulation — `[simulation.controller.ts](../apps/api/src/simulation/simulation.controller.ts)`

No controller prefix; full paths per route. Entire controller is `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`. Jobs are dispatched to a BullMQ queue named `simulations` (Redis via `REDIS_URL`, see [simulation.module.ts](../apps/api/src/simulation/simulation.module.ts)) and executed by the separate `worker-sim` service (ngspice). The engine is always `NGSPICE`.

| Method | Path | Auth | Role | Request body | Response |
|--------|------|------|------|--------------|----------|
| POST | `/versions/:versionId/simulations` | Yes (`JwtAuthGuard`) | membership (via version→project→org) | `CreateSimulationDto` | `201` `{ jobId }` — **throttled 30/60s** |
| POST | `/simulations/quick` | Yes (`JwtAuthGuard`) | membership (uses caller's first org) | `QuickSimulationDto` | `201` `{ jobId }` — **throttled 10/60s** |
| GET | `/simulations/:jobId` | Yes (`JwtAuthGuard`) | membership (of job's org) | none | `200` status object |
| GET | `/simulations/:jobId/result` | Yes (`JwtAuthGuard`) | membership (of job's org) | `?maxPoints=N` (10-100000) | `200` result object |

`POST /versions/:versionId/simulations` carries `@Throttle({ default: { limit: 30, ttl: 60000 } })`; `POST /simulations/quick` carries `@Throttle({ default: { limit: 10, ttl: 60000 } })`. Both ride on top of the global `default`/`burst` tiers described in §1.4.

**DTOs** ([simulation/dto/index.ts](../apps/api/src/simulation/dto/index.ts)):

`CreateSimulationDto`
| Field | Type | Validation |
|-------|------|------------|
| `analysisConfig` | object (`Record<string, unknown>`) | `@IsObject()` |
| `probes` | string[]? | `@IsArray()` `@IsString({ each: true })` `@IsOptional()` (e.g. `["v(out)", "v(in)"]`) |
| `modelAssetIds` | string[]? | `@ArrayMaxSize(32)` `@IsOptional()` — uploaded `SPICE_MODEL` assets to `.include` in the run |

`QuickSimulationDto`
| Field | Type | Validation |
|-------|------|------------|
| `netlist` | string | `@IsString()` (raw SPICE netlist) |
| `analysisConfig` | object? | `@IsObject()` `@IsOptional()` |
| `modelAssetIds` | string[]? | `@ArrayMaxSize(32)` `@IsOptional()` — same meaning as above |

**Behavior / responses** (from [simulation.service.ts](../apps/api/src/simulation/simulation.service.ts)):

- `createFromVersion`: resolves the version via `VersionsService.findOne` (membership-checked through the project), generates a netlist from the version's `circuitJson` + `analysisConfig` (and optional `probes`) using `generateNetlist` from `@circuit-forge/eda-core`, persists a `SimulationJob` (`status: QUEUED`, `engine: NGSPICE`, `orgId` from the version's project), enqueues a `simulation` job (`{ jobId, orgId, netlist, probeNames, analysisType, analysisConfig }`, `analysisType` taken from `analysisConfig.type` or defaulting to `'tran'`), and returns **`{ jobId }`**.
- `createQuickSim`: looks up the caller's organizations and uses the **first** one (`404 "No organization found for user"` if none); persists a `SimulationJob` with the **raw provided `netlist`** (no netlist generation) and enqueues it the same way; returns **`{ jobId }`**.
- `getStatus`: loads the job (`404` if missing), checks the caller's membership of `job.orgId`, returns: `{ id, status, createdAt, startedAt, finishedAt, metrics }`.
- `getResult`: loads the job (`404` if missing), checks membership. If `status !== 'SUCCEEDED'` returns `{ id, status, error: stderr }`. If succeeded returns `{ id, status, result, metrics }` — `result` is read from the DB (`resultJson`) and, when that is null because the result spilled to S3 (`resultS3Key` set), hydrated from S3 (`results/{jobId}/result.json`). A fetch/parse failure logs the error and returns `result: null` with an `error: "Result data is currently unavailable from storage."` field.

**Job status values** (`SimJobStatus` enum, [schema.prisma](../apps/api/prisma/schema.prisma)): `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELED`, `TIMED_OUT`.

> **Simulation prerequisite:** ngspice must be installed where `worker-sim` runs (locally `choco install ngspice -y` on Windows). Without it, jobs transition to a failed state and `getResult` returns the `stderr` in the `error` field. A version-based transient simulation has been verified end-to-end on this setup.

### 3.8 AI Generation — `[generation.controller.ts](../apps/api/src/generation/generation.controller.ts)`

No controller prefix; full paths per route. Entire controller is `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`.

| Method | Path | Auth | Role | Request body | Response |
|--------|------|------|------|--------------|----------|
| POST | `/generate-circuit` | Yes (`JwtAuthGuard`) | — | `GenerateCircuitDto` | `201` generated `CircuitJson` — **throttled 5/60s** |
| POST | `/edit-circuit` | Yes (`JwtAuthGuard`) | — | `EditCircuitDto` | `201` edited `CircuitJson` — **throttled 5/60s** |
| POST | `/explain-circuit` | Yes (`JwtAuthGuard`) | — | `ExplainCircuitDto` | `201` plain-language explanation — **throttled 10/60s** |

**DTOs** ([generation/dto/index.ts](../apps/api/src/generation/dto/index.ts)):

`GenerateCircuitDto`: `prompt` (string, 1–2000 chars) + optional `constraints` (string, ≤1000 chars).
`EditCircuitDto`: `circuit` (CircuitJson object) + `instruction` (string, 1–2000 chars) + optional `analysisConfig`/`constraints`.
`ExplainCircuitDto`: `circuit` (CircuitJson object) only.

`generate`/`edit`/`explain` delegate directly to `GenerationService` — AI generation is grounded in the live parts catalog via Anthropic tool-use (`search_parts`/`get_part_details`).

### 3.9 Verification — `[verification.controller.ts](../apps/api/src/generation/verification.controller.ts)`

No controller prefix; full paths per route. Entire controller is `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`.

| Method | Path | Auth | Role | Request body | Response |
|--------|------|------|------|--------------|----------|
| POST | `/verify-design` | Yes (`JwtAuthGuard`) | — | `VerifyDesignDto` | `200` `DesignEvidence` — **throttled 10/60s** |

Deterministic, simulation-backed verification: ERC + ngspice (delegated to the worker queue, server-side-polled so the HTTP response stays synchronous) + spec assertions, returning a pass/fail/inconclusive evidence pack (verdict + measurements + ERC + per-assertion results). A malformed circuit/analysis config is a `400`; a valid circuit that fails verification is a `200` with `verdict: "fail"`. A current-probe assertion on a diode/transistor/subckt terminal (no branch-current vector in ngspice) is rejected with a `400` steering the caller to probe a series sense resistor instead.

**`VerifyDesignDto`** ([generation/dto/index.ts](../apps/api/src/generation/dto/index.ts)): `circuit` (CircuitJson object) + optional `analysisConfig` (defaults to an operating-point analysis) + optional `assertions` (`AssertionDto[]`, max 50) + optional **`robustness`** (`RobustnessDto`).

`robustness` layers tolerance-aware checks on top of the nominal verdict: `corner` / `maxCorners` (1-12, default 8), `montecarlo` with `n` / `seed` / `profile` (`consumer` | `automotive` | `medical`), plus ambient `temperature` and supply-rail sweeps. All of it is **informational and runs only when the nominal verdict is already `pass`** — with the single exception noted in the gating box below.

**`AssertionDto`** fields: `probe` (string, 1–64 chars), `metric` (enum `min | max | final | pp | avg | rms | cutoff | thd | gain`), `op` (enum `lt | lte | gt | gte | approx`), `value` (number, SI base units; Hz for `cutoff`), optional `tol` (default 5% of `|value|` for `op: "approx"`), optional `label`. `avg`/`rms` are time-weighted (trapezoidal over the adaptive timesteps); `cutoff` is the −3 dB corner of an AC magnitude response (requires an `ac` analysis); `thd` is Total Harmonic Distortion in percent (requires a `tran` analysis with a `fourier` request on the probe); `gain` is small-signal DC gain Vout/Vin (requires an `op` analysis with a `tf` request to the probe).

> **Verdict gating:** the verdict comes from ERC errors, the simulation's own status, and **the assertions
> the caller listed** — there is no implicit THD or small-signal-GAIN gate. THD and gain are *measured* and
> reported when the analysis produces them, but they only affect the verdict if the caller asserted on them.
>
> Two cases deliberately answer `inconclusive` rather than `pass`: a run that simulated cleanly but produced
> no measurements, and a run with **no assertions at all** — a spec-less run has nothing to certify, so
> calling it "verified" would be the emptiest possible claim.
>
> The one thing that can flip a passing verdict to `fail` afterwards is the **Monte-Carlo robustness gate**,
> and only on a complete at-risk run whose tolerance spread the caller fully specified. Corner, temperature
> and supply-rail sweeps are informational and never gate.

### 3.10 Design (synchronous) — `[design.controller.ts](../apps/api/src/generation/design.controller.ts)`

No controller prefix; full paths per route. Entire controller is `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`.

| Method | Path | Auth | Role | Request body | Response |
|--------|------|------|------|--------------|----------|
| POST | `/design-circuit` | Yes (`JwtAuthGuard`) | — | `DesignCircuitDto` | `201` design result — **throttled 3/60s** |

Agentic closed-loop design: generate → simulate → AI-fix on failure, for up to `maxRounds` (1–4, default 2). Runs **synchronously** and can hold the HTTP connection for minutes — kept for back-compat; `/design-jobs` (below) is the scalable async alternative.

**`DesignCircuitDto`** ([generation/dto/index.ts](../apps/api/src/generation/dto/index.ts)): `prompt` (string, 1–2000 chars), optional `constraints` (string, ≤1000 chars), optional `maxRounds` (int, 1–4, default 2).

### 3.11 Design Jobs (async LRO) — `[design-jobs.controller.ts](../apps/api/src/generation/design-jobs.controller.ts)`

Controller prefix: `design-jobs`. Entire controller is `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`. `:id` path params are validated with `ParseUUIDPipe`.

| Method | Path | Auth | Role | Request body | Response |
|--------|------|------|------|--------------|----------|
| POST | `/design-jobs` | Yes (`JwtAuthGuard`) | — | `DesignCircuitDto` | `202` `{ jobId, status }` — **throttled 3/60s** |
| GET | `/design-jobs/:id` | Yes (`JwtAuthGuard`) | membership (of job's org) | none | `200` status + (when finished) full design result |
| DELETE | `/design-jobs/:id` | Yes (`JwtAuthGuard`) | membership (of job's org) | none | `200` cancel outcome |

The long-running-operation contract for agentic design: `POST` enqueues onto a **durable BullMQ `design` queue** and returns `202` immediately with a job id; a dedicated worker runs the agentic loop and persists the outcome onto the `DesignJob` row (an API deploy/crash no longer abandons in-flight work). The client polls `GET` until a terminal status. `DELETE` cancels — `QUEUED` jobs are canceled outright, `RUNNING` jobs receive a cooperative abort signal. `maxRounds` is clamped server-side to 1–4 (default 2).

### 3.12 Netlist — `[netlist.controller.ts](../apps/api/src/netlist/netlist.controller.ts)`

Controller prefix: `netlist`. Entire controller is `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`. Both routes throttled `30/60s`.

| Method | Path | Auth | Role | Request body | Response |
|--------|------|------|------|--------------|----------|
| POST | `/netlist/import` | Yes (`JwtAuthGuard`) | — | `ImportNetlistDto` | `201` parsed `CircuitJson` + analysis + warnings + schema verdict — **throttled 30/60s** |
| POST | `/netlist/export` | Yes (`JwtAuthGuard`) | — | `ExportNetlistDto` | `201` `text/plain` SPICE deck (`Content-Disposition: attachment; filename="circuit.cir"`) — **throttled 30/60s** |

`import`: parses a standard SPICE netlist (LTspice/KiCad/ngspice deck, max 200 KB) into `CircuitJson`, including analog **and** digital/XSPICE (`CFD_*` models), preserving `.model`/`.subckt`/`.options`/`.ic` cards and re-merging split mixed-signal nets. `export`: generates a self-contained SPICE deck from `CircuitJson` with generic model bodies inlined, given an optional `analysisConfig` (defaults to `{ type: "op" }`) and optional explicit `probes` (defaults to one voltage probe per node, max 100).

**DTOs** ([netlist/dto/index.ts](../apps/api/src/netlist/dto/index.ts)):

`ImportNetlistDto`: `netlist` (string, 1–200,000 chars).
`ExportNetlistDto`: `circuitJson` (object) + optional `analysisConfig` (object) + optional `probes` (string[], max 100).

### 3.13 Parts (component catalog) — `[parts.controller.ts](../apps/api/src/parts/parts.controller.ts)`

Controller prefix: `parts`. Entire controller is `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`. Literal routes (`search`/`manufacturers`/`categories`) are declared before the `:symbol` wildcard route.

| Method | Path | Auth | Role | Request / query | Response |
|--------|------|------|------|------------------|----------|
| GET | `/parts/search` | Yes (`JwtAuthGuard`) | — | query `SearchPartsDto` | `200` search results — **throttled 30/60s**, metered |
| GET | `/parts/manufacturers` | Yes (`JwtAuthGuard`) | — | none | `200` manufacturers + product counts — **throttled 60/60s**, unmetered |
| GET | `/parts/categories` | Yes (`JwtAuthGuard`) | — | none | `200` category tree + product counts — **throttled 60/60s**, unmetered |
| GET | `/parts/:symbol` | Yes (`JwtAuthGuard`) | — | path `symbol` | `200` part detail (params, pricing tiers, stock, datasheet) — **throttled 30/60s**, metered |
| GET | `/parts/:symbol/component` | Yes (`JwtAuthGuard`) | — | path `symbol` | `200` `CircuitJson` component (+ `simulatable` flag) — **throttled 30/60s**, metered |

Backed by the TME v2 OAuth parts catalog. `search`/`:symbol`/`:symbol/component` are metered **per request** (cache hits included — the billable unit is the API request, not the upstream TME call) via `UsageService.assertAndCountPartsCall`, gated only when `QUOTA_PARTS_CALLS_PER_MONTH` is set; the facet routes (`manufacturers`/`categories`) are intentionally unmetered. `search` results include a numeric `total` (`data.products.amount`); each `CatalogPart` carries a `categoryId` as its primary classification signal.

**`SearchPartsDto`** ([parts/dto/index.ts](../apps/api/src/parts/dto/index.ts)): `q` (string, 1–100 chars) + optional `manufacturerId`/`categoryId` (string, ≤50 chars) + optional `page` (int, 1–1000, default 1).

### 3.14 Usage — `[usage.controller.ts](../apps/api/src/usage/usage.controller.ts)`

No controller prefix; full path declared on the route. Entire controller is `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`.

| Method | Path | Auth | Role | Request | Response |
|--------|------|------|------|---------|----------|
| GET | `/orgs/:orgId/usage` | Yes (`JwtAuthGuard`) | membership | path `orgId` (UUID) | `200` `OrgUsage` |

Current-month usage snapshot for the frontend's usage page: sim jobs/runtime-ms/in-flight count, agentic design jobs/in-flight count, asset+result storage bytes, and parts-catalog calls (the requesting user's calls this period) — each paired with its configured limit (`null` = unlimited). Sim runtime, sim/design in-flight counts, and storage are aggregated on-demand from their source tables (never drift-prone counters); parts calls use a `UsageRecord` counter row (no natural source table). Periods are UTC calendar months (`'YYYY-MM'`). Quota violations elsewhere in the API throw `429` with a structured body: `{ code: 'QUOTA_EXCEEDED', metric, used, limit, period }`.

### 3.16 PCB layout — `[layout.controller.ts](../apps/api/src/layout/layout.controller.ts)`

Controller prefix: `layouts`. JWT required. A long-running operation: `POST` returns immediately and the
client polls `GET /layouts/:id`. The pipeline (freerouting + KiCad DRC) runs in `apps/pcb-worker` off the
`pcb-layout` queue; this controller owns only the row lifecycle and presigning the artifacts.

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| POST | `/layouts` | JWT, 5/60s | `CreateLayoutDto` | **202** `{ jobId, status, orgId }` |
| GET | `/layouts` | JWT | `?versionId&projectId&limit&offset` | 200 pagination envelope |
| GET | `/layouts/:id` | JWT + org membership | — | 200 job + presigned URLs |

`CreateLayoutDto` is **closed** — an unknown key is a 400, not a silent ignore:

| Field | Type | Notes |
|---|---|---|
| `circuit` | object | required — OUR CircuitJson |
| `versionId` | uuid? | tags the layout to a saved version; its project's org becomes the owner |
| `orgId` | uuid? | ad-hoc layouts only; membership is verified. Conflicting with `versionId` → 400 |
| `placer` | `grid` \| `auto` \| `rust` | placement engine |
| `fabProfile` | `FabProfileDto`? | `tier` (`economy`\|`standard`\|`advanced`) + bounded numeric overrides |
| `netCurrentsA` | `Record<string, number>`? | RMS current per emitted net → IPC-2221 width. **Every value must be a positive finite number**; `"2A"` or `-1` is a 400 naming the net |

Overrides in `fabProfile` may only make a board **easier** to manufacture than the tier it names: a value
below the tier limit is raised to it and the adjustment is reported in the result. A finer process is
reached by naming a finer `tier`.

**When `orgId` and `versionId` are both omitted the org is a GUESS** — the caller's first membership,
which is their personal workspace. That is why the resolved org is echoed in the 202 and present on every
response: a caller can see where the layout actually landed.

List rows carry `manufacturable` (`true` \| `false` \| `null`): `null` while the job has no verdict yet
(queued, running, failed), so a grid can badge outcomes without fetching each detail blob. A rejected
board and a certified one **both** finish as `SUCCEEDED` with no `errorMessage` — only this field tells
them apart.

`GET /layouts/:id` returns `{ id, orgId, projectId, versionId, status, result, errorMessage, glbUrl,
gerbersUrl, createdAt, startedAt, finishedAt }`. The two URLs are presigned (1 h) and **absent unless the
board was certified manufacturable** — a DRC-rejected board never yields a downloadable bundle.

Notable `result` fields (see [FRONTEND_PCB_EDITOR_BRIEF.md](../FRONTEND_PCB_EDITOR_BRIEF.md) for the full
shape): `manufacturable`, `notManufacturableReason`, `drcClean`, `layout` (2D geometry), `checks`,
`airwires`, `fab` (the resolved tier + profile the board was actually built and judged by), `delivery`
(which router and placement engine produced it, and why the requested one was not used), `diagnostics`,
and `scope`.

Admission control: PCB layout is the one quota that **binds by default** — 2 in-flight jobs per org
(`QUOTA_LAYOUT_CONCURRENT_PER_ORG`, `0` = unlimited). A layout is minutes of CPU and the worker drains one
at a time, so an unbounded queue would let one tenant starve every other org.

---

### 3.17 Invitations — `[invitations.controller.ts](../apps/api/src/invitations/invitations.controller.ts)`

No controller prefix — routes are absolute. This is the self-serve path for adding members.

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| POST | `/orgs/:orgId/invitations` | JWT + OWNER/ADMIN | `CreateInvitationDto { email, role? }` | 201 invitation (sends the email) |
| GET | `/orgs/:orgId/invitations` | JWT + OWNER/ADMIN | `?limit&offset` | 200 pagination envelope |
| DELETE | `/orgs/:orgId/invitations/:invitationId` | JWT + OWNER/ADMIN | — | **204** (revoke) |
| POST | `/invitations/accept` | JWT | `{ token }` | **200** — joins the caller to the org |

---

### 3.18 Working copy (autosave) — `[working-copy.controller.ts](../apps/api/src/working-copy/working-copy.controller.ts)`

No controller prefix. The editor's **draft** state, separate from committed versions: an editor autosaves
here continuously and creates a `ProjectVersion` only when the user deliberately saves.

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| PUT | `/projects/:projectId/working-copy` | JWT + org membership | `SaveWorkingCopyDto { circuitJson, uiJson, baseVersionId? }` | 200 — idempotent upsert |
| GET | `/projects/:projectId/working-copy` | JWT + org membership | — | 200 draft, or `null` when none |
| DELETE | `/projects/:projectId/working-copy` | JWT + org membership | — | **200** (discard the draft) |

`baseVersionId` records which version the draft was branched from, so a client can detect that the
underlying version moved on while the draft was open.

---

### 3.19 Platform admin — `[admin.controller.ts](../apps/api/src/admin/admin.controller.ts)`

Controller prefix: `admin`. **A cross-tenant operator surface — these routes deliberately ignore org
membership**, so they are gated on a second, independent role axis: `User.platformRole`
(`NONE` < `SUPPORT` < `OPERATOR` < `ADMIN`), enforced declaratively by `@PlatformRoles(min)` +
`PlatformAdminGuard`. The guard reads the role **live from the database** on every request, so revoking
someone's access does not wait for their JWT to expire. The class default is `SUPPORT`; mutations raise it.

Every mutation is written to `AuditLog` through a central service with the request id and a before/after
snapshot. Audit rows **outlive their subject** (`userId` is `SetNull`), so deleting a user cannot erase
the record of what was done to their account.

31 routes. By capability:

| Capability | Routes | Min role |
|---|---|---|
| Read: self, users, orgs, org usage | `GET /admin/me`, `/admin/users[/:id]`, `/admin/orgs[/:id]`, `/admin/orgs/usage` | SUPPORT |
| Read: jobs, queues, audit, dashboard | `GET /admin/jobs/simulation[/:id]`, `/admin/jobs/design[/:id]`, `/admin/queues/health`, `/admin/audit-logs`, `/admin/health/dashboard` | SUPPORT |
| User account control | `PATCH /admin/users/:id/lock`, `POST /admin/users/:id/logout-all`, `PATCH /admin/users/:id/email-verified` | OPERATOR |
| Org control | `PATCH /admin/orgs/:id`, `PATCH /admin/orgs/:id/suspend`, member add/change/remove, `PATCH`/`DELETE /admin/orgs/:id/quota` | OPERATOR |
| Job intervention | `POST /admin/jobs/simulation/:id/{cancel,retry}`, `POST /admin/jobs/design/:id/cancel` | OPERATOR |
| Storage | `POST /admin/storage/sweep-orphan-models` | OPERATOR |
| Queue kill switch | `POST /admin/queues/:name/{pause,resume,purge}` | ADMIN |
| Role change | `PATCH /admin/users/:id/role` | ADMIN |

`:name` is one of `simulations`, `design`, `pcb-layout`. Purge only removes **terminal** history
(`completed`, `failed`) — never `active` (a running job) or `wait`/`delayed` (pending work a purge would
silently cancel).

---

### 3.15 Health — `[health.controller.ts](../apps/api/src/health/health.controller.ts)`

Controller prefix: `health`. No guards — all routes are public. No request body or params.

| Method | Path | Auth | Response |
|--------|------|------|----------|
| GET | `/health` | No | `200` `{ status: "ok", timestamp, service: "circuit-forge-api" }` |
| GET | `/health/ready` | No | **`200` or `503`** — readiness object (overall `status` + `checks`) |
| GET | `/health/live` | No | `200` `{ status: "ok", timestamp }` |

`GET /health/ready` probes **three** dependencies concurrently — Postgres, Redis and S3 — so the check costs
the slowest of them rather than their sum, and reports per-dependency status and latency:

```json
{
  "status": "ok",
  "timestamp": "2026-05-29T00:00:00.000Z",
  "service": "circuit-forge-api",
  "checks": {
    "database": { "status": "ok", "latencyMs": 5 },
    "redis": { "status": "ok", "latencyMs": 1 },
    "s3": { "status": "ok", "latencyMs": 12 }
  }
}
```

**When ANY check fails the handler returns HTTP `503`** (same payload shape, with that check's `status` set
to `"error"` plus an `error` message). That is what makes it usable as a Kubernetes readiness probe — an
orchestrator reads the status code, not the body. Use `/health/live` for liveness: it answers `200` as long
as the process is up, and must NOT be pointed at dependencies, or a database blip would restart healthy pods.

---

## 4. Example: login + authenticated request (curl, port 3001)

Using the seeded demo credentials (`demo@circuitforge.io` / `demo123456`, [seed.ts](../apps/api/prisma/seed.ts)).

### 1. Log in to get tokens

```bash
curl -s -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@circuitforge.io","password":"demo123456"}'
```

Response (`200`):

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": { "id": "<uuid>", "email": "demo@circuitforge.io", "name": "Demo User" }
}
```

### 2. Call a protected endpoint with the access token

```bash
# Save the access token, then list the caller's organizations:
TOKEN="<paste accessToken here>"

curl -s http://localhost:3001/orgs \
  -H "Authorization: Bearer $TOKEN"
```

Response (`200`):

```json
[
  { "id": "demo-org-id", "name": "Demo Organization", "createdAt": "...", "updatedAt": "...", "role": "OWNER" }
]
```

### 3. List public templates (no auth needed)

```bash
curl -s "http://localhost:3001/templates"
```

Returns the 5 seeded public templates (RC Low-Pass Filter, Voltage Divider, Diode Rectifier, LC Oscillator, RC Integrator).

### 4. Refresh the access token

```bash
curl -s -X POST http://localhost:3001/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<paste refreshToken here>"}'
```

> PowerShell users: use `Invoke-RestMethod` (e.g. `Invoke-RestMethod -Method Post -Uri http://localhost:3001/auth/login -ContentType 'application/json' -Body '{"email":"demo@circuitforge.io","password":"demo123456"}'`), or call `curl.exe` explicitly so PowerShell does not alias it to `Invoke-WebRequest`.

---

## See also

- [README.md](../README.md) — project overview, quick start, scripts
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — system architecture, data flow, env vars
- [docs/API.md](API.md) — this document
- [docs/DATA_MODEL.md](DATA_MODEL.md) — Prisma data model reference *(planned; see [schema.prisma](../apps/api/prisma/schema.prisma) in the meantime)*
- [docs/EDA_CORE.md](EDA_CORE.md) — `eda-core`/`llm-core` internals *(planned)*
- [docs/SIMULATION.md](SIMULATION.md) — worker pipeline, ngspice execution, result storage
- [docs/SECURITY.md](SECURITY.md) — auth, RBAC, validation, rate limiting, sandboxing
- [LOCAL_SETUP.md](../LOCAL_SETUP.md) — verified local setup, daily run, troubleshooting
