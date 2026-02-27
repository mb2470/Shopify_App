/**
 * Email Inbox Routes
 * List, read, and manage inbound email conversations.
 * All operations scoped to the merchant's shop.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * GET /api/email/inbox
 * Paginated list of conversations (newest first)
 *
 * Query params: campaignId, page (1-based), limit (default 25)
 */
export async function listConversations(shop, { campaignId, page = 1, limit = 25 } = {}) {
  const where = { shop };
  if (campaignId) where.campaignId = campaignId;

  const skip = (Math.max(1, page) - 1) * limit;

  const [conversations, total] = await Promise.all([
    prisma.emailConversation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.emailConversation.count({ where }),
  ]);

  return {
    conversations,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * GET /api/email/inbox/:id
 * Get a single conversation
 */
export async function getConversation(shop, conversationId) {
  const conversation = await prisma.emailConversation.findFirst({
    where: { id: conversationId, shop },
  });
  if (!conversation) throw new Error("Conversation not found");

  // Auto-mark as read when viewed
  if (!conversation.isRead) {
    await prisma.emailConversation.update({
      where: { id: conversationId },
      data: { isRead: true },
    });
    conversation.isRead = true;
  }

  return conversation;
}

/**
 * PUT /api/email/inbox/:id/read
 * Explicitly mark a conversation as read
 */
export async function markAsRead(shop, conversationId) {
  const conversation = await prisma.emailConversation.findFirst({
    where: { id: conversationId, shop },
  });
  if (!conversation) throw new Error("Conversation not found");

  await prisma.emailConversation.update({
    where: { id: conversationId },
    data: { isRead: true },
  });

  return { success: true };
}

/**
 * GET /api/email/inbox/stats
 * Inbox summary: unread count, total replies, per-campaign breakdown
 */
export async function getInboxStats(shop) {
  const [total, unread, byCampaign] = await Promise.all([
    prisma.emailConversation.count({ where: { shop } }),
    prisma.emailConversation.count({ where: { shop, isRead: false } }),
    prisma.emailConversation.groupBy({
      by: ["campaignId"],
      where: { shop },
      _count: { id: true },
    }),
  ]);

  return {
    total,
    unread,
    byCampaign: byCampaign.map((g) => ({
      campaignId: g.campaignId,
      count: g._count.id,
    })),
  };
}
