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
- Injects the OCE tracking script into your storefront via theme app extension
- Auto-detects Videowise, Tolstoy, Firework, YouTube, Vimeo, and HTML5 video players
- Handles session persistence and event deduplication
- Stores exposure IDs in Shopify cart attributes for order attribution

### 2. Order Webhook → OCE API
- Listens for `orders/create` webhooks from Shopify
- Extracts exposure IDs from cart/note attributes
- Sends order data + exposure IDs to OCE REST API
- Logs all syncs with status tracking and error handling

### 3. Admin Dashboard
- **API Key Management**: Merchants enter and validate their OCE API key
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

## License

Private — built for use with [onsiteaffiliate.com](https://onsiteaffiliate.com)
