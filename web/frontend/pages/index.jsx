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
  ChoiceList,
  RangeSlider,
  Select,
  Checkbox,
  Icon,
  Spinner,
  Collapsible,
  Link,
  SkeletonBodyText,
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
import { useLoaderData, useSubmit, useActionData, useNavigation } from "@remix-run/react";
import { json } from "@remix-run/node";
import { getSettings, updateSettings, updateApiKey, getIntegrationStatus, syncAppMetafields } from "../backend/routes/settings.js";
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

  switch (intent) {
    case "save-api-key": {
      const apiKey = formData.get("apiKey");
      const result = await updateApiKey(shop, apiKey);
      await syncAppMetafields(shop, session.accessToken);
      return json(result);
    }
    case "save-settings": {
      const updates = JSON.parse(formData.get("settings"));
      const result = await updateSettings(shop, updates);
      await syncAppMetafields(shop, session.accessToken);
      return json({ success: true, settings: result });
    }
    default:
      return json({ error: "Unknown action" }, { status: 400 });
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
  const [attributionModel, setAttributionModel] = useState(settings.attributionModel);
  const [attributionWindow, setAttributionWindow] = useState(settings.attributionWindow);
  const [commissionRate, setCommissionRate] = useState(settings.commissionRate);
  const [trackImpressions, setTrackImpressions] = useState(settings.trackImpressions);
  const [trackClicks, setTrackClicks] = useState(settings.trackClicks);
  const [trackWatchProgress, setTrackWatchProgress] = useState(settings.trackWatchProgress);
  const [minWatchPercent, setMinWatchPercent] = useState(settings.minWatchPercent);

  const [settingsOpen, setSettingsOpen] = useState(false);

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
      JSON.stringify({
        sdkEnabled,
        webhookEnabled,
        attributionModel,
        attributionWindow,
        commissionRate,
        trackImpressions,
        trackClicks,
        trackWatchProgress,
        minWatchPercent,
      })
    );
    submit(formData, { method: "post" });
  }, [
    sdkEnabled, webhookEnabled, attributionModel, attributionWindow,
    commissionRate, trackImpressions, trackClicks, trackWatchProgress,
    minWatchPercent, submit,
  ]);

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
                  helpText="Paste your API key from the OCE dashboard. It will be validated before saving."
                />
                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    onClick={handleSaveApiKey}
                    loading={isLoading}
                    disabled={!apiKey.trim()}
                  >
                    Validate & Save Key
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
                title="Configure Attribution Settings"
                description="Set your commission rates, attribution window, and qualifying events"
                done={false}
              />
              <ChecklistItem
                number={5}
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

        {/* ── Attribution Settings ──────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2">Attribution Settings</Text>
              <Button
                variant="plain"
                onClick={() => setSettingsOpen(!settingsOpen)}
                ariaExpanded={settingsOpen}
              >
                {settingsOpen ? "Collapse" : "Expand"}
              </Button>
            </InlineStack>

            <Collapsible open={settingsOpen}>
              <BlockStack gap="500">
                <Divider />

                {/* Attribution Model */}
                <Select
                  label="Attribution Model"
                  options={[
                    { label: "Last Touch — credit goes to the last video watched", value: "last-touch" },
                    { label: "First Touch — credit goes to the first video watched", value: "first-touch" },
                  ]}
                  value={attributionModel}
                  onChange={setAttributionModel}
                  helpText="Determines which creator gets commission when multiple videos were watched before purchase."
                />

                {/* Attribution Window */}
                <RangeSlider
                  label={`Attribution Window: ${attributionWindow} days`}
                  value={attributionWindow}
                  onChange={setAttributionWindow}
                  min={1}
                  max={90}
                  step={1}
                  helpText="How long after a video view can a purchase be attributed to a creator."
                  output
                />

                {/* Commission Rate */}
                <TextField
                  label="Default Commission Rate (%)"
                  type="number"
                  value={String(commissionRate)}
                  onChange={(val) => setCommissionRate(parseFloat(val) || 0)}
                  suffix="%"
                  min={0}
                  max={100}
                  step={0.5}
                  helpText="Default percentage of attributed revenue paid to creators. Override per-SKU or per-creator in OCE dashboard."
                />

                <Divider />

                {/* Qualifying Events */}
                <Text variant="headingSm" as="h3">Qualifying Events</Text>
                <Text variant="bodySm" tone="subdued">
                  Events that must occur during a video view for it to be eligible for attribution.
                </Text>

                <Checkbox
                  label="Track Impressions"
                  helpText="Track when a creator video first appears in the viewport"
                  checked={trackImpressions}
                  onChange={setTrackImpressions}
                />
                <Checkbox
                  label="Track Clicks"
                  helpText="Track when a user clicks on or interacts with a creator video"
                  checked={trackClicks}
                  onChange={setTrackClicks}
                />
                <Checkbox
                  label="Track Watch Progress"
                  helpText="Track how much of the video a user watches"
                  checked={trackWatchProgress}
                  onChange={setTrackWatchProgress}
                />

                {trackWatchProgress && (
                  <RangeSlider
                    label={`Minimum Watch Percentage: ${minWatchPercent}%`}
                    value={minWatchPercent}
                    onChange={setMinWatchPercent}
                    min={5}
                    max={100}
                    step={5}
                    helpText="Minimum percentage of video that must be watched to qualify for attribution."
                    output
                  />
                )}

                <Divider />

                <InlineStack align="end">
                  <Button variant="primary" onClick={handleSaveSettings} loading={isLoading}>
                    Save Attribution Settings
                  </Button>
                </InlineStack>
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
