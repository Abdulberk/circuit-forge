# Circuit Forge — REST API Reference

Complete, source-derived reference for the Circuit Forge backend API (NestJS). Every statement here is grounded in the code under [apps/api/src](../apps/api/src); file links are provided throughout. Where the running code diverges from older docs or from environment configuration, the discrepancy is called out explicitly.

- **Source of truth:** [apps/api/src](../apps/api/src)
- **Verified live:** 2026-05-29

---

## 1. Overview

### Base URL

| Environment | Base URL |
|-------------|----------|
| Local (this repo) | `http://localhost:3001` |
| Default if `PORT` unset | `http://localhost:3000` |

The server binds to `process.env.PORT` (falling back to `3000`) in [main.ts](../apps/api/src/main.ts):

```ts
const port = process.env.PORT || 3000;
await app.listen(port);
```

Locally the repo sets `PORT=3001` in the monorepo root `.env` (port 3000 was taken by another project), so the API listens on **`http://localhost:3001`**.

> **Latent config mismatch:** the `API_PORT` variable present in `.env`/compose is **not read anywhere** in the code — only `PORT` is consulted. Setting `API_PORT` alone has no effect.

Config is loaded by `ConfigModule.forRoot` in [app.module.ts](../apps/api/src/app.module.ts) with `isGlobal: true` and `envFilePath: ['.env.local', '.env', '../../.env']` — per-package files win, and the monorepo root `.env` (two levels up) is the fallback.

### Swagger / OpenAPI

Interactive docs are served at **`/docs`** (e.g. `http://localhost:3001/docs`). Configured in [main.ts](../apps/api/src/main.ts) via `DocumentBuilder`:

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

CORS is enabled with **no options** in [main.ts](../apps/api/src/main.ts): `app.enableCors();`. This applies Nest/Express defaults — effectively reflecting the request origin (all origins allowed), default allowed methods, credentials not enabled. There is no origin allowlist configured in code.

### Rate limiting (throttler)

Global throttling is configured in [app.module.ts](../apps/api/src/app.module.ts) via `ThrottlerModule.forRoot([...])` with two named tiers:

| Tier name | `ttl` (ms) | `limit` (requests) | Meaning |
|-----------|-----------:|-------------------:|---------|
| `short` | `1000` | `10` | Max 10 requests per 1 second. |
| `medium` | `60000` | `120` | Max 120 requests per 60 seconds. |

> **Important:** `ThrottlerModule` is registered, but **no global `ThrottlerGuard` is applied** (there is no `APP_GUARD` provider and no app-level `useGlobalGuards`). As written, the two tiers above are **not enforced globally**. The only place throttling is actively bound is the simulation **quick-sim** endpoint, which uses the `@Throttle` decorator (see [simulation.controller.ts](../apps/api/src/simulation/simulation.controller.ts)):

```ts
@Throttle({ default: { limit: 10, ttl: 60000 } })
```

i.e. 10 quick simulations per 60 seconds. Other endpoints are not rate-limited by the current code.

### Error envelope

Errors use the standard NestJS `HttpException` shape, e.g.:

```json
{ "statusCode": 400, "message": ["email must be an email"], "error": "Bad Request" }
```

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

Both access and refresh tokens carry the **same** payload `{ sub, email }`; they differ only by secret and expiry.

### Password hashing

Passwords are hashed with **argon2** (`argon2.hash`) on register and verified with `argon2.verify` on login — see [auth.service.ts](../apps/api/src/auth/auth.service.ts). The hash is stored in `User.passwordHash` ([schema.prisma](../apps/api/prisma/schema.prisma)). Plaintext passwords are never stored.

### Register / login / refresh / logout flow

1. **Register** (`POST /auth/register`): creates the `User` (with argon2 hash), then creates a **personal organization** named `"<name>'s Workspace"` with an `OrgMembership` of role `OWNER` for the new user, then returns access + refresh tokens. Duplicate email → `409 Conflict`.
2. **Login** (`POST /auth/login`): looks up user by email, verifies password with argon2, returns tokens. Any failure → `401` with generic `"Invalid credentials"`.
3. **Refresh** (`POST /auth/refresh`): verifies the supplied `refreshToken` against `JWT_REFRESH_SECRET`, reloads the user, and issues a **fresh access + refresh token pair**. Invalid/expired refresh token → `401`.
4. **Logout** (`POST /auth/logout`): **stateless / client-side only.** The handler body is empty and returns `204 No Content`. Tokens are **not** revoked server-side (no token blocklist exists); the client is expected to discard them.

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

There is **no dedicated `@Roles` decorator or RolesGuard**. Authorization is enforced imperatively inside services through `OrgsService.checkMembership(orgId, userId, requiredRoles?)` (alias `requireMembership`) in [orgs.service.ts](../apps/api/src/orgs/orgs.service.ts):

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

> Older docs showed `members` arrays / nested `membership` objects in these responses — the current service does **not** return member lists; it returns the org fields plus a single `role` string (for `findAll`/`findOne`).

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

- `findAllForOrg`: checks membership, returns `Project[]` for the org ordered by `updatedAt desc`. Each `Project` = `{ id, orgId, name, description, createdAt, updatedAt }`.
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
- `listAssets`: requires membership; optional `type` query filters `Asset.type`; returns `Asset[]` ordered `createdAt desc`.
- `getAsset`: loads by id (`404` if missing), then requires membership of the asset's org; returns the `Asset`.
- `getDownloadUrl`: resolves the asset (membership-checked) and returns `{ downloadUrl }` — a **presigned GET URL** (`GetObjectCommand`, 1-hour expiry).
- `deleteAsset`: resolves the asset, requires `OWNER`/`ADMIN` (else `400 "Only admins can delete assets"`), deletes the **DB row only** (the S3 object is intentionally left in place to avoid accidental data loss). Returns `{ deleted: true }`.

