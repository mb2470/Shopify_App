# Phase 1 Creator Portal Integration Guide (Shopify App)

## Purpose

This document explains the Phase 1 Creator Portal updates completed in Onsite Affiliate (OCE), and defines what the Shopify app must do to integrate with them.

Primary goal:

- Shopify app remains the merchant admin surface.
- OCE owns the public creator join page, signup/auth, and creator lifecycle.
- Shopify writes portal content and settings into OCE via API.

## Why This Change

The current Shopify-hosted creator portal is a separate stack with separate storage and auth. That creates fragmentation across:

- creator identity
- signup and verification flow
- portal content
- future uploads and creator actions
- future dashboards and lifecycle management

Preferred architecture:

- Shopify App = merchant control plane
- OCE = creator execution plane

## Current Shopify Portal Surfaces

### Local content editor

- [`web/frontend/pages/index.jsx`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/frontend/pages/index.jsx)
- [`web/backend/routes/settings.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/routes/settings.js)

### Local creator-facing portal renderer

- [`web/backend/routes/creator-portal.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/routes/creator-portal.js)

### Current local storage

- [`prisma/schema.prisma`](/Users/rastakit/tga-workspace/repos/Shopify_App/prisma/schema.prisma)
  - `OceSettings.portalContent`

## What Shipped In OCE (Phase 1)

Phase 1 parity work is implemented in OCE and includes:

- new `creator_portal_settings` fields for page copy, benefits, terms, toggles, and signup card content
- expanded `creator-portal-settings` API to read and write those fields
- updated `/join/:brandSlug` renderer to use settings-driven content
- safe scoped `custom_css` application on the join page only
- updated merchant settings dialog in OCE dashboard as a reference implementation

Key files changed in OCE:

- [`supabase/migrations/20260323120000_add_creator_portal_phase1_parity_fields.sql`](/Users/rastakit/tga-workspace/repos/onsite-affiliate/supabase/migrations/20260323120000_add_creator_portal_phase1_parity_fields.sql)
- [`supabase/functions/creator-portal-settings/index.ts`](/Users/rastakit/tga-workspace/repos/onsite-affiliate/supabase/functions/creator-portal-settings/index.ts)
- [`src/pages/creator/CreatorSignup.tsx`](/Users/rastakit/tga-workspace/repos/onsite-affiliate/src/pages/creator/CreatorSignup.tsx)
- [`src/components/legal/TermsSummaryCard.tsx`](/Users/rastakit/tga-workspace/repos/onsite-affiliate/src/components/legal/TermsSummaryCard.tsx)
- [`src/components/dashboard/BrandPortalSettingsDialog.tsx`](/Users/rastakit/tga-workspace/repos/onsite-affiliate/src/components/dashboard/BrandPortalSettingsDialog.tsx)
- [`src/integrations/supabase/types.ts`](/Users/rastakit/tga-workspace/repos/onsite-affiliate/src/integrations/supabase/types.ts)

## OCE Data Model: Phase 1 Fields

The following fields were added to `creator_portal_settings`.

### Page header content

- `page_title`
- `page_subtitle`
- `page_subtitle_2`

### Benefits section

- `benefit_1_title`
- `benefit_1_description`
- `benefit_2_title`
- `benefit_2_description`
- `benefit_3_title`
- `benefit_3_description`
- `show_benefits`

### Terms summary section

- `terms_heading`
- `term_1_icon`
- `term_1_text`
- `term_2_icon`
- `term_2_text`
- `term_3_icon`
- `term_3_text`
- `term_4_icon`
- `term_4_text`
- `show_terms`

### Signup card content

- `signup_card_title`
- `signup_card_subtitle`

Existing fields still supported:

- `logo_url`
- `primary_color`
- `accent_color`
- `headline`
- `description`
- `cta_text`
- `custom_css`

## OCE API Contract: `creator-portal-settings`

Endpoint:

- Supabase edge function `creator-portal-settings`
- implementation: [`supabase/functions/creator-portal-settings/index.ts`](/Users/rastakit/tga-workspace/repos/onsite-affiliate/supabase/functions/creator-portal-settings/index.ts)

### Public read (GET)

Request:

- `GET /functions/v1/creator-portal-settings?brand_slug={brandSlug}`

Behavior:

- returns brand plus portal settings
- includes the new Phase 1 fields
- if no dedicated settings row exists, the function falls back to brand metadata and returns `null` for unset portal fields

### Authenticated write (POST)

Request body:

```json
{
  "brand_slug": "your-brand-slug",
  "settings": {
    "page_title": "Join BrandX as a Creator",
    "page_subtitle": "Create content and earn commissions",
    "show_benefits": true
  }
}
```

Requirements:

- API key with `manage.brands`
- `brand_slug`, if provided, must match the API key brand
- only whitelisted fields are saved

Write behavior:

- upserts by `brand_id`
- returns saved settings including the new Phase 1 fields

## Rendering Behavior On OCE Join Page

Public page path:

- `/join/:brandSlug`

Implementation target:

- [`src/pages/creator/CreatorSignup.tsx`](/Users/rastakit/tga-workspace/repos/onsite-affiliate/src/pages/creator/CreatorSignup.tsx)

### Header content

Title render precedence:

1. `page_title`
2. `headline`
3. default `Join {Brand} as a Creator`

Subtitle render precedence:

1. `page_subtitle`
2. `description`
3. default marketing copy

`page_subtitle_2` is optional and renders as a second subtitle line only when populated.

### Benefits section

- controlled by `show_benefits`
- hidden only when explicitly `false`
- uses the 3 title and description pairs from settings
- falls back to default benefit copy for missing values

### Terms summary section

- controlled by `show_terms`
- hidden only when explicitly `false`
- heading from `terms_heading`
- 4 configurable rows using `term_n_text` and `term_n_icon`
- unknown or missing icons fall back safely to a default icon

Supported icon keywords currently map to lucide icons:

- `file`, `filetext`, `terms`
- `dollar`, `dollarsign`, `money`
- `eye`, `view`
- `clock`, `time`

### Signup card

- title from `signup_card_title`
- fallback `Create Your Account`
- subtitle from `signup_card_subtitle`
- fallback `Start earning with {Brand} in minutes`
- CTA still uses `cta_text`

### Custom CSS

- `custom_css` is injected only on the join page surface
- CSS is scoped under `#creator-signup-page` for normal selectors
- intended for styling tweaks only in Phase 1, not rich HTML injection

## Shopify App: Required Changes

This is the implementation checklist for the Shopify app repository.

### 1. Extend Shopify portal settings schema and types

Wherever Shopify App stores editor state, add the full Phase 1 field set listed above.

Guidelines:

- booleans default to `true` for `show_benefits` and `show_terms`
- text fields default to empty string in UI state
- preserve `headline` and `description` for compatibility and fallback behavior

Likely files:

- [`prisma/schema.prisma`](/Users/rastakit/tga-workspace/repos/Shopify_App/prisma/schema.prisma)
- [`web/frontend/pages/index.jsx`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/frontend/pages/index.jsx)
- [`web/backend/routes/settings.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/routes/settings.js)

### 2. Add backend OCE proxy methods

In Shopify backend code, add helpers like:

- `getCreatorPortalSettings(shop)`
- `saveCreatorPortalSettings(shop, settings)`

These should:

- look up the merchant's `backendApiKey`
- call OCE `creator-portal-settings`
- never expose the management-capable key to browser code

Likely file:

- [`web/backend/services/oce-api.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/services/oce-api.js)

This depends on the dual-key work documented in [`docs/DUAL_API_KEY_MIGRATION_PLAN.md`](/Users/rastakit/tga-workspace/repos/Shopify_App/docs/DUAL_API_KEY_MIGRATION_PLAN.md), because the write path must use the server-side `backendApiKey` with `manage.brands`.

### 3. Update Shopify admin routes and actions

Expose internal app endpoints or actions that:

- load current OCE landing-page settings
- save edited settings to OCE

Likely files:

- [`web/backend/routes/settings.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/routes/settings.js)
- [`web/frontend/pages/index.jsx`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/frontend/pages/index.jsx)

### 4. Update Shopify editor UI

Add editor controls for:

- page title, subtitle, and subtitle line 2
- benefits toggle plus 3 title and description cards
- terms toggle, heading, and 4 icon and text rows
- signup card title and subtitle
- existing style controls plus `custom_css`

Recommended editor grouping:

- Header
- Benefits
- Terms Summary
- Signup Card
- Theme and CSS

### 5. Update Shopify to OCE save payload

When a merchant clicks save or publish, include all supported Phase 1 fields in the `settings` payload sent to OCE.

Important:

- send booleans as JSON booleans, not strings
- do not send unsupported keys
- use `backendApiKey`, never a browser key

### 6. Treat the OCE page as the source of truth

If Shopify App keeps a local preview renderer, it should match OCE behavior as closely as possible:

- same fallback rules
- same section toggle logic
- same terms icon keyword behavior, or clearly document any mismatch

Preferred pattern:

- use OCE `/join/:brandSlug` as the authoritative renderer
- treat local preview as helper UX only

### 7. Keep the Shopify-hosted creator portal as legacy during migration

Do not immediately overwrite the current local portal editor or renderer.

Recommended rollout:

1. add a separate OCE-backed "Creator Landing Page" section in Shopify admin
2. wire Phase 1 fields to OCE
3. preview or open the live `creatorPortalUrl`
4. keep the Shopify-hosted creator portal available during migration
5. stop enhancing the Shopify-hosted portal once the OCE-backed flow is in use

Why keep it separate first:

- the local Shopify editor may still have merchant data in `portalContent`
- the old Shopify portal and OCE `/join/:brandSlug` are different render targets
- separation reduces source-of-truth confusion while merchants migrate

### 8. Update Shopify-side migration and backfill logic if needed

If Shopify App persists portal settings in its own DB or cache:

- add fields for the new values
- backfill `show_benefits` and `show_terms` to `true`
- leave text fields null or empty unless a merchant edits them

### 9. QA the end-to-end flow

From Shopify admin:

1. save every new field
2. verify OCE GET returns saved values
3. verify OCE `/join/:brandSlug` reflects all changes
4. toggle off `show_benefits` and `show_terms`
5. verify signup card title and subtitle updates
6. verify scoped `custom_css` works and does not bleed outside the join page

## Suggested Shopify Payload Example

```json
{
  "brand_slug": "brand-slug",
  "settings": {
    "logo_url": "https://cdn.example.com/logo.png",
    "primary_color": "#111111",
    "accent_color": "#D72638",
    "headline": "Legacy headline fallback",
    "description": "Legacy description fallback",
    "cta_text": "Apply Now",
    "custom_css": ".text-muted-foreground { opacity: 0.92; }",
    "page_title": "Join BrandX Creator Program",
    "page_subtitle": "Create videos, share products, and earn commissions.",
    "page_subtitle_2": "Fast setup. Transparent payouts.",
    "benefit_1_title": "Upload Your Content",
    "benefit_1_description": "Submit videos and track every conversion.",
    "benefit_2_title": "Real-Time Analytics",
    "benefit_2_description": "See attribution and revenue performance instantly.",
    "benefit_3_title": "Earn Commissions",
    "benefit_3_description": "Get paid for every sale you influence.",
    "show_benefits": true,
    "terms_heading": "Program Terms at a Glance",
    "term_1_icon": "file",
    "term_1_text": "You retain ownership of your content.",
    "term_2_icon": "dollar",
    "term_2_text": "Commission rates are set by each brand.",
    "term_3_icon": "eye",
    "term_3_text": "Placements are not guaranteed.",
    "term_4_icon": "clock",
    "term_4_text": "Removed content is taken down within 30 days.",
    "show_terms": true,
    "signup_card_title": "Create Your Creator Account",
    "signup_card_subtitle": "Start earning with BrandX in minutes."
  }
}
```

## Compatibility Notes

- OCE still supports `headline` and `description` and uses them as fallback
- if Shopify starts sending `page_title` and `page_subtitle`, those take precedence
- merchants can adopt the new fields gradually without breaking the join page
- rich-text subtitle support is still Phase 2 work and should not block this migration

## Status

Planning only on the Shopify App side. Phase 1 OCE support is available; Shopify App integration work remains to be implemented.
