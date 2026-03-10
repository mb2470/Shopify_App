# Pixel + localStorage plan: reliable attribution for webhook and Buy Now

## Problem

- **Webhook path**: Works when the user adds to cart and the OCE SDK has time to sync cart attributes. Shopify copies cart attributes into the order as `note_attributes`; the app’s order webhook reads them and sends the order to OCE.
- **Buy Now / fast checkout**: Cart attributes are often not present (user never visited cart, or intercept didn’t run / didn’t complete in time). The webhook then receives the order with empty `note_attributes` → unattributed.
- **checkout_completed pixel**: Fires on the Thank You page (or on the first upsell/post-purchase page). It receives `event.data.checkout` with `checkout.attributes` (cart/checkout attributes). If attributes didn’t make it to the cart, the pixel can still attribute if the same identifiers are available in **browser storage**, which Shopify’s Web Pixels API exposes as `browser.localStorage` / `browser.sessionStorage`.

## Design: dual write + pixel fallback

1. **SDK (storefront)**  
   When an exposure is recorded and whenever we sync to cart, write the same identifiers to:
   - **Cart attributes** (existing): `_oce_exposure_ids`, `_oce_session_id` (and `_oce_oa_id` if/when we have it) via `/cart/update.js`.
   - **localStorage** (backup): same keys, so the checkout pixel can read them if `checkout.attributes` is empty.

2. **Custom Pixel (checkout_completed)**  
   - Use **checkout.attributes** first (documented field; `checkout.order.id` is only available on this event).
   - **Fallback** to **browser.localStorage** (Shopify’s pixel API) for `_oce_exposure_ids`, `_oce_session_id`, `_oce_oa_id`.
   - Send `{ order_id, exposure_ids, session_id, oa_id, ... }` to the backend (e.g. pixel-collect). This does not depend on the order webhook containing cart data.

3. **Caveats (checkout_completed)**  
   - Fires on the **Thank You** page; for upsells/post-purchase it can fire on the **first upsell page** instead.
   - If that page never loads, the event **does not fire at all**. So the pixel is a strong join path but not mathematically perfect.

## Implementation checklist

| Where | What |
|-------|------|
| **SDK (oce-sdk.liquid)** | On exposure and when syncing to cart: write `_oce_exposure_ids` and `_oce_session_id` to **localStorage** (in addition to sessionStorage and cart). Block is an **app embed** (`target: head`); when enabled in Theme settings → App embeds it runs on **all pages** for full video engagement coverage. |
| **Custom Pixel** | Paste in Shopify Admin → Customer events. Use recommended snippet: `checkout.attributes` first, fallback `browser.localStorage`; tolerant JSON parsing; event metadata; `fetch(..., { keepalive: true })`. |
| **Backend** | pixel-collect (or equivalent) accepts payload from pixel with `order_id`, `exposure_ids`, `session_id`, `oa_id` and performs attribution. |

## Storage keys (aligned SDK ↔ pixel)

- `_oce_exposure_ids` — JSON array string (or same key without leading underscore as fallback).
- `_oce_session_id` — string.
- `_oce_oa_id` — string (optional; set when we have an oa_id source in the SDK).

## References

- Shopify Web Pixels API: `checkout_completed` exposes `checkout.attributes` (array of `{ key, value }`), `checkout.order.id`, and supports `browser.localStorage` / `browser.sessionStorage`.
- Doc: `docs/CUSTOM_PIXEL_NOTE_ATTRIBUTES.md` — recommended pixel snippet and caveats.
