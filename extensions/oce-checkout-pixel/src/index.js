import { register } from "@shopify/web-pixels-extension";

function parseBooleanSetting(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return defaultValue;
}

function deriveBridgeEndpoint(pixelEndpoint) {
  if (!pixelEndpoint) return null;
  if (pixelEndpoint.includes("/pixel-collect")) {
    return pixelEndpoint.replace("/pixel-collect", "/checkout-bridge");
  }
  return null;
}

function readAttr(attrs, key) {
  const hit = attrs.find((attr) => attr && attr.key === key);
  return hit ? hit.value : null;
}

function parseExposureIds(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function mapLineItems(checkout) {
  return Array.isArray(checkout?.lineItems)
    ? checkout.lineItems.map((li) => ({
        sku: li?.variant?.sku || li?.variant?.id?.toString() || "unknown",
        product_id: li?.variant?.product?.id ? String(li.variant.product.id) : undefined,
        variant_id: li?.variant?.id ? String(li.variant.id) : undefined,
        qty: li?.quantity || 1,
        price: li?.variant?.price?.amount ? Number(li.variant.price.amount) : 0,
        revenue:
          (li?.variant?.price?.amount ? Number(li.variant.price.amount) : 0) *
          (li?.quantity || 1),
      }))
    : [];
}

async function buildCheckoutContext(checkout, browser) {
  const attrs = Array.isArray(checkout?.attributes) ? checkout.attributes : [];

  let exposureIdsRaw = readAttr(attrs, "oce_exposure_ids") || readAttr(attrs, "_oce_exposure_ids");
  let sessionId = readAttr(attrs, "oce_session_id") || readAttr(attrs, "_oce_session_id");
  let oaId = readAttr(attrs, "oce_oa_id") || readAttr(attrs, "_oce_oa_id");

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

  return {
    checkoutToken: checkout?.token ? String(checkout.token) : undefined,
    currency: checkout?.currencyCode || "USD",
    exposureIds: parseExposureIds(exposureIdsRaw),
    sessionId: sessionId || undefined,
    oaId: oaId || undefined,
    lineItems: mapLineItems(checkout),
  };
}

register(async ({ analytics, browser, settings }) => {
  const apiKey = settings?.api_key?.trim();
  const pixelEndpoint = settings?.pixel_endpoint?.trim();
  const bridgeEndpoint = deriveBridgeEndpoint(pixelEndpoint);
  const enableCheckoutStartedBridge = parseBooleanSetting(
    settings?.enable_checkout_started_bridge,
    true,
  );
  const enableCheckoutCompletedPost = parseBooleanSetting(
    settings?.enable_checkout_completed_post,
    true,
  );
  if (!apiKey || !pixelEndpoint) return;

  if (enableCheckoutStartedBridge) {
    analytics.subscribe("checkout_started", async (event) => {
      try {
        const checkout = event?.data?.checkout;
        if (!checkout || !bridgeEndpoint) return;

        const context = await buildCheckoutContext(checkout, browser);
        if (
          !context.checkoutToken &&
          !context.oaId &&
          !context.sessionId &&
          context.exposureIds.length === 0
        ) {
          return;
        }

        await fetch(bridgeEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            checkout_token: context.checkoutToken,
            currency: context.currency,
            exposure_ids: context.exposureIds,
            session_id: context.sessionId,
            oa_id: context.oaId,
            line_items: context.lineItems,
            source: "checkout_started",
          }),
          keepalive: true,
        });
      } catch (err) {
        console.log("checkout_started bridge error", err);
      }
    });
  }

  if (enableCheckoutCompletedPost) {
    analytics.subscribe("checkout_completed", async (event) => {
      try {
        const checkout = event?.data?.checkout;
        if (!checkout) return;
        if (!checkout?.order?.id) return;

        const context = await buildCheckoutContext(checkout, browser);
        const payload = {
          api_key: apiKey,
          order_id: String(checkout.order.id),
          ts: event.timestamp || new Date().toISOString(),
          currency: context.currency,
          exposure_ids: context.exposureIds,
          session_id: context.sessionId,
          oa_id: context.oaId,
          checkout_token: context.checkoutToken,
          line_items: context.lineItems,
        };

        await fetch(pixelEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true,
        });
      } catch (err) {
        console.log("checkout_completed pixel error", err);
      }
    });
  }
});
