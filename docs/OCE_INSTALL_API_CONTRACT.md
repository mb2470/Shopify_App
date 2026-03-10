# OCE Install API contract (auto-create API key on install)

When **OCE_INSTALL_URL** and **OCE_INSTALL_SECRET** are set, the Shopify app calls the Onsite Affiliate backend on install to obtain an API key so the merchant does not need to paste one manually.

## Request

- **Method:** `POST`
- **URL:** Value of `OCE_INSTALL_URL` (e.g. `https://…/functions/v1/integrations/shopify/install`)
- **Headers:**
  - `Content-Type: application/json`
  - `X-API-Key: <OCE_INSTALL_SECRET>`
- **Body:**
  ```json
  { "shop": "store-name.myshopify.com" }
  ```

## Response (success)

- **Status:** `200`
- **Body:** JSON with an API key for this shop, e.g.:
  ```json
  { "api_key": "oce_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
  ```
  Alternatively the backend can return `apiKey` (camelCase); the app accepts either.

## Response (failure)

- Non-200 status or missing `api_key` in body: the app logs a warning and does not set a key. The merchant can still add an API key manually in the dashboard.

## Backend responsibilities

The Onsite Affiliate backend should:

1. Authenticate the request using `X-API-Key` (match against `OCE_INSTALL_SECRET` or a server-side secret).
2. Use `shop` to create or link an OCE org/tenant for this Shopify store.
3. Create or retrieve an API key (token) for that org that the Shopify app will use for all OCE API calls (exposures, orders, assets, etc.).
4. Return that key in the response.

If the shop is already linked, the backend may return the existing API key (idempotent behavior).
