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
  Checkbox,
  Select,
  Thumbnail,
  Modal,
  Tabs,
  IndexTable,
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
import { getSettings, updateSettings, updateApiKey, getIntegrationStatus, syncAppMetafields, getStatsOverview, getCreators, getRecentOrders, getPayouts, getAttributionSettings, updateAttributionSettings, registerAssets, getRegisteredAssets, getDiscoveredVideos, getPortalContent, savePortalContent, DEFAULT_PORTAL_CONTENT } from "../backend/routes/settings.js";
import { renderPortalPage } from "../backend/routes/creator-portal.js";
import { scanThemeForVideos } from "../backend/services/theme-scanner.js";
import shopify from "../server.js";

// ─── Remix Loader / Action ────────────────────────────────────────

export async function loader({ request }) {
  const { session } = await shopify.authenticate.admin(request);
  const shop = session.shop;

  const [settings, status, portalContent, statsResult, creatorsResult, ordersResult, payoutsResult, attributionResult] = await Promise.all([
    getSettings(shop),
    getIntegrationStatus(shop),
    getPortalContent(shop),
    getStatsOverview(shop, 30),
    getCreators(shop),
    getRecentOrders(shop, 10),
    getPayouts(shop),
    getAttributionSettings(shop),
  ]);

  const stats = statsResult?.data || statsResult || {};

  return json({
    settings,
    status,
    shop,
    portalContent,
    dashboard: {
      stats: {
        total_exposures: Number(stats.totalExposures ?? stats.total_exposures) || 0,
        total_orders: Number(stats.totalOrders ?? stats.total_orders) || 0,
        total_revenue: Number(stats.totalRevenue ?? stats.total_revenue) || 0,
        total_commission: Number(stats.totalCommission ?? stats.total_commission) || 0,
      },
      creators: creatorsResult?.creators || [],
      orders: ordersResult?.orders || [],
      payouts: payoutsResult?.payouts || [],
      payoutTotalAmount: payoutsResult?.totalAmount || 0,
      attributionSettings: attributionResult?.settings || {},
    },
  });
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
      case "save-attribution-settings": {
        const updates = JSON.parse(formData.get("settings"));
        const result = await updateAttributionSettings(shop, updates);
        return json({ attributionSaved: true, attributionResult: result });
      }
      case "fetch-stats": {
        const periodDays = parseInt(formData.get("periodDays")) || 30;
        const result = await getStatsOverview(shop, periodDays);
        console.log("[OCE] Remix stats raw response:", JSON.stringify(result));
        // OCE Management API returns camelCase field names
        const stats = result?.data || result || {};
        return json({
          statsResult: {
            ok: result?.ok !== false,
            data: {
              total_exposures: Number(stats.totalExposures ?? stats.total_exposures) || 0,
              total_orders: Number(stats.totalOrders ?? stats.total_orders) || 0,
              total_revenue: Number(stats.totalRevenue ?? stats.total_revenue) || 0,
              total_commission: Number(stats.totalCommission ?? stats.total_commission) || 0,
              chart_data: stats.chartData || stats.chart_data || [],
            },
          },
        });
      }
      case "fetch-videos": {
        // Discover videos from OCE SDK events + Shopify product video media
        const detectPlatform = (id) => {
          if (!id) return "Video";
          const lower = id.toLowerCase();
          if (lower.startsWith("videowise")) return "Videowise";
          if (lower.startsWith("tolstoy")) return "Tolstoy";
          if (lower.startsWith("firework")) return "Firework";
          if (lower.includes("youtube") || lower.includes("youtu.be")) return "YouTube";
          if (lower.includes("vimeo")) return "Vimeo";
          if (lower.startsWith("shopify")) return "Shopify";
          return "Video";
        };

        // Source 1: OCE SDK tracked videos
        let oceVideos = [];
        try {
          const discovered = await getDiscoveredVideos(shop);
          if (discovered.ok) {
            oceVideos = discovered.videos.map(v => ({
              ...v, platform: detectPlatform(v.assetId), discoveredBy: "sdk",
            }));
          }
        } catch (err) {
          console.warn("[OCE] Failed to fetch OCE videos:", err.message);
        }

        // Source 2: Shopify products with video media
        let shopifyVideos = [];
        try {
          const gqlUrl = `https://${shop}/admin/api/2024-10/graphql.json`;
          const gqlRes = await fetch(gqlUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": session.accessToken,
            },
            body: JSON.stringify({
              query: `{
                products(first: 100, query: "status:active") {
                  edges { node {
                    id title handle featuredImage { url }
                    media(first: 10) { edges { node {
                      mediaContentType
                      ... on Video { id sources { url mimeType } }
                      ... on ExternalVideo { id originUrl embeddedUrl }
                    } } }
                    variants(first: 100) { edges { node { sku } } }
                  } }
                }
              }`,
            }),
          });
          const gqlData = await gqlRes.json();
          if (gqlData.errors) {
            console.warn("[OCE] Shopify GraphQL errors:", JSON.stringify(gqlData.errors));
          }
          for (const edge of (gqlData.data?.products?.edges || [])) {
            const node = edge.node;
            const videoMedia = (node.media?.edges || [])
              .filter(m => m.node.mediaContentType === "VIDEO" || m.node.mediaContentType === "EXTERNAL_VIDEO");
            if (videoMedia.length === 0) continue;
            const skus = (node.variants?.edges || []).map(v => v.node.sku).filter(Boolean);
            for (const vm of videoMedia) {
              const mn = vm.node;
              const videoUrl = mn.sources?.[0]?.url || mn.originUrl || mn.embeddedUrl;
              const mediaId = mn.id.replace(/gid:\/\/shopify\/(Video|ExternalVideo)\//, "");
              shopifyVideos.push({
                assetId: `shopify-video-${mediaId}`,
                title: node.title + (videoMedia.length > 1 ? ` (${mn.mediaContentType === "EXTERNAL_VIDEO" ? "External" : "Hosted"})` : ""),
                source: videoUrl, thumbnail: node.featuredImage?.url || null,
                platform: mn.mediaContentType === "EXTERNAL_VIDEO" ? detectPlatform(videoUrl) : "Shopify",
                skus, exposureCount: 0, lastSeen: null, discoveredBy: "shopify",
              });
            }
          }
        } catch (err) {
          console.warn("[OCE] Failed to fetch Shopify video media:", err.message);
        }

        // Source 3: Scan theme for videos (Liquid files + JSON template configs)
        let themeVideos = [];
        try {
          themeVideos = await scanThemeForVideos(shop, session.accessToken);
        } catch (err) {
          console.warn("[OCE] Failed to scan theme files:", err.message);
        }

        // Merge + registered status
        const registered = await getRegisteredAssets(shop);
        const registeredMap = {};
        for (const ra of registered) registeredMap[ra.assetId] = ra;
        const seenIds = new Set(oceVideos.map(v => v.assetId));
        const allVideos = [...oceVideos];
        for (const sv of shopifyVideos) {
          if (!seenIds.has(sv.assetId)) { allVideos.push(sv); seenIds.add(sv.assetId); }
        }
        for (const tv of themeVideos) {
          if (!seenIds.has(tv.assetId)) { allVideos.push(tv); seenIds.add(tv.assetId); }
        }
        for (const ra of registered) {
          if (!seenIds.has(ra.assetId)) {
            allVideos.push({
              assetId: ra.assetId, title: ra.title || ra.assetId, source: ra.videoUrl,
              thumbnail: null, platform: detectPlatform(ra.assetId),
              skus: JSON.parse(ra.skus || "[]"), exposureCount: 0, lastSeen: null, discoveredBy: "registered",
            });
            seenIds.add(ra.assetId);
          }
        }
        for (const v of allVideos) {
          const reg = registeredMap[v.assetId];
          v.registered = !!reg;
          v.registeredCreatorId = reg?.creatorId || null;
          v.registeredCreatorName = reg?.creatorName || null;
        }
        return json({ videosResult: { ok: true, videos: allVideos } });
      }
      case "fetch-creators": {
        const creatorsResult = await getCreators(shop);
        console.log("[OCE] Remix creators response:", JSON.stringify(creatorsResult).substring(0, 200));
        return json({ creatorsResult });
      }
      case "register-assets": {
        const assets = JSON.parse(formData.get("assets"));
        console.log("[OCE] Remix register-assets:", assets.length, "assets");
        const regResult = await registerAssets(shop, assets);
        return json({ registerResult: regResult });
      }
      case "save-portal-content": {
        const content = JSON.parse(formData.get("content"));
        const result = await savePortalContent(shop, content);
        return json({ portalSaved: true, portalContent: result.content });
      }
      case "preview-portal": {
        const content = JSON.parse(formData.get("content"));
        const html = renderPortalPage("/apps/onsite-affiliate", content);
        return json({ portalPreviewHtml: html });
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
  const { settings, status, shop, portalContent: loadedPortalContent, dashboard } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state === "submitting";
  const [selectedTab, setSelectedTab] = useState(0);

  // ─── API Key State ───────────────────────────────────────────
  const [apiKey, setApiKey] = useState("");
  const [showApiKeyField, setShowApiKeyField] = useState(!settings.hasApiKey);

  // ─── Settings State ──────────────────────────────────────────
  const [sdkEnabled, setSdkEnabled] = useState(settings.sdkEnabled);
  const [webhookEnabled, setWebhookEnabled] = useState(settings.webhookEnabled);
  const [interceptAttribution, setInterceptAttribution] = useState(settings.interceptAttribution !== false);

  // ─── Stats State ───────────────────────────────────────────
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsPeriod, setStatsPeriod] = useState(30);
  const statsFetcher = useFetcher();
  const statsData = statsFetcher.data?.statsResult;
  const statsLoading = statsFetcher.state === "submitting";

  // ─── Video Assets State ────────────────────────────────────
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [videos, setVideos] = useState([]);
  const [creators, setCreators] = useState([]);
  const [selectedCreator, setSelectedCreator] = useState("");
  const [selectedAssetIds, setSelectedAssetIds] = useState([]);
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  const [assetsBanner, setAssetsBanner] = useState(null);
  const videosFetcher = useFetcher();
  const creatorsFetcher = useFetcher();
  const registerFetcher = useFetcher();
  const assetsLoading = videosFetcher.state === "submitting" || creatorsFetcher.state === "submitting";
  const registering = registerFetcher.state === "submitting";

  // ─── Manual Entry State ─────────────────────────────────────
  const [manualOpen, setManualOpen] = useState(false);
  const [manualAssetId, setManualAssetId] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [manualSkus, setManualSkus] = useState("");
  const [manualCreator, setManualCreator] = useState("");
  const [manualError, setManualError] = useState("");

  // ─── Creator Portal Content State ─────────────────────────
  const [portalOpen, setPortalOpen] = useState(false);
  const [portalFields, setPortalFields] = useState(loadedPortalContent || {});
  const [portalPreviewHtml, setPortalPreviewHtml] = useState(null);
  const [showPortalPreview, setShowPortalPreview] = useState(false);
  const portalFetcher = useFetcher();
  const portalSaving = portalFetcher.state === "submitting";
  const [attributionSettings, setAttributionSettings] = useState({
    attribution_model: dashboard.attributionSettings?.attribution_model || "last_touch",
    view_window_days: dashboard.attributionSettings?.view_window_days ?? 7,
    click_window_days: dashboard.attributionSettings?.click_window_days ?? 30,
    default_commission_rate: dashboard.attributionSettings?.default_commission_rate ?? 0.05,
    qualifying_events: dashboard.attributionSettings?.qualifying_events || ["click", "watch_start"],
  });

  const handlePortalFieldChange = useCallback((field, value) => {
    setPortalFields(prev => ({ ...prev, [field]: value }));
  }, []);

  const handleSavePortalContent = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "save-portal-content");
    fd.set("content", JSON.stringify(portalFields));
    portalFetcher.submit(fd, { method: "post" });
  }, [portalFields, portalFetcher]);

  const handlePreviewPortal = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "preview-portal");
    fd.set("content", JSON.stringify(portalFields));
    portalFetcher.submit(fd, { method: "post" });
    setShowPortalPreview(true);
  }, [portalFields, portalFetcher]);

  useEffect(() => {
    if (portalFetcher.data?.portalPreviewHtml) {
      setPortalPreviewHtml(portalFetcher.data.portalPreviewHtml);
    }
    if (portalFetcher.data?.portalSaved) {
      setPortalFields(portalFetcher.data.portalContent);
    }
  }, [portalFetcher.data]);

  // Process fetcher responses
  useEffect(() => {
    if (videosFetcher.data?.videosResult?.ok) {
      setVideos(videosFetcher.data.videosResult.videos);
      setAssetsLoaded(true);
    }
  }, [videosFetcher.data]);

  useEffect(() => {
    if (creatorsFetcher.data?.creatorsResult?.ok !== undefined) {
      setCreators(creatorsFetcher.data.creatorsResult.creators || []);
    }
  }, [creatorsFetcher.data]);

  useEffect(() => {
    if (registerFetcher.data?.registerResult) {
      const res = registerFetcher.data.registerResult;
      if (res.ok !== false) {
        setAssetsBanner({ tone: "success", message: `${res.succeeded || 0} video(s) registered successfully${res.failed ? ` (${res.failed} failed)` : ""}!` });
        setSelectedAssetIds([]);
        const fd = new FormData();
        fd.set("intent", "fetch-videos");
        videosFetcher.submit(fd, { method: "post" });
      } else {
        setAssetsBanner({ tone: "critical", message: res.error || "Registration failed" });
      }
    }
  }, [registerFetcher.data]);

  const handleLoadAssets = useCallback(() => {
    setAssetsBanner(null);
    const fd1 = new FormData();
    fd1.set("intent", "fetch-videos");
    videosFetcher.submit(fd1, { method: "post" });
    const fd2 = new FormData();
    fd2.set("intent", "fetch-creators");
    creatorsFetcher.submit(fd2, { method: "post" });
  }, [videosFetcher, creatorsFetcher]);

  const handleToggleAssets = useCallback(() => {
    const willOpen = !assetsOpen;
    setAssetsOpen(willOpen);
    if (willOpen && !assetsLoaded) {
      handleLoadAssets();
    }
  }, [assetsOpen, assetsLoaded, handleLoadAssets]);

  const handleSelectAsset = useCallback((id, checked) => {
    setSelectedAssetIds(prev =>
      checked ? [...prev, id] : prev.filter(x => x !== id)
    );
  }, []);

  const handleSelectAll = useCallback((checked) => {
    setSelectedAssetIds(checked ? videos.map(v => v.assetId) : []);
  }, [videos]);

  const handleRegisterAssets = useCallback((videoList) => {
    const creator = creators.find(c => (c.id || c.external_id || c.creator_id) === selectedCreator);
    const creatorId = selectedCreator || undefined;
    const creatorName = creator ? (creator.name || creator.display_name || creator.external_id || "") : undefined;

    const assets = videoList.map(v => ({
      asset_id: v.assetId,
      title: v.title || v.assetId,
      skus: v.skus || [],
      thumbnail_url: v.thumbnail || undefined,
      source: v.source || undefined,
      creator_id: creatorId,
      creator_name: creatorName,
      metadata: { platform: v.platform, discovered_by: v.discoveredBy },
    }));

    const fd = new FormData();
    fd.set("intent", "register-assets");
    fd.set("assets", JSON.stringify(assets));
    registerFetcher.submit(fd, { method: "post" });
  }, [selectedCreator, creators, registerFetcher]);

  const handleBulkRegister = useCallback(() => {
    const selected = videos.filter(v => selectedAssetIds.includes(v.assetId));
    if (selected.length) handleRegisterAssets(selected);
  }, [videos, selectedAssetIds, handleRegisterAssets]);

  const handleManualRegister = useCallback(() => {
    setManualError("");
    if (!manualAssetId.trim()) {
      setManualError("Asset ID is required");
      return;
    }
    const skus = manualSkus.trim() ? manualSkus.split(",").map(s => s.trim()).filter(Boolean) : [];
    const creatorId = manualCreator || selectedCreator || undefined;
    const creator = creators.find(c => (c.id || c.external_id || c.creator_id) === creatorId);
    const creatorName = creator ? (creator.name || creator.display_name || creator.external_id || "") : undefined;

    const assets = [{
      asset_id: manualAssetId.trim(),
      title: manualTitle.trim() || manualAssetId.trim(),
      skus,
      creator_id: creatorId,
      creator_name: creatorName,
      metadata: { platform: "Manual", discovered_by: "manual" },
    }];

    const fd = new FormData();
    fd.set("intent", "register-assets");
    fd.set("assets", JSON.stringify(assets));
    registerFetcher.submit(fd, { method: "post" });
    setManualAssetId("");
    setManualTitle("");
    setManualSkus("");
  }, [manualAssetId, manualTitle, manualSkus, manualCreator, selectedCreator, creators, registerFetcher]);

  const creatorOptions = [
    { label: "-- Select a creator --", value: "" },
    ...creators.map(c => ({
      label: c.name || c.display_name || c.external_id || c.id || "Unknown",
      value: String(c.id || c.external_id || c.creator_id || ""),
    })),
  ];

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
      JSON.stringify({ sdkEnabled, webhookEnabled, interceptAttribution })
    );
    submit(formData, { method: "post" });
  }, [sdkEnabled, webhookEnabled, interceptAttribution, submit]);

  const handleAttributionFieldChange = useCallback((field, value) => {
    setAttributionSettings((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleToggleQualifyingEvent = useCallback((eventName, checked) => {
    setAttributionSettings((prev) => {
      const next = checked
        ? [...new Set([...prev.qualifying_events, eventName])]
        : prev.qualifying_events.filter((value) => value !== eventName);
      return { ...prev, qualifying_events: next.length ? next : prev.qualifying_events };
    });
  }, []);

  const handleSaveAttributionSettings = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "save-attribution-settings");
    formData.set("settings", JSON.stringify({
      ...attributionSettings,
      view_window_days: Number(attributionSettings.view_window_days) || 7,
      click_window_days: Number(attributionSettings.click_window_days) || 30,
      default_commission_rate: Number(attributionSettings.default_commission_rate) || 0,
    }));
    submit(formData, { method: "post" });
  }, [attributionSettings, submit]);

  // ─── Status Badge Helper ─────────────────────────────────────

  const StatusBadge = ({ status: s }) => {
    const map = {
      active: { tone: "success", label: "Active" },
      connected: { tone: "success", label: "Connected" },
      healthy: { tone: "success", label: "Healthy" },
      disabled: { tone: "attention", label: "Disabled" },
      inactive: { tone: "critical", label: "Inactive" },
      error: { tone: "critical", label: "Error" },
      not_configured: { tone: "attention", label: "Not Configured" },
    };
    const cfg = map[s] || { tone: "info", label: s };
    return <Badge tone={cfg.tone}>{cfg.label}</Badge>;
  };

  const tabs = [
    { id: "overview", content: "Overview", panelID: "overview-panel" },
    { id: "orders", content: "Orders", panelID: "orders-panel" },
    { id: "creators", content: "Creators", panelID: "creators-panel" },
    { id: "payouts", content: "Payouts", panelID: "payouts-panel" },
    { id: "attribution", content: "Attribution", panelID: "attribution-panel" },
    { id: "setup", content: "Setup", panelID: "setup-panel" },
  ];

  const hasApiKey = settings.hasApiKey;
  const summaryStats = dashboard.stats || {};
  const recentOrders = dashboard.orders || [];
  const creatorRows = dashboard.creators || [];
  const payoutRows = dashboard.payouts || [];

  // ─── Render ──────────────────────────────────────────────────

  return (
    <Page
      title="Onsite Commission Engine"
      subtitle="Track creator video engagement and attribute conversions"
      primaryAction={{
        content: "View OCE Dashboard",
        url: "https://app.onsiteaffiliate.com/dashboard",
        external: true,
      }}
    >
      <BlockStack gap="600">
        <Card padding="0">
          <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab} fitted />
        </Card>

        {actionData?.attributionSaved && selectedTab === 4 && (
          <Banner tone="success" onDismiss={() => {}}>
            Attribution settings saved successfully.
          </Banner>
        )}

        {selectedTab === 0 && (
          <>
            {!hasApiKey && (
              <Banner tone="info">
                Add your OCE API key in the Setup tab to load live dashboard data.
              </Banner>
            )}

            <InlineGrid columns={4} gap="400">
              <MetricCard title="Total Exposures" value={formatInteger(summaryStats.total_exposures)} />
              <MetricCard title="Orders" value={formatInteger(summaryStats.total_orders)} />
              <MetricCard title="Revenue" value={formatCurrency(summaryStats.total_revenue)} />
              <MetricCard title="Commission" value={formatCurrency(summaryStats.total_commission)} />
            </InlineGrid>

            <Layout>
              <Layout.Section>
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text variant="headingMd" as="h2">Integration Health</Text>
                      <StatusBadge status={status.overall} />
                    </InlineStack>
                    <InlineGrid columns={3} gap="300">
                      <StatusCard title="SDK" status={status.sdk.status} message={status.sdk.message} />
                      <StatusCard title="Webhook" status={status.webhook.status} message={status.webhook.message} />
                      <StatusCard title="API" status={status.apiConnection.status} message={status.apiConnection.message} />
                    </InlineGrid>
                  </BlockStack>
                </Card>
              </Layout.Section>
            </Layout>

            <Layout>
              <Layout.Section variant="oneHalf">
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text variant="headingMd" as="h2">Recent Orders</Text>
                      <Badge>{recentOrders.length}</Badge>
                    </InlineStack>
                    {recentOrders.length === 0 ? (
                      <Text variant="bodySm" tone="subdued">No orders available yet.</Text>
                    ) : (
                      <BlockStack gap="200">
                        {recentOrders.slice(0, 5).map((order) => (
                          <InlineStack key={String(order.id || order.order_id)} align="space-between" blockAlign="center">
                            <BlockStack gap="050">
                              <Text variant="bodyMd" fontWeight="semibold">#{order.order_id}</Text>
                              <Text variant="bodySm" tone="subdued">{formatOrderDate(order.ts)}</Text>
                            </BlockStack>
                            <InlineStack gap="200" blockAlign="center">
                              <Badge tone={order.isAttributed ? "success" : "attention"}>
                                {order.isAttributed ? "Attributed" : "Pending"}
                              </Badge>
                              <Text variant="bodyMd">{formatCurrency(order.total_revenue)}</Text>
                            </InlineStack>
                          </InlineStack>
                        ))}
                      </BlockStack>
                    )}
                  </BlockStack>
                </Card>
              </Layout.Section>
              <Layout.Section variant="oneHalf">
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text variant="headingMd" as="h2">Creator Snapshot</Text>
                      <Badge>{creatorRows.length}</Badge>
                    </InlineStack>
                    {creatorRows.length === 0 ? (
                      <Text variant="bodySm" tone="subdued">No creators found for this brand yet.</Text>
                    ) : (
                      <BlockStack gap="200">
                        {creatorRows.slice(0, 5).map((creator) => (
                          <InlineStack key={String(creator.id || creator.external_id)} align="space-between" blockAlign="center">
                            <BlockStack gap="050">
                              <Text variant="bodyMd" fontWeight="semibold">{creator.name || creator.email || creator.external_id || "Unnamed creator"}</Text>
                              <Text variant="bodySm" tone="subdued">{creator.email || "No email on file"}</Text>
                            </BlockStack>
                            <InlineStack gap="200" blockAlign="center">
                              <Badge tone={creator.status === "active" ? "success" : "attention"}>{creator.status || "unknown"}</Badge>
                              <Text variant="bodySm" tone="subdued">{creator.asset_count || 0} assets</Text>
                            </InlineStack>
                          </InlineStack>
                        ))}
                      </BlockStack>
                    )}
                  </BlockStack>
                </Card>
              </Layout.Section>
            </Layout>
          </>
        )}

        {selectedTab === 1 && (
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">Orders</Text>
              <IndexTable
                resourceName={{ singular: "order", plural: "orders" }}
                itemCount={recentOrders.length}
                selectable={false}
                headings={[
                  { title: "Order" },
                  { title: "Date" },
                  { title: "Revenue" },
                  { title: "Exposure IDs" },
                  { title: "Status" },
                ]}
              >
                {recentOrders.map((order, index) => (
                  <IndexTable.Row id={String(order.id || order.order_id)} key={String(order.id || order.order_id)} position={index}>
                    <IndexTable.Cell>
                      <Text variant="bodyMd" fontWeight="semibold">#{order.order_id}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{formatOrderDate(order.ts)}</IndexTable.Cell>
                    <IndexTable.Cell>{formatCurrency(order.total_revenue)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text variant="bodySm" tone="subdued">
                        {Array.isArray(order.exposure_ids) && order.exposure_ids.length > 0
                          ? order.exposure_ids.join(", ")
                          : "No exposure IDs on order"}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={order.isAttributed ? "success" : "attention"}>
                        {order.isAttributed ? "Attributed" : "Pending / fallback"}
                      </Badge>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </BlockStack>
          </Card>
        )}

        {selectedTab === 2 && (
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">Creators</Text>
              <IndexTable
                resourceName={{ singular: "creator", plural: "creators" }}
                itemCount={creatorRows.length}
                selectable={false}
                headings={[
                  { title: "Creator" },
                  { title: "Email" },
                  { title: "Assets" },
                  { title: "Stripe" },
                  { title: "Status" },
                ]}
              >
                {creatorRows.map((creator, index) => (
                  <IndexTable.Row id={String(creator.id || creator.external_id)} key={String(creator.id || creator.external_id)} position={index}>
                    <IndexTable.Cell>
                      <Text variant="bodyMd" fontWeight="semibold">{creator.name || creator.external_id || "Unnamed creator"}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{creator.email || "—"}</IndexTable.Cell>
                    <IndexTable.Cell>{creator.asset_count || 0}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={creator.stripe_connected ? "success" : "attention"}>
                        {creator.stripe_connected ? "Connected" : "Not connected"}
                      </Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={creator.status === "active" ? "success" : "attention"}>{creator.status || "unknown"}</Badge>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </BlockStack>
          </Card>
        )}

        {selectedTab === 3 && (
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">Payouts</Text>
                <Badge tone="info">Total {formatCurrency(dashboard.payoutTotalAmount)}</Badge>
              </InlineStack>
              <IndexTable
                resourceName={{ singular: "payout", plural: "payouts" }}
                itemCount={payoutRows.length}
                selectable={false}
                headings={[
                  { title: "Creator" },
                  { title: "Period" },
                  { title: "Amount" },
                  { title: "Status" },
                  { title: "Paid at" },
                ]}
              >
                {payoutRows.map((payout, index) => (
                  <IndexTable.Row id={String(payout.id)} key={String(payout.id)} position={index}>
                    <IndexTable.Cell>
                      <Text variant="bodyMd" fontWeight="semibold">{payout.creator_name || payout.creator_id || "Unknown creator"}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{payout.period || "—"}</IndexTable.Cell>
                    <IndexTable.Cell>{formatCurrency(payout.amount)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={payout.status === "paid" ? "success" : "attention"}>{payout.status || "pending"}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{payout.paid_at ? formatOrderDate(payout.paid_at) : "—"}</IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </BlockStack>
          </Card>
        )}

        {selectedTab === 4 && (
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Attribution Settings</Text>
              <InlineGrid columns={2} gap="300">
                <Select
                  label="Attribution model"
                  options={[
                    { label: "Last touch", value: "last_touch" },
                    { label: "First touch", value: "first_touch" },
                    { label: "Linear", value: "linear" },
                    { label: "Time decay", value: "time_decay" },
                  ]}
                  value={attributionSettings.attribution_model}
                  onChange={(value) => handleAttributionFieldChange("attribution_model", value)}
                />
                <TextField
                  label="Default commission rate (%)"
                  type="number"
                  autoComplete="off"
                  value={String((Number(attributionSettings.default_commission_rate) || 0) * 100)}
                  onChange={(value) => handleAttributionFieldChange("default_commission_rate", (parseFloat(value) || 0) / 100)}
                />
                <TextField
                  label="View window (days)"
                  type="number"
                  autoComplete="off"
                  value={String(attributionSettings.view_window_days)}
                  onChange={(value) => handleAttributionFieldChange("view_window_days", parseInt(value, 10) || 1)}
                />
                <TextField
                  label="Click window (days)"
                  type="number"
                  autoComplete="off"
                  value={String(attributionSettings.click_window_days)}
                  onChange={(value) => handleAttributionFieldChange("click_window_days", parseInt(value, 10) || 1)}
                />
              </InlineGrid>
              <BlockStack gap="200">
                <Text variant="headingSm" as="h3">Qualifying events</Text>
                <InlineGrid columns={2} gap="200">
                  {["watch_start", "watch_complete", "click", "watch_25", "watch_50", "watch_75"].map((eventName) => (
                    <Checkbox
                      key={eventName}
                      label={eventName}
                      checked={attributionSettings.qualifying_events.includes(eventName)}
                      onChange={(checked) => handleToggleQualifyingEvent(eventName, checked)}
                    />
                  ))}
                </InlineGrid>
              </BlockStack>
              <InlineStack align="end">
                <Button variant="primary" onClick={handleSaveAttributionSettings} loading={isLoading}>
                  Save Attribution Settings
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {selectedTab === 5 && (
          <>
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
                link="https://app.onsiteaffiliate.com/auth"
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
                title="Configure Attribution"
                description="Set commission rates, window, and events"
                done={false}
                link="https://app.onsiteaffiliate.com/dashboard/settings"
              />
              <ChecklistItem
                number={5}
                title="Register Video Assets"
                description="Use the Asset Registration section below to register discovered videos"
                done={false}
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
                      {'  src="https://app.onsiteaffiliate.com/sdk/oce.min.js?v=1.2.5"'}
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
                <Divider />
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text variant="headingMd" as="h2">Intercept checkout / Buy now</Text>
                    <Text variant="bodySm" tone="subdued">
                      Sync cart attribution before redirect (400ms cap); turn OFF if a brand objects
                    </Text>
                  </BlockStack>
                  <Button
                    variant={interceptAttribution ? "primary" : "secondary"}
                    onClick={() => setInterceptAttribution(!interceptAttribution)}
                  >
                    {interceptAttribution ? "On" : "Off"}
                  </Button>
                </InlineStack>
                <Text variant="bodySm" tone="subdued">
                  Default: On. When on, checkout and buy-now clicks trigger a quick cart-attribute sync then redirect.
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

        {/* ── Video Asset Registration ────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text variant="headingMd" as="h2">Video Asset Registration</Text>
                <Text variant="bodySm" tone="subdued">
                  Register discovered videos as OCE assets and assign them to creators
                </Text>
              </BlockStack>
              <Button onClick={handleToggleAssets} variant="plain">
                {assetsOpen ? "Collapse" : "Expand"}
              </Button>
            </InlineStack>
            <Collapsible open={assetsOpen} id="assets-collapsible">
              <BlockStack gap="400">
                <Divider />
                {assetsBanner && (
                  <Banner tone={assetsBanner.tone} onDismiss={() => setAssetsBanner(null)}>
                    {assetsBanner.message}
                  </Banner>
                )}
                {assetsLoading && (
                  <Box padding="400">
                    <InlineStack align="center" gap="200">
                      <Spinner size="small" />
                      <Text variant="bodySm" tone="subdued">Loading videos and creators...</Text>
                    </InlineStack>
                  </Box>
                )}
                {assetsLoaded && !assetsLoading && (
                  <BlockStack gap="400">
                    <InlineStack gap="400" blockAlign="end" wrap>
                      <Box minWidth="220px">
                        <Select
                          label="Creator"
                          options={creatorOptions}
                          value={selectedCreator}
                          onChange={setSelectedCreator}
                        />
                      </Box>
                      <Button
                        variant="primary"
                        onClick={handleBulkRegister}
                        disabled={selectedAssetIds.length === 0 || registering}
                        loading={registering}
                      >
                        Register Selected ({selectedAssetIds.length})
                      </Button>
                      <Button onClick={handleLoadAssets} variant="secondary">
                        Refresh
                      </Button>
                    </InlineStack>

                    {videos.length === 0 ? (
                      <Box padding="400">
                        <Text variant="bodySm" tone="subdued" alignment="center">
                          No videos discovered. Ensure the OCE SDK is enabled and tracking video views on your storefront.
                        </Text>
                      </Box>
                    ) : (
                      <BlockStack gap="0">
                        <Box padding="200" background="bg-surface-secondary" borderRadius="200">
                          <InlineStack gap="300" blockAlign="center">
                            <Checkbox
                              label="Select all"
                              checked={selectedAssetIds.length === videos.length && videos.length > 0}
                              onChange={handleSelectAll}
                            />
                            <Text variant="bodySm" tone="subdued">
                              {videos.length} video{videos.length !== 1 ? "s" : ""} found
                            </Text>
                          </InlineStack>
                        </Box>
                        {videos.map((video) => (
                          <Box key={video.assetId} padding="300" borderBlockEndWidth="025" borderColor="border">
                            <InlineStack gap="400" blockAlign="center" wrap={false}>
                              <Checkbox
                                label=""
                                labelHidden
                                checked={selectedAssetIds.includes(video.assetId)}
                                onChange={(checked) => handleSelectAsset(video.assetId, checked)}
                              />
                              {video.thumbnail ? (
                                <Thumbnail source={video.thumbnail} alt={video.title || video.assetId} size="small" />
                              ) : (
                                <Box width="40px" minHeight="40px" background="bg-surface-secondary" borderRadius="200">
                                  <div style={{ textAlign: "center", lineHeight: "40px" }}>
                                    <Icon source={PlayIcon} tone="subdued" />
                                  </div>
                                </Box>
                              )}
                              <Box minWidth="0" maxWidth="100%">
                                <BlockStack gap="050">
                                  <Text variant="bodyMd" fontWeight="semibold" truncate>
                                    {video.title || video.assetId}
                                  </Text>
                                  <InlineStack gap="100" wrap>
                                    <Badge tone="info">{video.platform || "Video"}</Badge>
                                    {video.discoveredBy === "sdk" && <Badge>SDK tracked</Badge>}
                                    {video.discoveredBy === "shopify" && <Badge>Shopify media</Badge>}
                                    {video.discoveredBy === "theme" && <Badge>Theme</Badge>}
                                    {video.exposureCount > 0 && (
                                      <Text variant="bodySm" tone="subdued">
                                        {video.exposureCount} exposure{video.exposureCount !== 1 ? "s" : ""}
                                      </Text>
                                    )}
                                  </InlineStack>
                                  {video.skus && video.skus.length > 0 && (
                                    <InlineStack gap="100" wrap>
                                      {video.skus.map((sku) => (
                                        <Badge key={sku} tone="attention">{sku}</Badge>
                                      ))}
                                    </InlineStack>
                                  )}
                                </BlockStack>
                              </Box>
                              <div style={{ marginLeft: "auto", flexShrink: 0 }}>
                                <InlineStack gap="200" blockAlign="center">
                                  {video.registered ? (
                                    <Badge tone="success">
                                      Registered{video.registeredCreatorName ? ` (${video.registeredCreatorName})` : ""}
                                    </Badge>
                                  ) : (
                                    <Badge>Not registered</Badge>
                                  )}
                                  <Button
                                    size="slim"
                                    variant={video.registered ? "secondary" : "primary"}
                                    onClick={() => handleRegisterAssets([video])}
                                    loading={registering}
                                  >
                                    {video.registered ? "Update" : "Register"}
                                  </Button>
                                </InlineStack>
                              </div>
                            </InlineStack>
                          </Box>
                        ))}
                      </BlockStack>
                    )}

                    {/* ── Manual Entry ──────────────────────────── */}
                    <Divider />
                    <Button
                      onClick={() => setManualOpen(!manualOpen)}
                      variant="plain"
                      fullWidth
                      textAlign="start"
                    >
                      {manualOpen ? "- Hide Manual Entry" : "+ Add Video Manually"}
                    </Button>
                    <Collapsible open={manualOpen} id="manual-entry-collapsible">
                      <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                        <BlockStack gap="300">
                          <InlineGrid columns={2} gap="300">
                            <TextField
                              label="Asset ID"
                              value={manualAssetId}
                              onChange={setManualAssetId}
                              placeholder="e.g. my-video-001"
                              requiredIndicator
                              autoComplete="off"
                              error={manualError || undefined}
                            />
                            <TextField
                              label="Title"
                              value={manualTitle}
                              onChange={setManualTitle}
                              placeholder="e.g. Product Demo Video"
                              autoComplete="off"
                            />
                            <TextField
                              label="SKUs (comma-separated)"
                              value={manualSkus}
                              onChange={setManualSkus}
                              placeholder="e.g. SKU-001, SKU-002"
                              autoComplete="off"
                            />
                            <Select
                              label="Creator"
                              options={[
                                { label: "-- Use creator from above --", value: "" },
                                ...creatorOptions.slice(1),
                              ]}
                              value={manualCreator}
                              onChange={setManualCreator}
                            />
                          </InlineGrid>
                          <InlineStack gap="200">
                            <Button
                              variant="primary"
                              onClick={handleManualRegister}
                              loading={registering}
                              disabled={!manualAssetId.trim()}
                              size="slim"
                            >
                              Register
                            </Button>
                          </InlineStack>
                        </BlockStack>
                      </Box>
                    </Collapsible>
                  </BlockStack>
                )}
              </BlockStack>
            </Collapsible>
          </BlockStack>
        </Card>

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
                  <InlineGrid columns={4} gap="400">
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

        {/* ── Creator Portal ─────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text variant="headingMd" as="h2">Creator Portal</Text>
                <Text variant="bodySm" tone="subdued">
                  Edit the copy and content displayed on your creator signup portal
                </Text>
              </BlockStack>
              <Button onClick={() => setPortalOpen(!portalOpen)} variant="plain">
                {portalOpen ? "Collapse" : "Expand"}
              </Button>
            </InlineStack>
            <Collapsible open={portalOpen} id="portal-collapsible">
              <BlockStack gap="400">
                <Divider />
                {portalFetcher.data?.portalSaved && (
                  <Banner tone="success" onDismiss={() => {}}>
                    Portal content saved successfully.
                  </Banner>
                )}

                {/* Page Header */}
                <Text variant="headingSm" as="h3">Page Header</Text>
                <InlineGrid columns={2} gap="300">
                  <TextField
                    label="Page Title"
                    value={portalFields.pageTitle || ""}
                    onChange={(v) => handlePortalFieldChange("pageTitle", v)}
                    autoComplete="off"
                    helpText="Use {store} for the store name"
                  />
                  <TextField
                    label="Signup Card Title"
                    value={portalFields.signupCardTitle || ""}
                    onChange={(v) => handlePortalFieldChange("signupCardTitle", v)}
                    autoComplete="off"
                  />
                </InlineGrid>
                <TextField
                  label="Page Subtitle"
                  value={portalFields.pageSubtitle || ""}
                  onChange={(v) => handlePortalFieldChange("pageSubtitle", v)}
                  autoComplete="off"
                  multiline={2}
                />
                <TextField
                  label="Page Subtitle (line 2)"
                  value={portalFields.pageSubtitle2 || ""}
                  onChange={(v) => handlePortalFieldChange("pageSubtitle2", v)}
                  autoComplete="off"
                  multiline={2}
                />
                <TextField
                  label="Signup Card Subtitle"
                  value={portalFields.signupCardSubtitle || ""}
                  onChange={(v) => handlePortalFieldChange("signupCardSubtitle", v)}
                  autoComplete="off"
                />

                {/* Benefit Cards */}
                <Divider />
                <Text variant="headingSm" as="h3">Benefit Cards</Text>
                {[1, 2, 3].map((n) => (
                  <InlineGrid columns={2} gap="300" key={`benefit-${n}`}>
                    <TextField
                      label={`Benefit ${n} Title`}
                      value={portalFields[`benefit${n}Title`] || ""}
                      onChange={(v) => handlePortalFieldChange(`benefit${n}Title`, v)}
                      autoComplete="off"
                    />
                    <TextField
                      label={`Benefit ${n} Description`}
                      value={portalFields[`benefit${n}Desc`] || ""}
                      onChange={(v) => handlePortalFieldChange(`benefit${n}Desc`, v)}
                      autoComplete="off"
                    />
                  </InlineGrid>
                ))}

                {/* Terms */}
                <Divider />
                <Text variant="headingSm" as="h3">Key Terms</Text>
                <TextField
                  label="Terms Section Heading"
                  value={portalFields.termsHeading || ""}
                  onChange={(v) => handlePortalFieldChange("termsHeading", v)}
                  autoComplete="off"
                />
                {[1, 2, 3, 4].map((n) => (
                  <InlineGrid columns={{ xs: 1, md: "70px 1fr" }} gap="300" key={`term-${n}`}>
                    <TextField
                      label={`Icon ${n}`}
                      value={portalFields[`term${n}Icon`] || ""}
                      onChange={(v) => handlePortalFieldChange(`term${n}Icon`, v)}
                      autoComplete="off"
                    />
                    <TextField
                      label={`Term ${n} Text`}
                      value={portalFields[`term${n}Text`] || ""}
                      onChange={(v) => handlePortalFieldChange(`term${n}Text`, v)}
                      autoComplete="off"
                      helpText="Use {store} for the store name"
                    />
                  </InlineGrid>
                ))}

                {/* Dashboard Labels */}
                <Divider />
                <Text variant="headingSm" as="h3">Dashboard Labels</Text>
                <InlineGrid columns={3} gap="300">
                  <TextField
                    label="Dashboard Title"
                    value={portalFields.dashboardTitle || ""}
                    onChange={(v) => handlePortalFieldChange("dashboardTitle", v)}
                    autoComplete="off"
                  />
                  <TextField
                    label="Submit Video Title"
                    value={portalFields.submitVideoTitle || ""}
                    onChange={(v) => handlePortalFieldChange("submitVideoTitle", v)}
                    autoComplete="off"
                  />
                  <TextField
                    label="Your Videos Title"
                    value={portalFields.yourVideosTitle || ""}
                    onChange={(v) => handlePortalFieldChange("yourVideosTitle", v)}
                    autoComplete="off"
                  />
                </InlineGrid>

                {/* Actions */}
                <Divider />
                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    onClick={handleSavePortalContent}
                    loading={portalSaving}
                  >
                    Save Portal Content
                  </Button>
                  <Button
                    onClick={handlePreviewPortal}
                    loading={portalSaving}
                  >
                    Preview Portal
                  </Button>
                </InlineStack>
              </BlockStack>
            </Collapsible>
          </BlockStack>
        </Card>

        {/* Portal Preview Modal */}
        {showPortalPreview && portalPreviewHtml && (
          <Modal
            open={showPortalPreview}
            onClose={() => setShowPortalPreview(false)}
            title="Creator Portal Preview"
            size="large"
          >
            <Modal.Section>
              <div
                style={{
                  border: "1px solid #e1e3e5",
                  borderRadius: "8px",
                  overflow: "hidden",
                  background: "#fff",
                }}
              >
                <iframe
                  srcDoc={portalPreviewHtml}
                  style={{
                    width: "100%",
                    height: "700px",
                    border: "none",
                  }}
                  title="Portal Preview"
                  sandbox="allow-scripts"
                />
              </div>
            </Modal.Section>
          </Modal>
        )}

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
          </>
        )}
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

function MetricCard({ title, value }) {
  return (
    <Card>
      <BlockStack gap="150">
        <Text variant="bodySm" tone="subdued">{title}</Text>
        <Text variant="headingLg" as="p">{value}</Text>
      </BlockStack>
    </Card>
  );
}

function StatusCard({ title, status, message }) {
  const tone = status === "active" || status === "connected" || status === "healthy"
    ? "success"
    : status === "disabled"
    ? "attention"
    : "critical";

  return (
    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
      <BlockStack gap="150">
        <InlineStack align="space-between" blockAlign="center">
          <Text variant="headingSm">{title}</Text>
          <Badge tone={tone}>{status}</Badge>
        </InlineStack>
        <Text variant="bodySm" tone="subdued">{message}</Text>
      </BlockStack>
    </Box>
  );
}

function formatCurrency(value) {
  const amount = Number(value) || 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatInteger(value) {
  return (Number(value) || 0).toLocaleString();
}

function formatOrderDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
