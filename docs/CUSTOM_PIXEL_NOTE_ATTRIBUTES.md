# Custom Pixel: Attribution on checkout_completed

A **Shopify Custom Pixel** (Customer events) that subscribes to `checkout_completed` can send attribution to your backend (e.g. pixel-collect) using **checkout.attributes** and, as fallback, **browser.localStorage** (Shopify’s Web Pixels API supports `browser.localStorage` and `browser.sessionStorage` in the pixel context). This gives a second path when the order webhook doesn’t receive cart attributes (e.g. Buy Now / fast checkout).

**Why use a pixel as well as the webhook?** The app’s **order webhook** attributes orders using `order.note_attributes`. That works when the user adds to cart and the OCE SDK has time to sync. For **Buy Now** and fast flows, cart attributes may never make it to the order. The pixel reads `checkout.attributes` first, then falls back to **browser.localStorage** (the SDK now writes the same keys to localStorage on the storefront), and sends `{ order_id, exposure_ids, session_id, oa_id }` to your backend so you don’t depend on the webhook having cart data.

## Where the pixel goes

- **Not in the SDK repo.** The SDK runs on the **storefront**; the Custom Pixel runs in Shopify’s **checkout** context. Configure it in **Shopify Admin**: Settings → Customer events → Add custom pixel → paste the script.
- This repo does not auto-install the pixel via API; the snippet below is for pasting. The app has `read_custom_pixels` / `write_custom_pixels` scopes if you add pixel registration later.

## Caveats (checkout_completed)

- **When it fires:** Thank You page normally; for upsells/post-purchase it can fire on the **first upsell page** instead.
- **If that page never loads,** the event **does not fire at all.** So the pixel is a strong join path but not mathematically perfect.
- **order ID:** `checkout.order.id` is only available on this event (Shopify documents this explicitly).

## What to read

- **checkout.attributes** (documented; array of `{ key, value }`). Do **not** use `checkout.customAttributes` — it is not in the official schema for this event.
- **Fallback:** `browser.localStorage` (async) for `_oce_exposure_ids`, `_oce_session_id`, `_oce_oa_id` when attributes are missing (e.g. Buy Now).

## Recommended pixel (checkout_completed)

Uses `checkout.attributes`, falls back to `browser.localStorage`, tolerates missing/invalid JSON, includes event metadata, and uses `fetch(..., { keepalive: true })` as Shopify recommends for pixels. Replace the endpoint URL and `YOUR_API_KEY` as needed.

```javascript
// Shopify Custom Pixel — checkout_completed
analytics.subscribe("checkout_completed", async (event) => {
  try {
    const checkout = event?.data?.checkout;
    if (!checkout) return;

    const attrs = Array.isArray(checkout.attributes) ? checkout.attributes : [];
    const getAttr = (key) => {
      const hit = attrs.find((a) => a && a.key === key);
      return hit ? hit.value : null;
    };

    let exposureIdsRaw =
      getAttr("_oce_exposure_ids") || getAttr("oce_exposure_ids");
    let sessionId =
      getAttr("_oce_session_id") || getAttr("oce_session_id");
    let oaId =
      getAttr("_oce_oa_id") || getAttr("oce_oa_id");

    // Fallback to browser storage for Buy Now / fast checkout
    if (!exposureIdsRaw) {
      exposureIdsRaw =
        (await browser.localStorage.getItem("_oce_exposure_ids")) ||
        (await browser.localStorage.getItem("oce_exposure_ids")) ||
        null;
    }
    if (!sessionId) {
      sessionId =
        (await browser.localStorage.getItem("_oce_session_id")) ||
        (await browser.localStorage.getItem("oce_session_id")) ||
        null;
    }
    if (!oaId) {
      oaId =
        (await browser.localStorage.getItem("_oce_oa_id")) ||
        (await browser.localStorage.getItem("oce_oa_id")) ||
        null;
    }

    let exposureIds = [];
    if (exposureIdsRaw) {
      try {
        const parsed =
          typeof exposureIdsRaw === "string"
            ? JSON.parse(exposureIdsRaw)
            : exposureIdsRaw;
        exposureIds = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        exposureIds = [];
      }
    }

    const lineItems = Array.isArray(checkout.lineItems)
      ? checkout.lineItems.map((li) => ({
          title: li?.title || null,
          sku: li?.variant?.sku || null,
          quantity: li?.quantity || 0,
          variant_id: li?.variant?.id ? String(li.variant.id) : null,
          product_id: li?.variant?.product?.id
            ? String(li.variant.product.id)
            : null,
        }))
      : [];

    const payload = {
      event_name: event.name,
      event_id: event.id,
      event_timestamp: event.timestamp,
      client_id: event.clientId || null,
      order_id: checkout?.order?.id ? String(checkout.order.id) : null,
      checkout_token: checkout?.token ? String(checkout.token) : null,
      currency: checkout?.currencyCode || "USD",
      total_price: checkout?.totalPrice?.amount
        ? Number(checkout.totalPrice.amount)
        : null,
      exposure_ids: exposureIds,
      session_id: sessionId || null,
      oa_id: oaId || null,
      line_items: lineItems,
    };

    await fetch("https://mqhtzepjrudposuedqbu.supabase.co/functions/v1/pixel-collect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "YOUR_API_KEY",
      },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch (err) {
    console.log("checkout_completed pixel error", err);
  }
});
```

## SDK behavior (storefront)

The OCE SDK (theme extension) writes `_oce_exposure_ids` and `_oce_session_id` to **cart attributes** (for the webhook) and to **localStorage** (for the pixel fallback). When an exposure is recorded or when syncing to cart, both are updated. In the pixel sandbox use **browser.localStorage** (async); on the storefront the SDK uses **window.localStorage**.

## See also

- **PIXEL_AND_STORAGE_PLAN.md** — full design: dual write (cart + localStorage), pixel fallback, caveats.
- Webhook: server uses raw body for HMAC; order handler reads `order.note_attributes`.
