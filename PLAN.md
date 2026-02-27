# Email Domain Acquisition & Outreach System — Implementation Plan

## Overview
Add a complete email outreach system to the existing OCE Shopify App. This introduces three new external API integrations (Cloudflare, Smartlead.ai, Gmail API), five new database models, four new backend service modules, new API routes, a webhook receiver, and a new frontend page for managing domains/accounts/inbox.

---

## Phase 1: Database Schema (Prisma Models)

**File: `prisma/schema.prisma`** — Add 5 new models:

### 1.1 `EmailDomain`
Tracks domains purchased/managed via Cloudflare.

```prisma
model EmailDomain {
  id              String   @id @default(cuid())
  shop            String
  domain          String   @unique
  cloudflareZoneId String?
  registrarStatus String   @default("pending")   // pending | active | failed | expired
  dnsConfigured   Boolean  @default(false)
  mxVerified      Boolean  @default(false)
  spfVerified     Boolean  @default(false)
  dkimVerified    Boolean  @default(false)
  dmarcVerified   Boolean  @default(false)
  purchasedAt     DateTime?
  expiresAt       DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  emailAccounts   EmailAccount[]

  @@index([shop])
}
```

### 1.2 `EmailAccount`
Tracks individual mailboxes connected to Smartlead.

```prisma
model EmailAccount {
  id              String   @id @default(cuid())
  shop            String
  domainId        String
  domain          EmailDomain @relation(fields: [domainId], references: [id])
  emailAddress    String   @unique
  smartleadAccountId String?
  smtpHost        String?
  smtpPort        Int?     @default(587)
  imapHost        String?
  imapPort        Int?     @default(993)
  warmupEnabled   Boolean  @default(true)
  warmupStatus    String   @default("pending")  // pending | active | completed | paused
  dailySendLimit  Int      @default(20)
  status          String   @default("active")   // active | paused | disabled | error
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([shop])
  @@index([domainId])
}
```

### 1.3 `OutreachCampaign`
Tracks Smartlead campaigns linked to this app.

```prisma
model OutreachCampaign {
  id                String   @id @default(cuid())
  shop              String
  name              String
  smartleadCampaignId String?
  status            String   @default("draft")  // draft | active | paused | completed
  emailAccountIds   String?  // JSON array of EmailAccount IDs assigned
  totalLeads        Int      @default(0)
  totalSent         Int      @default(0)
  totalReplies      Int      @default(0)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([shop])
}
```

### 1.4 `EmailConversation`
Stores inbound replies caught via Smartlead webhook.

```prisma
model EmailConversation {
  id              String   @id @default(cuid())
  shop            String
  campaignId      String?
  fromEmail       String
  toEmail         String
  subject         String?
  body            String
  bodyHtml        String?
  direction       String   @default("inbound") // inbound | outbound
  smartleadLeadId String?
  gmailMessageId  String?  // Set if forwarded to Gmail
  isRead          Boolean  @default(false)
  createdAt       DateTime @default(now())

  @@index([shop])
  @@index([campaignId])
  @@index([fromEmail])
}
```

### 1.5 `EmailSettings`
Per-shop configuration for the email system (API keys, WHOIS defaults, Gmail OAuth).

```prisma
model EmailSettings {
  id                    String   @id @default(cuid())
  shop                  String   @unique
  cloudflareAccountId   String   @default("")
  cloudflareApiToken    String   @default("")
  smartleadApiKey       String   @default("")
  gmailAccessToken      String?
  gmailRefreshToken     String?
  gmailEmail            String?
  whoisFirstName        String   @default("")
  whoisLastName         String   @default("")
  whoisAddress1         String   @default("")
  whoisCity             String   @default("")
  whoisState            String   @default("")
  whoisZip              String   @default("")
  whoisCountry          String   @default("US")
  whoisPhone            String   @default("")
  whoisEmail            String   @default("")
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  @@index([shop])
}
```

