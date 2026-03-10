# Checkout / Buy Now attribution intercept — plan and best practices

## Goals

- Attach OCE attribution (exposure IDs, session ID) to the cart **before** the user is redirected to checkout, including when they use **Checkout** or **Buy Now** (so we don’t rely only on `beforeunload`).
- Do this in a way that is safe for conversion and acceptable to brands: **optional**, **time-bounded**, and **non-blocking**.

## Rules (all implementations must follow)

| Rule | Requirement |
|------|-------------|
| **Optionality** | Feature is **default ON**; brands can turn it **OFF** (e.g. app setting / metafield). When OFF, no intercept — normal navigation. |
| **400ms hard limit** | Wait for sync at most **400ms**. After 400ms, stop waiting and proceed. |
| **Redirect regardless** | Always redirect (or allow default navigation) after the cap, whether sync succeeded, failed, or timed out. Never block the user. |
| **Minimal cart update** | Cart update payload contains **only** the data needed for attribution: `attributes: { _oce_exposure_ids, _oce_session_id }`. No extra fields. |

## Where we intercept

1. **Checkout** — Links or buttons that navigate to `/checkout` or checkout URL (e.g. cart drawer “Checkout”, cart page “Checkout”).
2. **Buy Now** — Buttons/forms that add to cart and immediately send the user to checkout (e.g. “Buy it now” on PDP). These often bypass the cart page, so the only chance to attach attributes is on that click.

## Implementation approach

- **Optionality**: New app setting `interceptAttribution` (DB: `OceSettings.interceptAttribution`, default `true`). Synced to app metafield `oce.intercept_attribution` so the theme extension can read it. When `false`, no click intercept runs.
- **400ms + redirect**: On interceptible click:
  - Prevent default navigation.
  - Start a single minimal cart-update request (same payload as today: only the two attributes).
  - Set a 400ms timer. When it fires (or when the request completes earlier), allow redirect: e.g. `window.location.href = targetUrl` or programmatic form submit. Do **not** wait for the request to succeed.
- **Payload**: Keep using the existing minimal payload: `{ attributes: { _oce_exposure_ids: JSON.stringify(ids), _oce_session_id: sessionId } }`. No new keys.

## Audit of current implementations

### 1. `extensions/oce-script-tag/blocks/oce-sdk.liquid`

- **Checkout / Buy Now intercept**: **None today.** The block only:
  - Syncs on `DOMContentLoaded`, on cart page with short delays (0, 200ms, 600ms), on `beforeunload` (sendBeacon), and on `visibilitychange`.
  - Does **not** intercept clicks on Checkout or Buy Now.
- **400ms / redirect**: N/A (no intercept). `updateCartAttributes` and `sendCartAttributesBeacon` have no timeout; they are fire-and-forget or best-effort. When we add intercept, it **must** use a 400ms cap and redirect regardless.
- **Payload**: **Already minimal** — only `_oce_exposure_ids` and `_oce_session_id` in `attributes`. ✓
- **Optionality**: No setting yet. Will add and respect `interceptAttribution` (default ON).

**Conclusion**: Add intercept logic here that follows the four rules; keep existing payload as-is.

### 2. `extensions/oce-script-tag/blocks/video-player.liquid`

- **Role**: Demo/debug block: listens for `oce:exposure` and calls `updateCartAttributes(stored)` with the same payload shape (`_oce_exposure_ids`, `_oce_session_id`). No checkout/Buy Now intercept.
- **Payload**: Same minimal attributes. ✓
- **400ms / redirect**: N/A (no redirect). No change required for the plan; this block does not perform intercept.

**Conclusion**: No changes needed for intercept best practices. Payload already minimal.

### 3. External SDK (`oce.min.js`)

- If the hosted SDK at `app.onsiteaffiliate.com/sdk/oce.min.js` implements any checkout or Buy Now intercept, that implementation **must** follow the same four rules (optionality, 400ms cap, redirect regardless, minimal payload). Configuration (e.g. intercept on/off) can be passed via `data-*` attributes from the Liquid block.

## Summary

- **Optionality**: `interceptAttribution` (default ON) is stored in `OceSettings`, synced to app metafield `oce.intercept_attribution`, and exposed in the admin as “Intercept checkout / Buy now” (toggle). Liquid reads `window._oceInterceptAttribution`; when OFF, no intercept runs.
- **400ms + redirect**: Intercept in `oce-sdk.liquid` caps wait at 400ms and always redirects after that (link or form submit).
- **Minimal payload**: Cart update uses only `attributes: { _oce_exposure_ids, _oce_session_id }`.
- **Implementations**: `oce-sdk.liquid` has the intercept; `video-player.liquid` only updates cart on exposure (no intercept). External SDK must follow the same rules if it handles checkout/Buy Now.

## Deploy note

- Run `prisma generate` and `prisma db push` (or your usual migration) so `OceSettings.interceptAttribution` exists. New installs get default `true`; existing rows get `true` when the column is added.
- After toggling “Intercept checkout / Buy now” in the admin, metafields are synced via existing `PUT /api/settings` → `syncAppMetafields`.
