/**
 * OCE Admin Dashboard — Main Page
 * Embedded Shopify admin panel for managing the OCE integration
 */

import { useState, useCallback, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  Banner,
  Badge,
  BlockStack,
  InlineStack,
  InlineGrid,
  Box,
  Divider,
  TextField,
  Icon,
  Spinner,
  Link,
  SkeletonBodyText,
  Collapsible,
  ButtonGroup,
} from "@shopify/polaris";
import {
  CheckCircleIcon,
  XCircleIcon,
  AlertTriangleIcon,
  PlayIcon,
  SettingsIcon,
  ChartVerticalIcon,
  CodeIcon,
  OrderIcon,
} from "@shopify/polaris-icons";
import { useLoaderData, useSubmit, useActionData, useNavigation, useFetcher } from "@remix-run/react";
import { json } from "@remix-run/node";
import { getSettings, updateSettings, updateApiKey, getIntegrationStatus, syncAppMetafields, getStatsOverview } from "../backend/routes/settings.js";
import shopify from "../server.js";

// ─── Remix Loader / Action ────────────────────────────────────────

export async function loader({ request }) {
  const { session } = await shopify.authenticate.admin(request);
  const shop = session.shop;

  const [settings, status] = await Promise.all([
    getSettings(shop),
    getIntegrationStatus(shop),
  ]);

  return json({ settings, status, shop });
}

export async function action({ request }) {
  const { session } = await shopify.authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    switch (intent) {
      case "save-api-key": {
        const apiKey = formData.get("apiKey");
        const result = await updateApiKey(shop, apiKey);
        const syncResult = await syncAppMetafields(shop, session.accessToken);
        console.log("[OCE] Remix API key sync result:", JSON.stringify(syncResult));
        return json({ ...result, metafieldSync: syncResult });
      }
      case "save-settings": {
        const updates = JSON.parse(formData.get("settings"));
        const result = await updateSettings(shop, updates);
        const syncResult = await syncAppMetafields(shop, session.accessToken);
        console.log("[OCE] Remix settings sync result:", JSON.stringify(syncResult));
        return json({ success: true, settings: result, metafieldSync: syncResult });
      }
      case "fetch-stats": {
        const periodDays = parseInt(formData.get("periodDays")) || 30;
        const result = await getStatsOverview(shop, periodDays);
        return json({ statsResult: result });
      }
      default:
        return json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    console.error("[OCE] Remix action error:", err);
    return json({ error: err.message }, { status: 500 });
  }
}

// ─── Main Component ───────────────────────────────────────────────