After creating models: `npx prisma db push` to apply.

---

## Phase 2: Backend Services (API Clients)

### 2.1 Cloudflare Service
**File: `web/backend/services/cloudflare-api.js`**

Class `CloudflareService` with methods:
- `constructor(apiToken, accountId)` — store credentials
- `request(method, path, body)` — base HTTP helper with `Authorization: Bearer {apiToken}`
- `searchDomains(query)` — `GET /accounts/{id}/registrar/domains/search?query={query}`
- `purchaseDomain(domain, contactInfo, years)` — `POST /accounts/{id}/registrar/domains/purchase`
- `getZoneId(domain)` — `GET /zones?name={domain}` — returns zone ID
- `createDnsRecord(zoneId, record)` — `POST /zones/{zoneId}/dns_records`
- `listDnsRecords(zoneId)` — `GET /zones/{zoneId}/dns_records`
- `provisionColdEmailDns(zoneId, domain, emailProvider)` — high-level method that creates MX, SPF, DKIM, DMARC records
- `verifyDnsRecords(zoneId, domain)` — checks that required records exist and are propagated

Uses the Cloudflare API v4 base URL: `https://api.cloudflare.com/client/v4`

### 2.2 Smartlead Service
**File: `web/backend/services/smartlead-api.js`**

Class `SmartleadService` with methods:
- `constructor(apiKey)` — store API key
- `request(method, path, body)` — base HTTP helper, passes `api_key` as query param
- `addEmailAccount({ fromEmail, userName, smtpHost, smtpPort, imapHost, imapPort, smtpPassword, imapPassword })` — `POST /api/v1/email-accounts/save`
- `getEmailAccount(id)` — `GET /api/v1/email-accounts/{id}`
- `updateWarmup(emailAccountId, enabled)` — `POST /api/v1/email-accounts/{id}/warmup` with `{ warmup_enabled: enabled }`
- `getWarmupStats(emailAccountId)` — `GET /api/v1/email-accounts/{id}/warmup-stats`
- `listCampaigns()` — `GET /api/v1/campaigns`
- `createCampaign(name)` — `POST /api/v1/campaigns/create`
- `addEmailsToCampaign(campaignId, emailAccountIds)` — `POST /api/v1/campaigns/{id}/email-accounts`
- `getCampaignStats(campaignId)` — `GET /api/v1/campaigns/{id}`

Uses Smartlead base URL: `https://server.smartlead.ai`

### 2.3 Gmail Forwarding Service
**File: `web/backend/services/gmail-api.js`**

Class `GmailService` with methods:
- `constructor(accessToken, refreshToken, clientId, clientSecret)` — store OAuth credentials
- `refreshAccessToken()` — exchanges refresh token for new access token via Google OAuth
- `insertMessage({ from, to, subject, body, inReplyTo })` — uses Gmail API `POST /gmail/v1/users/me/messages/import` to insert message into inbox preserving headers
- `buildRawMessage({ from, to, subject, body })` — builds RFC 2822 MIME message, base64url-encodes it

Uses Google Gmail API base URL: `https://gmail.googleapis.com`

---

## Phase 3: Backend Routes

### 3.1 Email Settings Routes
**File: `web/backend/routes/email-settings.js`**

- `getEmailSettings(shop)` — returns EmailSettings (masks API tokens for display)
- `updateEmailSettings(shop, updates)` — whitelist-validated upsert
- `testCloudflareConnection(shop)` — validates Cloudflare token by calling `/user/tokens/verify`
- `testSmartleadConnection(shop)` — validates Smartlead key by fetching campaigns list

### 3.2 Domain Management Routes
**File: `web/backend/routes/email-domains.js`**

