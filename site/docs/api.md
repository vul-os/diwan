# Diwan — Public `/v1` API

A clean, JSON-only REST API over the Diwan document engine (Docs, Sheets,
Slides). It exposes the same document store, per-file access control, and export
services the web app uses, behind a stable, versioned, developer-facing surface.

Conventions (modelled on the mail connector's `/v1` API — lilmail):

- **JSON in, JSON out.** Request and response bodies are `application/json`
  (export endpoints return binary office files — see below).
- **No redirects.** Authentication failures return a JSON `401`/`403`/`503`, never
  an HTML login redirect.
- **Errors** always have the shape `{"error": "<message>"}`.
- **Ownership-scoped.** Every request resolves to a verified account and is
  filtered through the per-file ACL. Access denied to a document you may not see
  returns `404` (no existence leak), not `403`.

Base path: `/v1`. All examples assume a host of `http://localhost:8080` (the standalone default).

---

## Authentication

The `/v1` API accepts **either** of two credentials, both via the
`Authorization` header:

### 1. Session (the existing Diwan login)

`Authorization: Bearer <session-jwt>` **or** the HttpOnly `session` cookie
(HS256, the same token the web app uses). This is the zero-config path for
first-party / self-host use.

When Diwan runs with `auth.enabled: false` (single-user self-host), no
credential is required and requests act as the local `self` identity.

### 2. API key (`vk_…`)

`Authorization: Bearer vk_live_…`

An API key is an opaque token prefixed with `vk_`. It is validated against a
configured control plane ("CP") via the **key introspection seam** (below) —
Vulos operates no control plane; this points at your own, if you run one. A key
must be valid **and** carry the `office` product scope.

The API-key path is enabled only when the CP base URL is configured
(`VULOS_CP_BASE_URL`). When it is **not** configured, the key path is disabled
and `/v1` accepts session auth only — self-host behaviour is unchanged.

A `vk_` token is never tried as a session JWT and vice-versa: the `vk_` prefix
selects the scheme, so the two cannot be confused.

| Situation                                   | Response                                            |
| ------------------------------------------- | --------------------------------------------------- |
| No / invalid session (auth enabled)         | `401 {"error":"authentication required"}`           |
| `vk_` key invalid / revoked / expired       | `401 {"error":"invalid API key"}`                   |
| `vk_` key valid but lacks `office` product  | `403 {"error":"API key not authorized for the office product"}` |
| CP unreachable during introspection         | `503 {"error":"API key validation unavailable"}`    |

API keys act only as their own account — they never carry the tenant-wide admin
scope.

---

## Key introspection seam (control-plane contract)

This is the **shared** seam contract Vulos products (Diwan, Mail, Talk, …) can
implement identically against a self-configured control plane to validate `vk_`
keys: **one** endpoint, called the same way by every product.

### Request

```
POST {VULOS_CP_BASE_URL}/api/keys/introspect
Content-Type: application/json
X-Relay-Auth: <VULOS_CP_TOKEN>        # service auth (optional; omitted if unset)

{ "key": "vk_live_abc123…" }
```

### Response (always `200` on a successful lookup)

```json
{
  "valid":    true,
  "account":  "alice@vulos.org",
  "scopes":   ["documents.read", "documents.write"],
  "products": ["office", "mail"]
}
```

For an unknown / revoked / expired key the CP still returns `200` with:

```json
{ "valid": false }
```

| Field      | Type       | Meaning                                                            |
| ---------- | ---------- | ----------------------------------------------------------------- |
| `valid`    | bool       | Whether the key is currently usable.                              |
| `account`  | string     | The owning account id (becomes the request's verified identity).  |
| `scopes`   | string[]   | Granular scopes the key carries (advisory; see below).            |
| `products` | string[]   | Products the key may use. Diwan requires `"office"` to be present. |

### Caller behaviour (implemented by every product)

- Results are **cached in-process for ~60s**, keyed by a hash of the key, so a
  burst of API calls introspects a given key at most once per minute.
- A non-`200` response or transport error is treated as **fail-closed**: the
  request is rejected `503` rather than granted.
- Diwan requires `products` to include `office`. `scopes` are returned for
  forward use (per-endpoint scope enforcement); today any valid `office` key may
  use every `/v1` endpoint within its own ACL.

### Configuration

| Env var              | Purpose                                                             |
| -------------------- | ------------------------------------------------------------------ |
| `VULOS_CP_BASE_URL`  | Control-plane base URL (e.g. `https://cp.example.org`, pointing at your own control plane — Vulos operates none). Enables the `vk_` path. Unset → session-only. |
| `VULOS_CP_TOKEN`     | Service token sent as `X-Relay-Auth` on the introspection call. Optional. |

These are the **same** env vars the optional control-plane entitlements seam
uses, so a CP-attached deployment configures them once.

---

## Document endpoints

A *document* is a Docs / Sheets / Slides file. `type` is one of `doc`, `sheet`,
`slide` (`pdf` is reserved for future imported-PDF documents).

The document metadata object:

```json
{
  "id": "0b3f…",
  "name": "Q3 Plan",
  "type": "doc",
  "created_at": "2026-06-28T10:11:12Z",
  "updated_at": "2026-06-28T10:30:00Z"
}
```

### `GET /v1/documents`

List documents the caller may access (owned + shared; admins see all).

Query parameters:

| Param  | Description                                       |
| ------ | ------------------------------------------------- |
| `type` | Optional filter: `doc`, `sheet`, `slide`, `pdf`.  |

```json
200 OK
{ "documents": [ { "id": "…", "name": "…", "type": "doc", … } ] }
```

### `GET /v1/documents/:id`

Fetch a single document's metadata.

```json
200 OK
{ "id": "…", "name": "…", "type": "doc", "created_at": "…", "updated_at": "…" }
```

`404 {"error":"document not found"}` if it does not exist or you may not access it.

### `POST /v1/documents`

Create a document.

```json
POST /v1/documents
{ "name": "Q3 Plan", "type": "doc", "content": { … } }
```

`name` and `type` are required; `content` is the optional initial body (an
arbitrary JSON value — the editor's native document model). The creating account
becomes the owner, so the document is private by default.

```json
201 Created
{ "id": "…", "name": "Q3 Plan", "type": "doc", … }
```

### `PATCH /v1/documents/:id`

Rename and/or replace content. All fields optional; only provided fields apply.

```json
PATCH /v1/documents/:id
{ "name": "Q3 Plan (final)", "content": { … } }
```

```json
200 OK
{ "id": "…", "name": "Q3 Plan (final)", "type": "doc", … }
```

> Note: "move" (folder/organization) is modelled as a metadata patch; today
> documents are flat per account, so `name` is the mutable metadata.

### `DELETE /v1/documents/:id`

Delete a document (and its ACL state).

```json
200 OK
{ "deleted": true, "id": "…" }
```

---

## Content & export

### `GET /v1/documents/:id/content`

Fetch the document body, or export it.

- **No `format`** → the raw stored body as JSON:

  ```json
  200 OK
  { "id": "…", "type": "doc", "content": { … } }
  ```

- **`?format=<fmt>`** → the exported binary as an `attachment` download. The
  available formats depend on the document type:

  | Type    | Formats        | Carries                                                         |
  | ------- | -------------- | --------------------------------------------------------------- |
  | `doc`   | `pdf`, `docx`  | Text, headings, lists, **tables**, **embedded images**.          |
  | `sheet` | `xlsx`         | Cells, styles, merges, formulas, **real charts** (cell-linked).  |
  | `slide` | `pdf`, `pptx`  | `pptx`: **positioned text boxes, images and shapes**. `pdf`: text only. |

### `POST /v1/documents/:id/export`

Render the document to an office format and return the binary attachment. The
canonical export endpoint.

```json
POST /v1/documents/:id/export
{ "format": "docx" }
```

```
200 OK
Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document
Content-Disposition: attachment; filename="Q3 Plan.docx"
<binary>
```

Unsupported format for the document type → `400 {"error":"unsupported format…"}`.

### Export fidelity — an export never loses your data in silence

Every export response carries its own fidelity, because a binary attachment has no
body to put a warning in:

| Header              | Value                                                            |
| ------------------- | ---------------------------------------------------------------- |
| `X-Export-Fidelity` | `full` — everything in the document is in the file.               |
|                     | `degraded` — something could not be carried. See the warnings.    |
| `X-Export-Warnings` | A JSON array of plain-English strings. Present only when degraded. |

```
200 OK
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="Q3.xlsx"
X-Export-Fidelity: degraded
X-Export-Warnings: ["Chart \"Funnel\" was NOT embedded in the .xlsx (no Excel equivalent); its definition is preserved in the hidden \"Vulos Charts\" sheet, so re-importing this file into Vulos restores it."]
<binary>
```

A client that cares about fidelity should check `X-Export-Fidelity` and surface the
warnings; a client that does not can ignore both headers. **`full` is a promise** —
if a path cannot carry something, it says so rather than returning a quietly
incomplete file.

What is reported today:

- **`sheet` → `xlsx`.** Charts are embedded as real, cell-linked OOXML charts
  (column/bar/stacked/100%, line, area, combo incl. a secondary axis, pie, donut,
  scatter, bubble, histogram). A chart type with no Excel equivalent, or one whose
  range cannot be resolved, is reported — and its definition still rides in the
  hidden `Vulos Charts` sheet, so re-importing the file into Vulos restores it
  exactly. A **histogram** is embedded with a caveat (its bins are computed at export
  time and written to cells; Excel will not re-bin them). **Live pivot tables** are
  not exported and are reported.
- **`doc` → `docx` / `pdf`.** Tables and images are embedded. A **remote** (`http(s)`)
  image is **not fetched** — the server will not make a request a document tells it
  to — and is reported; only images embedded in the document (`data:` PNG/JPEG/GIF/WebP)
  are carried. Equations export as their LaTeX source. In the PDF, an image inside a
  table cell is shown as its alt text.
- **`slide` → `pptx`.** Text boxes, images and shapes export at their real position,
  size and rotation. Remote images are not fetched (reported); speaker notes are not
  included (reported).
- **`slide` → `pdf`.** A text-flow renderer: images and shapes are not drawn, and
  their loss is reported. Export `pptx` to keep them.

---

## Collaborators (share management)

### `GET /v1/documents/:id/collaborators`

List the document owner and the accounts it is shared with.

```json
200 OK
{ "owner": "alice@vulos.org", "collaborators": ["bob@vulos.org"] }
```

### `POST /v1/documents/:id/collaborators`

Grant or revoke another account's access. Reuses the same ACL store and
append-only audit trail as the first-party app.

```json
POST /v1/documents/:id/collaborators
{ "account": "bob@vulos.org", "revoke": false }
```

```json
200 OK
{ "ok": true }
```

Set `"revoke": true` to remove access.

---

## Status codes

| Code | Meaning                                                              |
| ---- | ------------------------------------------------------------------- |
| 200  | OK                                                                  |
| 201  | Created (POST /v1/documents)                                        |
| 400  | Malformed request body / unsupported export format                 |
| 401  | Missing or invalid credentials                                     |
| 402  | Entitlements/quota gate (over quota / plan does not include the office product) |
| 403  | API key not authorized for the `office` product                    |
| 404  | Document not found or not accessible                                |
| 429  | Rate limited (write endpoints; token-bucket)                       |
| 500  | Internal error                                                     |
| 503  | API key validation unavailable (control plane unreachable)         |

Write endpoints (`POST`/`PATCH`/`DELETE`) are rate-limited by a per-IP
token bucket (default burst 30, refill 10/s), shared with the rest of the write
surface.