### 3.7 Simulation — `[simulation.controller.ts](../apps/api/src/simulation/simulation.controller.ts)`

No controller prefix; full paths per route. Entire controller is `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`. Jobs are dispatched to a BullMQ queue named `simulations` (Redis via `REDIS_URL`, see [simulation.module.ts](../apps/api/src/simulation/simulation.module.ts)) and executed by the separate `worker-sim` service (ngspice). The engine is always `NGSPICE`.

| Method | Path | Auth | Role | Request body | Response |
|--------|------|------|------|--------------|----------|
| POST | `/versions/:versionId/simulations` | Yes (`JwtAuthGuard`) | membership (via version→project→org) | `CreateSimulationDto` | `201` `{ jobId }` |
| POST | `/simulations/quick` | Yes (`JwtAuthGuard`) | membership (uses caller's first org) | `QuickSimulationDto` | `201` `{ jobId }` — **throttled 10/60s** |
| GET | `/simulations/:jobId` | Yes (`JwtAuthGuard`) | membership (of job's org) | none | `200` status object |
| GET | `/simulations/:jobId/result` | Yes (`JwtAuthGuard`) | membership (of job's org) | none | `200` result object |

Only `POST /simulations/quick` carries `@Throttle({ default: { limit: 10, ttl: 60000 } })`.

**DTOs** ([simulation/dto/index.ts](../apps/api/src/simulation/dto/index.ts)):

`CreateSimulationDto`
| Field | Type | Validation |
|-------|------|------------|
| `analysisConfig` | object (`Record<string, unknown>`) | `@IsObject()` |
| `probes` | string[]? | `@IsArray()` `@IsString({ each: true })` `@IsOptional()` (e.g. `["v(out)", "v(in)"]`) |

`QuickSimulationDto`
| Field | Type | Validation |
|-------|------|------------|
| `netlist` | string | `@IsString()` (raw SPICE netlist) |
| `analysisConfig` | object? | `@IsObject()` `@IsOptional()` |

**Behavior / responses** (from [simulation.service.ts](../apps/api/src/simulation/simulation.service.ts)):

- `createFromVersion`: resolves the version via `VersionsService.findOne` (membership-checked through the project), generates a netlist from the version's `circuitJson` + `analysisConfig` (and optional `probes`) using `generateNetlist` from `@circuitforge/eda-core`, persists a `SimulationJob` (`status: QUEUED`, `engine: NGSPICE`, `orgId` from the version's project), enqueues a `simulation` job (`{ jobId, orgId, netlist, probeNames, analysisType, analysisConfig }`, `analysisType` taken from `analysisConfig.type` or defaulting to `'tran'`), and returns **`{ jobId }`**.
- `createQuickSim`: looks up the caller's organizations and uses the **first** one (`404 "No organization found for user"` if none); persists a `SimulationJob` with the **raw provided `netlist`** (no netlist generation) and enqueues it the same way; returns **`{ jobId }`**.
- `getStatus`: loads the job (`404` if missing), checks the caller's membership of `job.orgId`, returns: `{ id, status, createdAt, startedAt, finishedAt, metrics }`.
- `getResult`: loads the job (`404` if missing), checks membership. If `status !== 'SUCCEEDED'` returns `{ id, status, error: stderr }`. If succeeded returns `{ id, status, result, metrics }` — `result` is read from the DB (`resultJson`) and, when that is null because the result spilled to S3 (`resultS3Key` set), hydrated from S3 (`results/{jobId}/result.json`). A fetch/parse failure logs the error and returns `result: null` with an `error: "Result data is currently unavailable from storage."` field.

**Job status values** (`SimJobStatus` enum, [schema.prisma](../apps/api/prisma/schema.prisma)): `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELED`, `TIMED_OUT`.

> **Simulation prerequisite:** ngspice must be installed where `worker-sim` runs (locally `choco install ngspice -y` on Windows). Without it, jobs transition to a failed state and `getResult` returns the `stderr` in the `error` field. A version-based transient simulation has been verified end-to-end on this setup.

### 3.8 Health — `[health.controller.ts](../apps/api/src/health/health.controller.ts)`

Controller prefix: `health`. No guards — all routes are public. No request body or params.

| Method | Path | Auth | Response |
|--------|------|------|----------|
| GET | `/health` | No | `200` `{ status: "ok", timestamp, service: "circuit-forge-api" }` |
| GET | `/health/ready` | No | `200` readiness object (overall `status` + `checks`) |
| GET | `/health/live` | No | `200` `{ status: "ok", timestamp }` |

`GET /health/ready` (`readiness`) runs `SELECT 1` against Postgres via Prisma and reports per-dependency status and latency:

```json
{
  "status": "ok",
  "timestamp": "2026-05-29T00:00:00.000Z",
  "service": "circuit-forge-api",
  "checks": {
    "database": { "status": "ok", "latencyMs": 5 }
  }
}
```

If the DB check fails, `checks.database.status` is `"error"` (with an `error` message and `latencyMs`), and the overall `status` becomes `"degraded"`. (Note: the handler always returns HTTP `200`; the `status` field reflects health.)

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