- `searchDomains(shop, query)` — proxies to Cloudflare domain search
- `purchaseDomain(shop, domain, years)` — purchases domain via Cloudflare, stores in DB, kicks off DNS provisioning
- `provisionDns(shop, domainId)` — creates MX/SPF/DKIM/DMARC records on Cloudflare
- `verifyDns(shop, domainId)` — checks DNS propagation status, updates DB flags
- `listDomains(shop)` — returns all EmailDomain records for the shop
- `getDomainStatus(shop, domainId)` — detailed status for a single domain

### 3.3 Email Account Routes
**File: `web/backend/routes/email-accounts.js`**

- `createEmailAccount(shop, { domainId, localPart, password })` — creates mailbox in Smartlead, stores in DB, enables warmup
- `listEmailAccounts(shop)` — returns all accounts with warmup status
- `toggleWarmup(shop, accountId, enabled)` — enables/disables warmup via Smartlead
- `getWarmupStats(shop, accountId)` — fetches current warmup metrics from Smartlead
- `assignToCampaign(shop, accountId, campaignId)` — links account to campaign in Smartlead

### 3.4 Campaign Routes
**File: `web/backend/routes/email-campaigns.js`**

- `createCampaign(shop, name)` — creates campaign in Smartlead + DB
- `listCampaigns(shop)` — returns campaigns with stats
- `getCampaignDetail(shop, campaignId)` — detailed view with email accounts + metrics

### 3.5 Inbox / Conversation Routes
**File: `web/backend/routes/email-inbox.js`**

- `listConversations(shop, { campaignId, page, limit })` — paginated inbox view
- `getConversation(shop, conversationId)` — single conversation detail
- `markAsRead(shop, conversationId)` — marks conversation as read
- `getInboxStats(shop)` — unread count, total replies, per-campaign breakdown

---

## Phase 4: Webhook Endpoint for Smartlead Replies

### 4.1 Smartlead Webhook Handler
**In `web/server.js`** — add new webhook endpoint:

```
POST /webhooks/smartlead/reply
```

