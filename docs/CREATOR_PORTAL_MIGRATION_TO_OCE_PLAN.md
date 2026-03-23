# Creator Portal Migration To OCE Plan

## Goal

Keep Shopify App as the merchant admin surface, but move the creator-facing landing page, signup, and future creator actions onto Onsite Affiliate.

That means:

- Shopify admin edits settings
- Shopify backend saves those settings to OCE
- creators use OCE's `/join/:brandSlug` page
- creator signup, auth, and future actions stay in OCE as the system of record

## Why This Change

The current Shopify-hosted creator portal is a separate stack with separate storage and auth. That creates fragmentation across:

- creator identity
- signup / verification flow
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

## Migration Principle

Do not try to replace everything in one cut.

Phase 1 should move the easy content model to OCE and use OCE's live creator landing page.
Phase 2 should add rich text parity and any remaining advanced features.

## OCE Target

Target OCE surface:

- landing page: `/join/:brandSlug`
- settings endpoint: [`/Users/rastakit/tga-workspace/repos/onsite-affiliate/supabase/functions/creator-portal-settings/index.ts`](/Users/rastakit/tga-workspace/repos/onsite-affiliate/supabase/functions/creator-portal-settings/index.ts)
- OCE parity plan: [`/Users/rastakit/tga-workspace/repos/onsite-affiliate/docs/CREATOR_PORTAL_PARITY_PLAN.md`](/Users/rastakit/tga-workspace/repos/onsite-affiliate/docs/CREATOR_PORTAL_PARITY_PLAN.md)

The Shopify App should call that endpoint through server-side code using the backend management key.

## Phase 1: Migrate The Easy Fields

### Fields to move to OCE now

These fields are good low-hanging-fruit candidates for near parity:

- page title
- page subtitle
- page subtitle line 2
- 3 benefit card titles/descriptions
- show/hide benefits
- terms heading
- 4 term icons/text rows
- show/hide terms
- signup card title
- signup card subtitle
- logo/colors
- custom CSS

### Shopify app changes in phase 1

#### 1. Add backend OCE proxy methods

In Shopify backend code, add helpers like:

- `getCreatorLandingPageSettings(shop)`
- `saveCreatorLandingPageSettings(shop, settings)`

These should:

- look up the merchant's `backendApiKey`
- call OCE `creator-portal-settings`
- never expose the management-capable key to browser code

Likely file:

- [`web/backend/services/oce-api.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/services/oce-api.js)

#### 2. Add Shopify admin routes/actions for OCE-backed settings

Expose internal app endpoints or Remix actions that:

- load current OCE landing-page settings
- save edited settings to OCE

Likely files:

- [`web/backend/routes/settings.js`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/backend/routes/settings.js)
- [`web/frontend/pages/index.jsx`](/Users/rastakit/tga-workspace/repos/Shopify_App/web/frontend/pages/index.jsx)

#### 3. Add a separate OCE-backed editor section

Do not immediately overwrite the current local portal editor.

Instead:

- add a new "Creator Landing Page (OCE)" section in Shopify admin
- wire only the phase 1 fields to OCE
- preview the real OCE creator portal using `creatorPortalUrl`

Why separate first:

- the current local editor is already in use
- the old local portal and the new OCE portal are different render targets
- keeping them separate reduces confusion during migration

#### 4. Push merchants toward the OCE page

In admin UI and setup flow:

- emphasize the OCE `creatorPortalUrl`
- treat the Shopify-hosted creator portal as legacy

## Phase 2: Rich Text And Advanced Parity

### Rich text subtitles

The current Shopify editor supports limited rich text in subtitle fields.

This should stay phase 2 because it needs:

- allowed-tag definition
- sanitization rules
- safe rendering in OCE React

Until then:

- phase 1 subtitle fields should be plain-text only, or
- Shopify should down-convert existing rich text to plain text for the OCE-backed editor

### Any remaining advanced presentation features

If any old local editor behaviors remain unmatched after phase 1, carry them into phase 2 rather than blocking the migration.

## Legacy Portal Strategy

The current Shopify-hosted creator portal should be treated as legacy after the OCE-backed editor is live.

Recommended path:

1. Keep it available during migration.
2. Move merchant setup and preview toward OCE `/join/:brandSlug`.
3. Stop enhancing the local Shopify-hosted portal.
4. Decommission or hide it once OCE parity is sufficient.

## Dependencies

This migration assumes:

- OCE expands `creator-portal-settings` to support the phase 1 field set
- the Shopify backend key has `manage.brands`
- the dual-key flow is in place so the management-capable key stays server-side

## Suggested Implementation Order

1. Complete phase 1 field expansion in OCE.
2. Add Shopify backend proxy methods for OCE landing-page settings.
3. Add OCE-backed landing-page editor in Shopify admin.
4. Add preview/open flow for the live OCE creator portal URL.
5. Mark the old Shopify-hosted creator portal as legacy in merchant-facing UX.
6. Implement phase 2 rich text parity later.

## Verification Checklist

- Shopify admin can load OCE landing-page settings
- Shopify admin can save OCE landing-page settings
- saves update the live OCE `/join/:brandSlug` page
- no browser code receives the `backendApiKey`
- creator signup occurs in OCE, not Shopify App local auth
- legacy local portal remains available during migration
- rich text remains explicitly out of scope until phase 2

## Status

Planning only. No runtime changes have been made by this document.
