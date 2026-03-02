/**
 * Scan the active Shopify theme for video content.
 *
 * Detects videos from three patterns:
 *  1. Explicit data-oce-asset-id attributes in Liquid files
 *  2. Standard Shopify video sections in JSON template configs
 *     (video_url for YouTube/Vimeo, video settings for Shopify-hosted)
 *  3. video_tag Liquid filter usage (flags sections that render video)
 */

/**
 * @param {string} shopDomain  – e.g. "my-store.myshopify.com"
 * @param {string} accessToken – Shopify Admin access token
 * @returns {Promise<Array>}   – discovered video entries
 */
export async function scanThemeForVideos(shopDomain, accessToken) {
  const shopApi = `https://${shopDomain}/admin/api/2024-10`;
  const headers = { "X-Shopify-Access-Token": accessToken };
  const videos = [];
  const foundIds = new Set();

  // 1. Find the main/published theme
  const themesRes = await fetch(`${shopApi}/themes.json`, { headers });
  const themesData = await themesRes.json();
  const mainTheme = (themesData.themes || []).find((t) => t.role === "main");
  if (!mainTheme) return videos;

  // 2. List all assets
  const assetsRes = await fetch(
    `${shopApi}/themes/${mainTheme.id}/assets.json`,
    { headers }
  );
  const assetsData = await assetsRes.json();

  const scanFiles = (assetsData.assets || [])
    .map((a) => a.key)
    .filter(
      (k) =>
        (k.endsWith(".liquid") &&
          (k.startsWith("sections/") ||
            k.startsWith("blocks/") ||
            k.startsWith("snippets/") ||
            k.startsWith("templates/"))) ||
        (k.endsWith(".json") && k.startsWith("templates/"))
    );

  // 3. Read files in batches of 5
  for (let i = 0; i < scanFiles.length; i += 5) {
    const batch = scanFiles.slice(i, i + 5);
    const fetches = batch.map((key) =>
      fetch(
        `${shopApi}/themes/${mainTheme.id}/assets.json?asset[key]=${encodeURIComponent(key)}`,
        { headers }
      )
        .then((r) => r.json())
        .catch(() => null)
    );
    const results = await Promise.all(fetches);

    for (const result of results) {
      const key = result?.asset?.key;
      const content = result?.asset?.value;
      if (!content) continue;

      if (key?.endsWith(".json")) {
        parseJsonTemplate(content, videos, foundIds);
      } else {
        parseLiquidFile(key, content, videos, foundIds);
      }
    }
  }

  return videos;
}

// ── JSON template parsing ──────────────────────────────────────────────

function parseJsonTemplate(content, videos, foundIds) {
  let json;
  try {
    json = JSON.parse(content);
  } catch {
    return;
  }

  const sections = json.sections || {};
  for (const [secId, sec] of Object.entries(sections)) {
    extractVideoSettings(secId, sec.type, sec.settings, videos, foundIds);

    // Also check blocks within the section
    const blocks = sec.blocks || {};
    for (const [blockId, block] of Object.entries(blocks)) {
      extractVideoSettings(
        `${secId}-${blockId}`,
        block.type,
        block.settings,
        videos,
        foundIds
      );
    }
  }
}

function extractVideoSettings(id, type, settings, videos, foundIds) {
  if (!settings) return;

  // video_url setting — YouTube / Vimeo URLs
  if (settings.video_url) {
    const url =
      typeof settings.video_url === "string"
        ? settings.video_url
        : settings.video_url?.url;
    if (url) {
      const ytMatch = url.match(
        /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/
      );
      const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);

      if (ytMatch) {
        addVideo(`yt-${ytMatch[1]}`, `YouTube Video (${ytMatch[1]})`, url, "YouTube", videos, foundIds);
      } else if (vimeoMatch) {
        addVideo(`vimeo-${vimeoMatch[1]}`, `Vimeo Video (${vimeoMatch[1]})`, url, "Vimeo", videos, foundIds);
      }
    }
  }

  // video setting — Shopify-hosted video reference (e.g. "shopify://videos/28841836175599")
  if (settings.video && typeof settings.video === "string") {
    const ref = settings.video;
    const videoIdMatch = ref.match(/shopify:\/\/videos\/(\d+)/);
    const assetId = videoIdMatch
      ? `shopify-video-${videoIdMatch[1]}`
      : `shopify-theme-video-${id}`;
    const title =
      settings.heading ||
      settings.description ||
      type ||
      `Video (${id})`;
    addVideo(assetId, title, ref, "Shopify", videos, foundIds);
  }
}

function addVideo(assetId, title, source, platform, videos, foundIds) {
  if (foundIds.has(assetId)) return;
  foundIds.add(assetId);
  videos.push({
    assetId,
    title,
    source,
    thumbnail: null,
    platform,
    skus: [],
    exposureCount: 0,
    lastSeen: null,
    discoveredBy: "theme",
  });
}

// ── Liquid file parsing ────────────────────────────────────────────────

function parseLiquidFile(key, content, videos, foundIds) {
  // 1. Explicit OCE asset IDs
  const tagRegex = /data-oce-asset-id=["']([^"']+)["']/g;
  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    const assetId = match[1];
    if (foundIds.has(assetId)) continue;
    foundIds.add(assetId);
    const escaped = assetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const skuMatch = content.match(
      new RegExp(
        `data-oce-asset-id=["']${escaped}["'][^>]*data-oce-sku=["']([^"']+)["']`
      )
    );
    videos.push({
      assetId,
      title: assetId,
      source: null,
      thumbnail: null,
      platform: "HTML5",
      skus: skuMatch ? [skuMatch[1]] : [],
      exposureCount: 0,
      lastSeen: null,
      discoveredBy: "theme",
    });
  }

  // 2. video_tag Liquid filter — section renders a Shopify video
  //    Only match sections/ and blocks/ to avoid false positives from
  //    helper snippets (e.g. product-media.liquid) and templates.
  if (content.includes("video_tag") && (key.startsWith("sections/") || key.startsWith("blocks/"))) {
    const sectionName = key
      .replace(/\.liquid$/, "")
      .replace(/^(sections|blocks)\//, "");
    const assetId = `shopify-section-${sectionName}`;
    if (!foundIds.has(assetId)) {
      foundIds.add(assetId);
      // Try to extract a human-readable name from the schema
      let title = `Video Section: ${sectionName}`;
      const nameMatch = content.match(/"name"\s*:\s*"([^"]+)"/);
      if (nameMatch) title = nameMatch[1];
      videos.push({
        assetId,
        title,
        source: null,
        thumbnail: null,
        platform: "Shopify",
        skus: [],
        exposureCount: 0,
        lastSeen: null,
        discoveredBy: "theme",
      });
    }
  }
}