No HMAC verification (Smartlead doesn't sign webhooks), but will validate the payload structure and optionally check a shared secret query parameter.

Flow:
1. Receive JSON payload with `from_email`, `to_email`, `email_body`, `subject`, `campaign_name`, `lead_id`
2. Look up the shop by matching `to_email` → EmailAccount → shop
3. Create EmailConversation record (direction: "inbound")
4. If Gmail forwarding is configured for this shop, call GmailService.insertMessage()
5. Return 200 OK

---

## Phase 5: Wire Routes into Express Server

**File: `web/server.js`** — additions:

1. Import all new route modules
2. Add the Smartlead webhook endpoint (before `express.json()` middleware, similar to Shopify webhooks)
3. Add authenticated API routes:

```
GET    /api/email/settings              → getEmailSettings
PUT    /api/email/settings              → updateEmailSettings
POST   /api/email/settings/test-cf      → testCloudflareConnection
POST   /api/email/settings/test-sl      → testSmartleadConnection

GET    /api/email/domains               → listDomains
POST   /api/email/domains/search        → searchDomains
POST   /api/email/domains/purchase      → purchaseDomain
POST   /api/email/domains/:id/provision → provisionDns
POST   /api/email/domains/:id/verify    → verifyDns
GET    /api/email/domains/:id           → getDomainStatus

GET    /api/email/accounts              → listEmailAccounts
POST   /api/email/accounts              → createEmailAccount
POST   /api/email/accounts/:id/warmup   → toggleWarmup
GET    /api/email/accounts/:id/warmup   → getWarmupStats
POST   /api/email/accounts/:id/assign   → assignToCampaign

GET    /api/email/campaigns             → listCampaigns
POST   /api/email/campaigns             → createCampaign
GET    /api/email/campaigns/:id         → getCampaignDetail

GET    /api/email/inbox                 → listConversations
GET    /api/email/inbox/stats           → getInboxStats
GET    /api/email/inbox/:id             → getConversation
PUT    /api/email/inbox/:id/read        → markAsRead

POST   /webhooks/smartlead/reply        → handleSmartleadReply (unauthenticated)
```

---

## Phase 6: Environment Variables

**File: `.env.example`** — add:

```env
# Email System - Google OAuth (for Gmail forwarding)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Email System - Smartlead webhook secret (optional, for verifying webhook origin)
SMARTLEAD_WEBHOOK_SECRET=
```

Note: Cloudflare API token and Smartlead API key are per-merchant (stored in EmailSettings), not global env vars. Google OAuth client ID/secret are app-level.

---

## Phase 7: Frontend — Email Outreach Dashboard

**Approach**: Add a new page section to the existing admin HTML in `getAdminHTML()`. Add tab navigation to switch between "OCE" and "Email Outreach" views.

### 7.1 Navigation
Add tab bar at top: **OCE Dashboard** | **Email Outreach**

### 7.2 Email Outreach Page Sections

**Section A: Settings Card**
- Cloudflare Account ID + API Token inputs (masked)
- Smartlead API Key input (masked)
- Gmail connect button (OAuth flow)
- WHOIS contact info form (for domain registration)
- Test connection buttons for CF + SL

**Section B: Domain Manager Card**
- Domain search input + "Check Availability" button
- Search results with "Purchase" button
- Owned domains table: domain, status, DNS badges (MX/SPF/DKIM/DMARC), actions
- "Provision DNS" and "Verify DNS" buttons per domain

**Section C: Email Accounts Card**
- "Add Account" form: select domain, enter local part (user@), password
- Accounts table: email, warmup status, daily limit, assigned campaign, actions
- Toggle warmup on/off per account

**Section D: Campaigns Card**
- "Create Campaign" button + name input
- Campaigns table: name, status, linked accounts, sent/reply counts

**Section E: Inbox Card**
- Filter by campaign dropdown
- Conversations list: from, subject, preview, timestamp, read/unread badge
- Click to expand full message body
- Unread count badge in tab header

---

## Phase 8: Implementation Order

Execute in this sequence (each step builds on previous):

| Step | What | Files |
|------|------|-------|
| 1 | Add Prisma models | `prisma/schema.prisma` |
| 2 | Run `prisma db push` | — |
| 3 | Create CloudflareService | `web/backend/services/cloudflare-api.js` |
| 4 | Create SmartleadService | `web/backend/services/smartlead-api.js` |
| 5 | Create GmailService | `web/backend/services/gmail-api.js` |
| 6 | Create email-settings routes | `web/backend/routes/email-settings.js` |
| 7 | Create email-domains routes | `web/backend/routes/email-domains.js` |
| 8 | Create email-accounts routes | `web/backend/routes/email-accounts.js` |
| 9 | Create email-campaigns routes | `web/backend/routes/email-campaigns.js` |
| 10 | Create email-inbox routes | `web/backend/routes/email-inbox.js` |
| 11 | Wire routes + webhook into server.js | `web/server.js` |
| 12 | Update .env.example | `.env.example` |
| 13 | Build frontend UI (tabs + all sections) | `web/server.js` (getAdminHTML) |
| 14 | Test end-to-end | — |

---

## Security Considerations

- **API tokens encrypted at rest**: Cloudflare token, Smartlead key, and Gmail tokens stored in DB. Consider encrypting sensitive fields before storage (AES-256 with app-level encryption key from env var).
- **Smartlead webhook validation**: Use a shared secret query param (`?secret=xxx`) since Smartlead doesn't sign payloads.
- **Gmail OAuth**: Standard OAuth 2.0 flow with PKCE. Refresh tokens stored securely. Access tokens refreshed on demand.
- **WHOIS privacy**: Cloudflare supports WHOIS privacy by default on supported TLDs.
- **Rate limiting**: Cloudflare API has rate limits (1200 req/5min). Smartlead varies by plan. Add backoff/retry logic similar to OceApiService.
- **No secrets in frontend**: All API tokens masked before sending to browser. Actual tokens never leave the server.
