# Shopify App Dual API Key Migration Plan

## Purpose

Document the Shopify app changes required after Onsite Affiliate SDR Agent 1 starts returning two scoped API keys instead of one shared key, and after Shopify admin starts managing the creator-facing OCE landing page.

Reference implementation target:

- SDR repo: [`/Users/rastakit/tga-workspace/onsite-affiliate-sdr-agent-1`](/Users/rastakit/tga-workspace/onsite-affiliate-sdr-agent-1)
- rollout doc in SDR repo: [`/Users/rastakit/tga-workspace/onsite-affiliate-sdr-agent-1/docs/DUAL_API_KEY_ROLLOUT_PLAN.md`](/Users/rastakit/tga-workspace/onsite-affiliate-sdr-agent-1/docs/DUAL_API_KEY_ROLLOUT_PLAN.md)

## New Upstream Contract

The Shopify app should expect the install/provisioning response to move from one key to two keys:

```json
{
  "org_id": "uuid",
  "frontend_api_key": "ock_...",
  "backend_api_key": "ock_...",
  "api_key": "ock_..."
}
```

Meaning:

- `frontend_api_key`
  - browser SDK only
  - scope: `write_events`
- `backend_api_key`
  - trusted server usage only
  - scopes: `write_events`, `write_orders`, `manage.brands`
- `api_key`
  - temporary backward-compatible alias
  - should be treated as legacy only

## Why Shopify App Must Change

This repo currently assumes a single `apiKey` across all paths:

- install flow stores one key
- admin settings manage one key
- storefront metafields publish one key
- browser SDK examples use one key
- webhook order sync uses one key
- creator portal editing is stored locally in Shopify App instead of writing to OCE

That is not safe once the browser key is intentionally public and the backend key carries both order-write and brand-management capability.

## Current Single-Key Coupling

### Data model

- [`prisma/schema.prisma`](/Users/rastakit/tga-workspace/repos/Shopify_App/prisma/schema.prisma)
  - `OceSettings.apiKey` is the only stored key field

### Install flow

- [`web/backend/services/oce-api.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/services/oce-api.js)
  - `createTokenForShop()` only reads `api_key` / `apiKey`
- [`web/server.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/server.js)
  - token exchange path persists one key from `tokenResult.api_key`

### Settings and admin UI

- [`web/backend/routes/settings.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/routes/settings.js)
  - loads, masks, updates, and syncs only `apiKey`
- [`web/frontend/pages/index.jsx`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/frontend/pages/index.jsx)
  - settings UI exposes one API key input
- [`web/frontend/admin-v2/app.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/frontend/admin-v2/app.js)
  - admin v2 also updates one `apiKey`

### Runtime usage

- [`web/backend/routes/settings.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/routes/settings.js)
  - `activateWebPixel()` injects one `api_key` into the web pixel config
  - `syncAppMetafields()` writes `oce.api_key`
- [`web/backend/routes/webhooks.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/routes/webhooks.js)
  - order webhook processing uses `settings.apiKey`
- [`web/backend/services/oce-api.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/services/oce-api.js)
  - `OceApiService` takes one key for all event and order calls

### Existing creator portal editor

This repo already has a separate local creator-portal content system:

- [`web/backend/routes/settings.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/routes/settings.js)
  - `getPortalContent()` / `savePortalContent()` store content in `OceSettings.portalContent`
- [`web/frontend/pages/index.jsx`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/frontend/pages/index.jsx)
  - admin UI edits local `portalContent`
- [`web/backend/routes/creator-portal.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/routes/creator-portal.js)
  - renders a Shopify-hosted creator portal experience

That local system is distinct from Onsite Affiliate's `/join/:brandSlug` landing page, which is backed by OCE's `creator-portal-settings` endpoint.

## Required Changes

## 1. Change persisted settings schema

Replace the single-key storage model in `OceSettings`.

Suggested fields:

- `frontendApiKey String @default("")`
- `backendApiKey String @default("")`

Optional transition field:

- keep `apiKey` temporarily during migration

Recommended end state:

- browser-facing operations read `frontendApiKey`
- trusted backend operations read `backendApiKey`

## 2. Update install provisioning client

Change `createTokenForShop()` in [`web/backend/services/oce-api.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/services/oce-api.js) so it:

- reads `frontend_api_key`
- reads `backend_api_key`
- tolerates legacy `api_key` during rollout

Recommended fallback logic:

- if both new fields exist, use them
- if only `api_key` exists, treat it as the backend key for backward compatibility

Suggested normalized return shape:

```json
{
  "frontend_api_key": "ock_...",
  "backend_api_key": "ock_...",
  "creator_portal_url": "...",
  "brand_slug": "..."
}
```

## 3. Persist the two keys separately

Update install bootstrap in [`web/server.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/server.js) so token exchange stores:

- `frontendApiKey`
- `backendApiKey`

Rules:

- never copy `backendApiKey` into storefront-readable config
- do not collapse both keys back into one field after provisioning
- use `backendApiKey` as the trusted server-side management key for both order sync and creator landing-page settings writes

## 4. Split browser vs server usage

### Browser-facing usage

Use `frontendApiKey` only for:

- SDK script configuration
- app metafields consumed by Liquid/theme extension
- web pixel config payloads
- any embedded frontend snippets or examples

### Trusted backend usage

Use `backendApiKey` only for:

- order webhook forwarding
- server-side validation calls that need order access
- server-side writes to creator landing-page / brand settings endpoints
- any future backend sync jobs

## 5. Update metafield sync and storefront injection

`syncAppMetafields()` in [`web/backend/routes/settings.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/routes/settings.js) currently writes `oce.api_key`.

