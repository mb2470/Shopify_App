# Onsite Commission Engine — Shopify App

A Shopify embedded app that integrates with the [Onsite Commission Engine (OCE)](https://app.onsiteaffiliate.com) to track creator video engagement and attribute conversions for commission payouts.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 Shopify Store                    │
│                                                  │
│  ┌──────────────┐        ┌───────────────────┐  │
│  │ Video Player │        │    Checkout        │  │
│  │ (Videowise,  │        │  (Shopify Cart)    │  │
│  │  Tolstoy...) │        │                    │  │
│  └──────┬───────┘        └────────┬──────────┘  │
│         │                         │              │
│  ┌──────▼───────┐        ┌───────▼──────────┐  │
│  │  OCE SDK     │        │  Order Webhook    │  │
│  │  (auto-      │        │  (orders/create)  │  │
│  │   injected)  │        │                   │  │
│  └──────┬───────┘        └───────┬──────────┘  │
└─────────┼────────────────────────┼──────────────┘
          │                        │
          │  exposure_id,          │  order_id,
          │  asset_id, sku         │  exposure_ids[]
          │                        │
          ▼                        ▼
    ┌─────────────────────────────────────┐
    │          OCE REST API               │
    │  POST /events-exposure              │
    │  POST /orders                       │
    │  X-API-Key Auth                     │
    └──────────────┬──────────────────────┘
                   │
                   ▼
    ┌─────────────────────────────────────┐
    │    Onsite Commission Engine         │
    │  ┌───────────┬──────────┬────────┐ │
    │  │ Exposure  │Attribut- │Commis- │ │
    │  │ Tracking  │ion Engine│sion    │ │
    │  │           │          │Calc    │ │
    │  └───────────┴──────────┴────────┘ │
    └─────────────────────────────────────┘
```

## Features

### 1. OCE SDK Auto-Injection
- Injects the OCE tracking script into your storefront via a **theme app extension** (app embed block, `target: head`).
- **Enable on all pages:** In the theme editor go to **Theme settings → App embeds** and enable **OCE Tracking SDK** (or **OCE Script**). When enabled, the SDK loads on every page (home, collection, product, cart, etc.) so all video engagements are tracked, not only on product or cart.
- Auto-detects Videowise, Tolstoy, Firework, YouTube, Vimeo, and HTML5 video players.
- Handles session persistence and event deduplication.
- Stores exposure IDs in Shopify cart attributes and in `localStorage` (for pixel fallback); order webhook and optional Custom Pixel use them for attribution.

### 2. Order Webhook → OCE API
- Listens for `orders/create` webhooks from Shopify
- Extracts **exposure IDs** (OCE’s “engagement” identifiers) from cart/note attributes (`_oce_exposure_ids`, `_oce_session_id`)
- Sends order data + `exposure_ids` (and optional `session_id`) to OCE REST API
- Logs all syncs with status tracking and error handling

**Important:** In OCE/Onsite Affiliate, the ID that links a video engagement to an order is the **exposure_id** (returned from the exposure creation endpoint). The app stores these in cart attributes so the order webhook can send them as `exposure_ids`; the backend expects exactly that field name.

### 3. Admin Dashboard
- **API Key Management**: Merchants can paste their OCE API key manually, or the app can **auto-create one on install** (see below).
- **Integration Status**: Real-time health monitoring of SDK, webhook, and API connection
- **Attribution Settings**: Configure model (first/last touch), window, commission rates
- **Qualifying Events**: Toggle impression, click, and watch progress tracking
- **Quick Start Checklist**: Guided onboarding flow for new merchants

## Setup

### Prerequisites
- Node.js 18+
- Shopify CLI (`npm install -g @shopify/cli`)
- A Shopify Partner account
- An OCE account at [app.onsiteaffiliate.com](https://app.onsiteaffiliate.com)

### Installation

```bash
# 1. Clone and install
cd oce-shopify-app
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env with your Shopify app credentials

# 3. Set up database
npx prisma generate
npx prisma db push

# 4. Start development
npm run dev
# or: shopify app dev
```

### Shopify Partner Setup

1. Create a new app in your [Shopify Partner Dashboard](https://partners.shopify.com)
2. Set the App URL to your development URL (use `shopify app dev` for tunneling)
3. Add required scopes: `read_orders`, `write_script_tags`, `read_products`, `read_customers`
4. Configure the `orders/create` webhook
5. Copy the API key and secret to your `.env` file

### Optional: Auto-create OCE API key on install

If you run the Onsite Affiliate backend and expose an install endpoint, set in `.env`:

- **OCE_INSTALL_URL** — Full URL of the install endpoint (e.g. `https://…/functions/v1/integrations/shopify/install`).
- **OCE_INSTALL_SECRET** — Server-to-server secret (sent as `X-API-Key` when calling the install endpoint).
- **OCE_PUBLIC_SITE_URL** — Optional public Onsite Affiliate site URL (for example `https://app.onsiteaffiliate.com`). Used to derive `https://.../join/{brand_slug}` if the install response includes `brand_slug` but not an explicit creator portal URL.

On Shopify app install (OAuth callback), the app will `POST` `{ shop }` to that URL; the backend should return `{ api_key }`. The app then stores the key and syncs it to the storefront (metafields), so the merchant does not need to paste an API key. If these env vars are not set or the request fails, the merchant can still add an API key manually in the dashboard.

## Project Structure

```
oce-shopify-app/
├── shopify.app.toml          # Shopify app configuration
├── package.json
├── .env.example
├── prisma/
│   └── schema.prisma          # Database schema (sessions, settings, orders, assets)
├── web/
│   ├── server.js              # Remix server entry, Shopify auth, webhook registration
│   ├── backend/
│   │   ├── routes/
│   │   │   ├── settings.js    # Settings CRUD API
│   │   │   └── webhooks.js    # Order webhook → OCE API handler
│   │   └── services/
│   │       └── oce-api.js     # OCE REST API client
│   └── frontend/
│       └── pages/
│           └── index.jsx      # Admin dashboard (React/Polaris)
└── extensions/
    └── oce-script-tag/
        ├── shopify.extension.toml
        └── blocks/
            └── oce-sdk.liquid # Storefront SDK injection
```

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Exposure** | A user's engagement session with a creator's video. Tracks events from first impression through video completion. |
| **Attribution** | Links orders to creator exposures based on configurable rules (time window, qualifying events, model). |
| **Qualifying Events** | Events (impressions, clicks, watch milestones) that must occur for an exposure to be eligible. |
| **Commission** | Percentage of attributed revenue paid to creators. Set default rates and per-SKU/creator overrides. |

## API Reference

The app communicates with the OCE REST API at `https://app.onsiteaffiliate.com`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/events-exposure` | POST | Send video exposure events |
| `/api/v1/orders` | POST | Send order data for attribution |
| `/api/v1/assets` | GET/POST | Manage video assets |
| `/api/v1/reports/attribution` | GET | Attribution reports |
| `/api/v1/reports/commissions` | GET | Commission summaries |
| `/api/v1/account` | GET | Validate API key |

All requests use `X-API-Key` header authentication.

## Troubleshooting: Exposure IDs not on orders / attributes missing in notes

If the order webhook or pixels don’t see `_oce_exposure_ids` or `_oce_session_id` in the order’s note attributes, the cart never had those attributes at checkout time. The SDK writes them via the Cart API; Shopify copies cart attributes into the order as `note_attributes`.

### What the app expects

- **Cart attributes** (set by the storefront SDK): `_oce_exposure_ids` (JSON array of strings), `_oce_session_id` (string).
- **Order payload**: Same names appear in `order.note_attributes`. The webhook reads those and sends them to the OCE API.

### Common causes and fixes

1. **User leaves before the cart update runs**  
   The SDK now uses `navigator.sendBeacon` on `beforeunload` so a cart update is sent when the user navigates to checkout (e.g. clicks “Checkout”), and it retries failed `fetch` once. Ensure the theme has the OCE SDK block enabled and that no script is blocking or overriding `beforeunload`.

2. **Checkout without visiting cart**  
   If the theme sends users straight to checkout (e.g. “Buy now”), they may never hit the cart page where we sync. The SDK syncs on DOMContentLoaded, visibilitychange, and (with beacon) beforeunload. For “Buy now” flows, attributes are only attached if an earlier page view already synced exposures to the cart (e.g. they had the cart open in another tab or had previously added to cart and we had synced).

3. **`oce is not defined` (oce.min.js)**  
   This usually comes from the external `oce.min.js` script or another script expecting `window.oce` before it’s set. The app’s **inline** logic does not depend on `oce`; it creates exposures via the `/apps/onsite-affiliate/exposure` proxy and listens for `oce:exposure`. If the external SDK is optional for your flow, you can still get exposures and cart attributes. If you rely on the external script, ensure it loads (e.g. correct `app.metafields.oce.api_key`) and that nothing runs before it defines `oce`.

4. **401 on thank-you / checkout**  
   A 401 for something like `private_access_token` or checkout URLs is typically from Shopify’s checkout or another app, not from the OCE exposure proxy. The exposure endpoint is `/apps/onsite-affiliate/exposure` (POST); it uses the app proxy and expects `shop` in the query. If you see 401s on that URL, check proxy configuration and that the storefront is calling the proxy with the correct `shop` (Shopify usually appends it).

5. **Verify what Shopify sends**  
   When the webhook runs, the app logs `[OCE] Order <id> note_attributes (N): [...]` for every order. Check your server logs for that line to see whether `_oce_exposure_ids` and `_oce_session_id` are present. If they’re missing there, the fix is on the storefront/cart side (above). If they’re present but a pixel or other consumer doesn’t see them, the issue is with that consumer reading `note_attributes`.

### Quick checks on the storefront

- Open DevTools → Application → Local Storage / Session Storage: look for `_oce_session_id` and `_oce_exposure_ids` after playing a tracked video.
- On the cart page, open Network, then click “Checkout”: you should see a POST to `cart/update.js` and/or a `sendBeacon` to `cart/update.js` with the OCE attributes before the redirect.

## License

Private — built for use with [onsiteaffiliate.com](https://onsiteaffiliate.com)
