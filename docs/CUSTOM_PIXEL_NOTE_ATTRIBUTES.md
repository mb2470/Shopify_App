# Custom Pixel: Reading note_attributes for attribution

If you use a **Shopify Custom Pixel** (e.g. in Customer events) that sends order/checkout data to an endpoint (e.g. pixel-collect), the pixel runs in a **sandbox** and cannot read cookies or localStorage. Attribution data is only available from the **checkout event payload**.

## What to read and send

From the checkout/order event, read **note_attributes** (cart attributes are copied here by Shopify) and include them in the payload you send to your endpoint:

| note_attribute name     | Send as        | Description                    |
|-------------------------|----------------|--------------------------------|
| `_oce_exposure_ids` or `oce_exposure_ids` | `exposure_ids` | JSON array of exposure IDs     |
| `_oce_session_id` or `oce_session_id`     | `session_id`   | Session identifier              |
| `_oce_oa_id` or `oce_oa_id`               | `oa_id`        | Onsite Affiliate identity       |

## Example (pseudo-code for your pixel)

When building the payload for the order/checkout event:

```javascript
// event.data.checkout or event.data.order (depending on Shopify event shape)
const checkout = event.data?.checkout ?? event.data?.order ?? {};
const noteAttributes = checkout.note_attributes ?? checkout.noteAttributes ?? [];

function getAttr(name) {
  const a = noteAttributes.find(
    (x) => x.name === name || x.name === `_${name.replace('oce_', 'oce_')}`
  );
  return a?.value ?? null;
}

// Prefer underscore-prefixed names (cart attributes set by OCE SDK)
const exposureIdsRaw = getAttr("_oce_exposure_ids") ?? getAttr("oce_exposure_ids");
const exposureIds = exposureIdsRaw
  ? (typeof exposureIdsRaw === "string" ? JSON.parse(exposureIdsRaw) : exposureIdsRaw)
  : [];
const sessionId = getAttr("_oce_session_id") ?? getAttr("oce_session_id");
const oaId = getAttr("_oce_oa_id") ?? getAttr("oce_oa_id");

// Include in the payload you POST to pixel-collect (or your endpoint)
const payload = {
  // ... your existing order/checkout fields ...
  exposure_ids: exposureIds,
  session_id: sessionId ?? null,
  oa_id: oaId ?? null,
};
```

## Why this fixes unattributed orders

- The **OCE SDK** writes these values to **cart attributes** (e.g. via `/cart/update.js`). Shopify then copies them into the order as **note_attributes**.
- If the pixel does **not** read `note_attributes` and add `exposure_ids`, `session_id`, and `oa_id` to the payload, the receiving endpoint will always get empty attribution.
- HMAC and webhook handling are separate (see server: webhooks use raw body for verification).
