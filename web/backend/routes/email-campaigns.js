/**
 * Email Campaign Routes
 * Create and manage outreach campaigns via Smartlead.
 * All operations scoped to the merchant's shop.
 */

import { PrismaClient } from "@prisma/client";
import { getServiceClients } from "./email-settings.js";

const prisma = new PrismaClient();

/**
 * GET /api/email/campaigns
 * List all campaigns for this merchant
 */
export async function listCampaigns(shop) {
  const campaigns = await prisma.outreachCampaign.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });

  // Parse emailAccountIds from JSON for the response
  return campaigns.map((c) => ({
    ...c,
    emailAccountIds: c.emailAccountIds ? JSON.parse(c.emailAccountIds) : [],
  }));
}

/**
 * POST /api/email/campaigns
 * Create a new campaign in Smartlead and store locally
 */
export async function createCampaign(shop, name) {
  if (!name || !name.trim()) {
    throw new Error("Campaign name is required");
  }

  const { smartlead } = await getServiceClients(shop);
  if (!smartlead) throw new Error("Smartlead API key not configured");

  // Create in Smartlead
  const slResult = await smartlead.createCampaign(name.trim());
  const smartleadCampaignId = String(slResult.id || slResult.campaign_id || "");

  // Store locally
  const campaign = await prisma.outreachCampaign.create({
    data: {
      shop,
      name: name.trim(),
      smartleadCampaignId,
      status: "draft",
    },
  });

  return campaign;
}

/**
 * GET /api/email/campaigns/:id
 * Get detailed campaign info including stats from Smartlead
 */
export async function getCampaignDetail(shop, campaignId) {
  const campaign = await prisma.outreachCampaign.findFirst({
    where: { id: campaignId, shop },
  });
  if (!campaign) throw new Error("Campaign not found");

  let smartleadStats = null;
  if (campaign.smartleadCampaignId) {
    try {
      const { smartlead } = await getServiceClients(shop);
      if (smartlead) {
        smartleadStats = await smartlead.getCampaignStats(campaign.smartleadCampaignId);
      }
    } catch (err) {
      console.warn("[Email] Could not fetch Smartlead stats for campaign", campaignId, ":", err.message);
    }
  }

  // Count conversations for this campaign
  const replyCount = await prisma.emailConversation.count({
    where: { shop, campaignId, direction: "inbound" },
  });

  // Get assigned email accounts
  const accountIds = campaign.emailAccountIds ? JSON.parse(campaign.emailAccountIds) : [];
  let accounts = [];
  if (accountIds.length > 0) {
    accounts = await prisma.emailAccount.findMany({
      where: { id: { in: accountIds }, shop },
      select: { id: true, emailAddress: true, warmupStatus: true, status: true },
    });
  }

  return {
    ...campaign,
    emailAccountIds: accountIds,
    accounts,
    replyCount,
    smartleadStats,
  };
}