export default function OceDashboard() {
  const { settings, status, shop } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state === "submitting";

  // ─── API Key State ───────────────────────────────────────────
  const [apiKey, setApiKey] = useState("");
  const [showApiKeyField, setShowApiKeyField] = useState(!settings.hasApiKey);

  // ─── Settings State ──────────────────────────────────────────
  const [sdkEnabled, setSdkEnabled] = useState(settings.sdkEnabled);
  const [webhookEnabled, setWebhookEnabled] = useState(settings.webhookEnabled);

  // ─── Stats State ───────────────────────────────────────────
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsPeriod, setStatsPeriod] = useState(30);
  const statsFetcher = useFetcher();
  const statsData = statsFetcher.data?.statsResult;
  const statsLoading = statsFetcher.state === "submitting";

  const handleFetchStats = useCallback((days) => {
    setStatsPeriod(days);
    const formData = new FormData();
    formData.set("intent", "fetch-stats");
    formData.set("periodDays", String(days));
    statsFetcher.submit(formData, { method: "post" });
  }, [statsFetcher]);

  const handleToggleStats = useCallback(() => {
    const willOpen = !statsOpen;
    setStatsOpen(willOpen);
    if (willOpen && !statsData) {
      handleFetchStats(statsPeriod);
    }
  }, [statsOpen, statsData, statsPeriod, handleFetchStats]);

  // ─── Handlers ────────────────────────────────────────────────

  const handleSaveApiKey = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "save-api-key");
    formData.set("apiKey", apiKey);
    submit(formData, { method: "post" });
  }, [apiKey, submit]);

  const handleSaveSettings = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "save-settings");
    formData.set(
      "settings",
      JSON.stringify({ sdkEnabled, webhookEnabled })
    );
    submit(formData, { method: "post" });
  }, [sdkEnabled, webhookEnabled, submit]);

  // ─── Status Badge Helper ─────────────────────────────────────

  const StatusBadge = ({ status: s }) => {
    const map = {
      active: { tone: "success", label: "Active" },
      connected: { tone: "success", label: "Connected" },
      healthy: { tone: "success", label: "Healthy" },
      disabled: { tone: "warning", label: "Disabled" },
      inactive: { tone: "critical", label: "Inactive" },
      error: { tone: "critical", label: "Error" },
      not_configured: { tone: "attention", label: "Not Configured" },
    };
    const cfg = map[s] || { tone: "info", label: s };
    return <Badge tone={cfg.tone}>{cfg.label}</Badge>;
  };

  // ─── Render ──────────────────────────────────────────────────

  return (
    <Page
      title="Onsite Commission Engine"
      subtitle="Track creator video engagement and attribute conversions"
      primaryAction={{
        content: "View OCE Dashboard",
        url: "https://app.onsiteaffiliate.com",
        external: true,
      }}
    >
      <BlockStack gap="600">
        {/* ── Success/Error Banners ─────────────────────────────── */}
        {actionData?.success && (
          <Banner tone="success" onDismiss={() => {}}>
            {actionData.message || "Settings saved successfully."}
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {actionData.error}
          </Banner>
        )}

        {/* ── Integration Status ────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2">Integration Status</Text>
              <StatusBadge status={status.overall} />
            </InlineStack>
            <Divider />
            <InlineGrid columns={3} gap="400">
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="center">
                    <Icon source={CodeIcon} />
                    <Text variant="headingSm">SDK Script</Text>
                  </InlineStack>
                  <StatusBadge status={status.sdk.status} />
                  <Text variant="bodySm" tone="subdued">{status.sdk.message}</Text>
                </BlockStack>
              </Box>
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="center">
                    <Icon source={OrderIcon} />
                    <Text variant="headingSm">Order Webhook</Text>
                  </InlineStack>
                  <StatusBadge status={status.webhook.status} />
                  <Text variant="bodySm" tone="subdued">{status.webhook.message}</Text>
                </BlockStack>
              </Box>
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="center">
                    <Icon source={ChartVerticalIcon} />
                    <Text variant="headingSm">API Connection</Text>
                  </InlineStack>
                  <StatusBadge status={status.apiConnection.status} />
                  <Text variant="bodySm" tone="subdued">{status.apiConnection.message}</Text>
                </BlockStack>
              </Box>
            </InlineGrid>
          </BlockStack>
        </Card>

        {/* ── API Key Setup ─────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text variant="headingMd" as="h2">API Key</Text>
                <Text variant="bodySm" tone="subdued">
                  Get your API key from{" "}
                  <Link url="https://app.onsiteaffiliate.com/settings/api-keys" external>
                    app.onsiteaffiliate.com
                  </Link>
                </Text>
              </BlockStack>
              {settings.hasApiKey && (
                <Button onClick={() => setShowApiKeyField(!showApiKeyField)} variant="plain">
                  {showApiKeyField ? "Cancel" : "Change Key"}
                </Button>
              )}
            </InlineStack>

            {settings.hasApiKey && !showApiKeyField && (
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <InlineStack gap="200" blockAlign="center">
                  <Icon source={CheckCircleIcon} tone="success" />
                  <Text variant="bodyMd">API key configured: {settings.apiKey}</Text>
                </InlineStack>
              </Box>
            )}

            {showApiKeyField && (
              <BlockStack gap="300">
                <TextField
                  label="OCE API Key"
                  value={apiKey}
                  onChange={setApiKey}
                  type="password"
                  placeholder="oce_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  autoComplete="off"
                  helpText="Paste your API key from the OCE dashboard."
                />
                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    onClick={handleSaveApiKey}
                    loading={isLoading}
                    disabled={!apiKey.trim()}
                  >
                    Save Key
                  </Button>
                </InlineStack>
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        {/* ── Quick Start Checklist ─────────────────────────────── */}
        {!settings.hasApiKey && (
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Quick Start</Text>
              <Divider />
              <ChecklistItem
                number={1}
                title="Create an OCE Account"
                description="Sign up at app.onsiteaffiliate.com"
                done={false}
                link="https://app.onsiteaffiliate.com/signup"
              />
              <ChecklistItem
                number={2}
                title="Generate an API Key"
                description="Go to Settings → API Keys in the OCE dashboard"
                done={false}
                link="https://app.onsiteaffiliate.com/settings/api-keys"
              />
              <ChecklistItem
                number={3}
                title="Paste Your Key Above"
                description="Enter your API key in the field above to connect"
                done={false}
              />
              <ChecklistItem
                number={4}
                title="Register Video Assets"
                description="Map your creator videos to products in the OCE dashboard"
                done={false}
                link="https://app.onsiteaffiliate.com/assets"
              />
            </BlockStack>
          </Card>
        )}

        {/* ── SDK & Webhook Toggles ─────────────────────────────── */}
        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text variant="headingMd" as="h2">OCE SDK Script</Text>
                    <Text variant="bodySm" tone="subdued">
                      Auto-injects the tracking script into your storefront
                    </Text>
                  </BlockStack>
                  <Button
                    variant={sdkEnabled ? "primary" : "secondary"}
                    onClick={() => setSdkEnabled(!sdkEnabled)}
                  >
                    {sdkEnabled ? "Enabled" : "Disabled"}
                  </Button>
                </InlineStack>
                {sdkEnabled && (
                  <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                    <Text variant="bodySm" as="p" fontFamily="mono">
                      {'<script'}
                      <br />
                      {'  src="https://app.onsiteaffiliate.com/sdk/oce.min.js"'}
                      <br />
                      {`  data-api-key="${settings.hasApiKey ? settings.apiKey : 'YOUR_API_KEY'}"`}
                      <br />
                      {"  defer>"}
                      <br />
                      {"</script>"}
                    </Text>
                  </Box>
                )}
                <Text variant="bodySm" tone="subdued">
                  The SDK auto-detects Videowise, Tolstoy, Firework, YouTube, Vimeo, and HTML5
                  video players. It handles session persistence, event deduplication, and cross-domain
                  attribution automatically.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text variant="headingMd" as="h2">Order Webhook</Text>
                    <Text variant="bodySm" tone="subdued">
                      Sends order data to OCE for attribution
                    </Text>
                  </BlockStack>
                  <Button
                    variant={webhookEnabled ? "primary" : "secondary"}
                    onClick={() => setWebhookEnabled(!webhookEnabled)}
                  >
                    {webhookEnabled ? "Enabled" : "Disabled"}
                  </Button>
                </InlineStack>
                <Text variant="bodySm" tone="subdued">
                  When a Shopify order is placed, the order details and any tracked exposure IDs
                  are automatically sent to the OCE REST API for commission attribution.
                </Text>
                {status.recentOrders?.length > 0 && (
                  <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                    <BlockStack gap="200">
                      <Text variant="headingSm">Recent Orders</Text>
                      {status.recentOrders.map((order) => (
                        <InlineStack key={order.id} align="space-between">
                          <Text variant="bodySm">#{order.shopifyOrderId}</Text>
                          <Badge
                            tone={
                              order.status === "sent"
                                ? "success"
                                : order.status === "failed"
                                ? "critical"
                                : "info"
                            }
                          >
                            {order.status}
                          </Badge>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  </Box>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <InlineStack align="end">
          <Button variant="primary" onClick={handleSaveSettings} loading={isLoading}>
            Save Settings
          </Button>
        </InlineStack>

        {/* ── Statistics ──────────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2">Statistics</Text>
              <Button onClick={handleToggleStats} variant="plain">
                {statsOpen ? "Collapse" : "Expand"}
              </Button>
            </InlineStack>
            <Collapsible open={statsOpen} id="stats-collapsible">
              <BlockStack gap="400">
                <Divider />
                <InlineStack gap="200">
                  <ButtonGroup>
                    <Button
                      variant={statsPeriod === 7 ? "primary" : "secondary"}
                      onClick={() => handleFetchStats(7)}
                      size="slim"
                    >
                      7 days
                    </Button>
                    <Button
                      variant={statsPeriod === 30 ? "primary" : "secondary"}
                      onClick={() => handleFetchStats(30)}
                      size="slim"
                    >
                      30 days
                    </Button>
                    <Button
                      variant={statsPeriod === 90 ? "primary" : "secondary"}
                      onClick={() => handleFetchStats(90)}
                      size="slim"
                    >
                      90 days
                    </Button>
                  </ButtonGroup>
                </InlineStack>
                {statsLoading && (
                  <Box padding="400">
                    <InlineStack align="center">
                      <Spinner size="small" />
                      <Text variant="bodySm" tone="subdued">Loading statistics...</Text>
                    </InlineStack>
                  </Box>
                )}
                {statsData?.ok && statsData.data && !statsLoading && (
                  <InlineGrid columns={3} gap="400">
                    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                      <BlockStack gap="200">
                        <Text variant="headingSm">Total Exposures</Text>
                        <Text variant="headingLg">{statsData.data.total_exposures.toLocaleString()}</Text>
                      </BlockStack>
                    </Box>
                    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                      <BlockStack gap="200">
                        <Text variant="headingSm">Total Orders</Text>
                        <Text variant="headingLg">{statsData.data.total_orders.toLocaleString()}</Text>
                      </BlockStack>
                    </Box>
                    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                      <BlockStack gap="200">
                        <Text variant="headingSm">Total Revenue</Text>
                        <Text variant="headingLg">${statsData.data.total_revenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
                      </BlockStack>
                    </Box>
                    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                      <BlockStack gap="200">
                        <Text variant="headingSm">Total Commission</Text>
                        <Text variant="headingLg">${statsData.data.total_commission.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
                      </BlockStack>
                    </Box>
                    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                      <BlockStack gap="200">
                        <Text variant="headingSm">Active Creators</Text>
                        <Text variant="headingLg">{statsData.data.active_creators.toLocaleString()}</Text>
                      </BlockStack>
                    </Box>
                    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                      <BlockStack gap="200">
                        <Text variant="headingSm">Active Assets</Text>
                        <Text variant="headingLg">{statsData.data.active_assets.toLocaleString()}</Text>
                      </BlockStack>
                    </Box>
                  </InlineGrid>
                )}
                {statsData && !statsData.ok && !statsLoading && (
                  <Banner tone="critical">
                    {statsData.error || "Failed to load statistics"}
                  </Banner>
                )}
              </BlockStack>
            </Collapsible>
          </BlockStack>
        </Card>

        {/* ── How It Works ──────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">How It Works</Text>
            <Divider />
            <InlineGrid columns={4} gap="400">
              <FlowStep
                number="1"
                icon={PlayIcon}
                title="Video Plays"
                description="User watches creator content on your store"
              />
              <FlowStep
                number="2"
                icon={ChartVerticalIcon}
                title="Events Tracked"
                description="Impressions, clicks, and watch progress captured"
              />
              <FlowStep
                number="3"
                icon={OrderIcon}
                title="Order Received"
                description="Conversion sent to OCE via webhook"
              />
              <FlowStep
                number="4"
                icon={SettingsIcon}
                title="Attribution"
                description="Commission calculated for creators"
              />
            </InlineGrid>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

// ─── Sub-components ───────────────────────────────────────────────

function ChecklistItem({ number, title, description, done, link }) {
  return (
    <InlineStack gap="400" blockAlign="center" wrap={false}>
      <Box
        width="32px"
        minHeight="32px"
        background={done ? "bg-fill-success" : "bg-surface-secondary"}
        borderRadius="full"
        padding="100"
      >
        <div style={{ textAlign: "center", lineHeight: "24px" }}>
          <Text variant="headingSm" tone={done ? "success" : "subdued"}>
            {done ? "✓" : number}
          </Text>
        </div>
      </Box>
      <BlockStack gap="050">
        <Text variant="headingSm">{title}</Text>
        <Text variant="bodySm" tone="subdued">{description}</Text>
      </BlockStack>
      {link && (
        <div style={{ marginLeft: "auto" }}>
          <Link url={link} external>
            Go →
          </Link>
        </div>
      )}
    </InlineStack>
  );
}

function FlowStep({ number, icon, title, description }) {
  return (
    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
      <BlockStack gap="200" inlineAlign="center">
        <Icon source={icon} tone="primary" />
        <Text variant="headingSm" alignment="center">{title}</Text>
        <Text variant="bodySm" tone="subdued" alignment="center">{description}</Text>
      </BlockStack>
    </Box>
  );
}