Required adjustment:

- write the frontend key to the storefront-consumed metafield
- do not publish the backend key through metafields, HTML, or client config

If the metafield name remains `oce.api_key`, its value must become `frontendApiKey`.

## 6. Update order webhook flow

[`web/backend/routes/webhooks.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/routes/webhooks.js) must switch from `settings.apiKey` to `settings.backendApiKey`.

Reason:

- orders are a trusted backend concern
- the frontend key must fail for order writes once scoped enforcement is active

## 7. Update API service construction

[`web/backend/services/oce-api.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/services/oce-api.js) currently uses one `OceApiService(apiKey)`.

Recommended change:

- keep the service class generic
- instantiate it with the correct key for the call path

Examples:

- `new OceApiService(settings.frontendApiKey)` for event-only or frontend-config-adjacent calls
- `new OceApiService(settings.backendApiKey)` for order-sync and management calls

## 8. Add server-side creator landing-page proxy

OCE already has a write endpoint for creator landing-page customization:

- [`/Users/rastakit/tga-workspace/repos/onsite-affiliate/supabase/functions/creator-portal-settings/index.ts`](/Users/rastakit/tga-workspace/repos/onsite-affiliate/supabase/functions/creator-portal-settings/index.ts)

It supports:

- public `GET ?brand_slug=...`
- authenticated `POST` with a key that has `manage.brands`

The Shopify app should not call this endpoint directly from browser-admin code. Instead:

- add backend helpers such as `getCreatorPortalSettings(shop)` and `saveCreatorPortalSettings(shop, settings)`
- have those helpers call OCE from server code using `backendApiKey`
- expose internal Shopify app routes or Remix actions for the admin UI to load and save these settings

Initial editable fields should match the current OCE endpoint:

- `logo_url`
- `primary_color`
- `accent_color`
- `headline`
- `description`
- `cta_text`
- `custom_css`

## 9. Add an OCE-backed landing-page editor to Shopify admin

The current Shopify admin already has a local portal editor, but that editor writes to Shopify App storage rather than OCE.

Recommended rollout:

- keep the current local `portalContent` editor intact initially
- add a separate "Creator Landing Page" section backed by OCE `creator-portal-settings`
- use the live `creatorPortalUrl` preview after save so merchants can confirm the actual `/join/:brandSlug` page output

Why keep it separate first:

- the local Shopify editor supports more fields than OCE's current schema
- OCE's landing-page settings model is narrower
- combining them immediately would create source-of-truth confusion and partial-save behavior

Likely implementation points:

- [`web/frontend/pages/index.jsx`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/frontend/pages/index.jsx)
- [`web/backend/routes/settings.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/routes/settings.js)
- [`web/backend/services/oce-api.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/services/oce-api.js)

## 10. Update admin/settings UX

Current admin flows assume one key field. Update the UI so it is explicit which key is being edited or displayed.

Recommended behavior:

- show masked frontend key separately
- show masked backend key separately
- if manual entry remains supported, provide two inputs or a structured import action
- avoid rendering the backend key in places intended for copy-paste storefront setup

Likely files:

- [`web/frontend/pages/index.jsx`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/frontend/pages/index.jsx)
- [`web/frontend/admin-v2/app.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/frontend/admin-v2/app.js)
- [`web/backend/routes/settings.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/routes/settings.js)

## 11. Preserve backward compatibility during rollout

During the migration window:

- accept old OCE install responses that only return `api_key`
- map legacy `api_key` to `backendApiKey`
- if `frontendApiKey` is missing, optionally reuse the backend key temporarily only while OCE is still in legacy mode

Important:

- remove this fallback after the SDR repo dual-key rollout is complete and all installs have migrated

## 12. Update docs

These docs will need follow-up edits once implementation starts:

- [`docs/OCE_INSTALL_API_CONTRACT.md`](/Users/rastakit/tga-workspace/repos/Shopify_App/docs/OCE_INSTALL_API_CONTRACT.md)
- [`docs/CUSTOM_PIXEL_NOTE_ATTRIBUTES.md`](/Users/rastakit/tga-workspace/repos/Shopify_App/docs/CUSTOM_PIXEL_NOTE_ATTRIBUTES.md)

Key documentation rule:

- examples that appear in storefront/browser contexts must use the frontend key
- order/webhook docs must use the backend key
- creator landing-page management docs must route through the Shopify app backend, not direct browser calls to OCE

## Suggested Implementation Order

1. Add schema fields and migration for separate frontend/backend keys.
2. Update install client to parse dual-key responses with legacy fallback.
3. Update persistence in `web/server.js`.
4. Switch webhook/order flows to `backendApiKey`.
5. Switch metafields and pixel activation to `frontendApiKey`.
6. Add a server-side proxy for OCE `creator-portal-settings` using `backendApiKey`.
7. Add an OCE-backed landing-page editor to Shopify admin.
8. Update admin/settings UI for dual keys.
9. Update docs and remove legacy single-key assumptions.

## Verification Checklist

- install flow stores both keys when OCE returns both
- legacy install flow still works when OCE returns only `api_key`
- storefront metafields contain only the frontend key
- web pixel config contains only the frontend key
- webhook order sync uses the backend key
- creator landing-page saves use the backend key via server-side proxy
- creator landing-page changes appear on the live OCE `/join/:brandSlug` page
- browser-exposed flows do not leak the backend key
- manual settings UI does not overwrite the wrong key field

## Status

Documentation only. No code changes have been made in this repo by this note.
