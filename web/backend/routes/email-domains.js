/**
 * Email Domain Routes
 * Search, purchase, DNS provisioning, and verification for email domains
 * via the Cloudflare API. All operations scoped to the merchant's shop.
 */

import { PrismaClient } from "@prisma/client";
import { getServiceClients } from "./email-settings.js";

const prisma = new PrismaClient();

/**
 * GET /api/email/domains
 * List all domains owned by this merchant
 */
export async function listDomains(shop) {
  const domains = await prisma.emailDomain.findMany({
    where: { shop },
    include: { emailAccounts: { select: { id: true, emailAddress: true, status: true } } },
    orderBy: { createdAt: "desc" },
  });
  return domains;
}

/**
 * GET /api/email/domains/:id
 * Get detailed status for a single domain
 */
export async function getDomainStatus(shop, domainId) {
  const domain = await prisma.emailDomain.findFirst({
    where: { id: domainId, shop },
    include: { emailAccounts: true },
  });

  if (!domain) {
    throw new Error("Domain not found");
  }

  return domain;
}

/**
 * POST /api/email/domains/search
 * Search for available domains via Cloudflare Registrar
 */
export async function searchDomains(shop, query) {
  const { cloudflare } = await getServiceClients(shop);
  if (!cloudflare) {
    throw new Error("Cloudflare credentials not configured");
  }

  const results = await cloudflare.searchDomains(query);
  return results;
}

/**
 * POST /api/email/domains/purchase
 * Purchase a domain via Cloudflare Registrar and store in DB
 */
export async function purchaseDomain(shop, domain, years = 1) {
  const { cloudflare, settings } = await getServiceClients(shop);
  if (!cloudflare) {
    throw new Error("Cloudflare credentials not configured");
  }

  // Build WHOIS contact info from merchant settings
  const contactInfo = {
    first_name: settings.whoisFirstName,
    last_name: settings.whoisLastName,
    address: settings.whoisAddress1,
    city: settings.whoisCity,
    state: settings.whoisState,
    zip: settings.whoisZip,
    country: settings.whoisCountry,
    phone: settings.whoisPhone,
    email: settings.whoisEmail,
    organization: "",
  };

  // Validate required WHOIS fields
  const required = ["first_name", "last_name", "address", "city", "state", "zip", "country", "phone", "email"];
  const missing = required.filter((f) => !contactInfo[f]);
  if (missing.length > 0) {
    throw new Error(`Missing WHOIS contact info: ${missing.join(", ")}. Update Email Settings first.`);
  }

  // Purchase via Cloudflare
  const result = await cloudflare.purchaseDomain(domain, contactInfo, years);

  // Get zone ID (Cloudflare auto-creates a zone for registered domains)
  let zoneId = null;
  try {
    zoneId = await cloudflare.getZoneId(domain);
  } catch (err) {
    console.warn("[Email] Could not fetch zone ID for", domain, ":", err.message);
  }

  // Store in DB
  const domainRecord = await prisma.emailDomain.create({
    data: {
      shop,
      domain,
      cloudflareZoneId: zoneId,
      registrarStatus: "active",
      purchasedAt: new Date(),
      expiresAt: new Date(Date.now() + years * 365 * 24 * 60 * 60 * 1000),
    },
  });

  return domainRecord;
}

/**
 * POST /api/email/domains/:id/provision
 * Provision cold-email DNS records (MX, SPF, DKIM, DMARC) on a domain
 *
 * Accepts an optional `provider` body to customize records.
 * Defaults to a generic Zoho-style configuration.
 */
export async function provisionDns(shop, domainId, providerConfig = null) {
  const domain = await prisma.emailDomain.findFirst({
    where: { id: domainId, shop },
  });
  if (!domain) throw new Error("Domain not found");

  const { cloudflare } = await getServiceClients(shop);
  if (!cloudflare) throw new Error("Cloudflare credentials not configured");

  // Ensure we have a zone ID
  let zoneId = domain.cloudflareZoneId;
  if (!zoneId) {
    zoneId = await cloudflare.getZoneId(domain.domain);
    if (!zoneId) {
      // Try creating the zone
      const zone = await cloudflare.createZone(domain.domain);
      zoneId = zone.id;
    }
    await prisma.emailDomain.update({
      where: { id: domainId },
      data: { cloudflareZoneId: zoneId },
    });
  }

  // Default provider config (generic cold-email setup)
  const provider = providerConfig || {
    mxRecords: [
      { content: "mx.zoho.com", priority: 10 },
      { content: "mx2.zoho.com", priority: 20 },
      { content: "mx3.zoho.com", priority: 50 },
    ],
    spfInclude: "zoho.com",
    dkimRecords: [],
    // DKIM records depend on the provider — merchant adds them after mailbox creation
  };

  const results = await cloudflare.provisionColdEmailDns(zoneId, domain.domain, provider);

  // Update domain record
  await prisma.emailDomain.update({
    where: { id: domainId },
    data: {
      dnsConfigured: true,
      mxVerified: results.mx.length > 0,
      spfVerified: !!results.spf,
      dmarcVerified: !!results.dmarc,
    },
  });

  return results;
}

/**
 * POST /api/email/domains/:id/verify
 * Check that all required DNS records exist and are propagated
 */
export async function verifyDns(shop, domainId) {
  const domain = await prisma.emailDomain.findFirst({
    where: { id: domainId, shop },
  });
  if (!domain) throw new Error("Domain not found");
  if (!domain.cloudflareZoneId) throw new Error("Domain has no Cloudflare zone");

  const { cloudflare } = await getServiceClients(shop);
  if (!cloudflare) throw new Error("Cloudflare credentials not configured");

  const status = await cloudflare.verifyDnsRecords(domain.cloudflareZoneId, domain.domain);

  // Persist verification status
  await prisma.emailDomain.update({
    where: { id: domainId },
    data: {
      mxVerified: status.mx,
      spfVerified: status.spf,
      dkimVerified: status.dkim,
      dmarcVerified: status.dmarc,
    },
  });

  return status;
}
