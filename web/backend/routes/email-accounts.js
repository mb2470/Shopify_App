/**
 * Email Account Routes
 * Create, list, and manage email accounts (mailboxes) connected to Smartlead.
 * All operations scoped to the merchant's shop.
 */

import { PrismaClient } from "@prisma/client";
import { getServiceClients } from "./email-settings.js";

const prisma = new PrismaClient();

/**
 * GET /api/email/accounts
 * List all email accounts for this merchant
 */
export async function listEmailAccounts(shop) {
  const accounts = await prisma.emailAccount.findMany({
    where: { shop },
    include: { domain: { select: { domain: true, registrarStatus: true } } },
    orderBy: { createdAt: "desc" },
  });
  return accounts;
}

/**
 * POST /api/email/accounts
 * Create a new email account and connect it to Smartlead
 *
 * @param {string} shop
 * @param {object} params
 * @param {string} params.domainId - ID of the EmailDomain
 * @param {string} params.localPart - The part before @ (e.g. "john")
 * @param {string} params.password - SMTP/IMAP password
 * @param {string} [params.fromName] - Display name
 * @param {string} [params.smtpHost] - SMTP server (defaults to smtp.zoho.com)
 * @param {string} [params.imapHost] - IMAP server (defaults to imap.zoho.com)
 */
export async function createEmailAccount(shop, {
  domainId,
  localPart,
  password,
  fromName,
  smtpHost = "smtp.zoho.com",
  smtpPort = 587,
  imapHost = "imap.zoho.com",
  imapPort = 993,
}) {
  // Verify domain belongs to this shop
  const domain = await prisma.emailDomain.findFirst({
    where: { id: domainId, shop },
  });
  if (!domain) throw new Error("Domain not found");

  const emailAddress = `${localPart}@${domain.domain}`;

  // Check for duplicate
  const existing = await prisma.emailAccount.findUnique({
    where: { emailAddress },
  });
  if (existing) throw new Error(`Email account ${emailAddress} already exists`);

  const { smartlead } = await getServiceClients(shop);
  if (!smartlead) throw new Error("Smartlead API key not configured");

  // Register in Smartlead
  const slResult = await smartlead.addEmailAccount({
    fromEmail: emailAddress,
    fromName: fromName || localPart,
    userName: emailAddress,
    password,
    smtpHost,
    smtpPort,
    imapHost,
    imapPort,
    maxDailyLimit: 20,
    warmupEnabled: true,
  });

  const smartleadAccountId = String(slResult.id || slResult.email_account_id || "");

  // Store in DB
  const account = await prisma.emailAccount.create({
    data: {
      shop,
      domainId,
      emailAddress,
      smartleadAccountId,
      smtpHost,
      smtpPort,
      imapHost,
      imapPort,
      warmupEnabled: true,
      warmupStatus: "active",
    },
  });

  return account;
}

/**
 * POST /api/email/accounts/:id/warmup
 * Toggle warmup on or off for an email account
 */
export async function toggleWarmup(shop, accountId, enabled) {
  const account = await prisma.emailAccount.findFirst({
    where: { id: accountId, shop },
  });
  if (!account) throw new Error("Email account not found");
  if (!account.smartleadAccountId) throw new Error("Account not linked to Smartlead");

  const { smartlead } = await getServiceClients(shop);
  if (!smartlead) throw new Error("Smartlead API key not configured");

  await smartlead.updateWarmup(account.smartleadAccountId, enabled);

  const updated = await prisma.emailAccount.update({
    where: { id: accountId },
    data: {
      warmupEnabled: enabled,
      warmupStatus: enabled ? "active" : "paused",
    },
  });

  return updated;
}

/**
 * GET /api/email/accounts/:id/warmup
 * Fetch current warmup stats from Smartlead
 */
export async function getWarmupStats(shop, accountId) {
  const account = await prisma.emailAccount.findFirst({
    where: { id: accountId, shop },
  });
  if (!account) throw new Error("Email account not found");
  if (!account.smartleadAccountId) throw new Error("Account not linked to Smartlead");

  const { smartlead } = await getServiceClients(shop);
  if (!smartlead) throw new Error("Smartlead API key not configured");

  const stats = await smartlead.getWarmupStats(account.smartleadAccountId);
  return stats;
}

/**
 * POST /api/email/accounts/:id/assign
 * Assign an email account to a campaign in Smartlead
 */
export async function assignToCampaign(shop, accountId, campaignId) {
  const account = await prisma.emailAccount.findFirst({
    where: { id: accountId, shop },
  });
  if (!account) throw new Error("Email account not found");
  if (!account.smartleadAccountId) throw new Error("Account not linked to Smartlead");

  const campaign = await prisma.outreachCampaign.findFirst({
    where: { id: campaignId, shop },
  });
  if (!campaign) throw new Error("Campaign not found");
  if (!campaign.smartleadCampaignId) throw new Error("Campaign not linked to Smartlead");

  const { smartlead } = await getServiceClients(shop);
  if (!smartlead) throw new Error("Smartlead API key not configured");

  await smartlead.addEmailsToCampaign(campaign.smartleadCampaignId, [
    account.smartleadAccountId,
  ]);

  // Update campaign's emailAccountIds JSON array
  const existingIds = campaign.emailAccountIds
    ? JSON.parse(campaign.emailAccountIds)
    : [];
  if (!existingIds.includes(accountId)) {
    existingIds.push(accountId);
    await prisma.outreachCampaign.update({
      where: { id: campaignId },
      data: { emailAccountIds: JSON.stringify(existingIds) },
    });
  }

  return { success: true, message: `${account.emailAddress} assigned to ${campaign.name}` };
}
