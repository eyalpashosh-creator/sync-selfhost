import { defineAction, z, type ActionsModule, type Ctx } from "./portable-sdk.js";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import * as schema from "./schema";

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DRAFT_VIDEO_BYTES = 500 * 1024 * 1024;
const DRAFT_UPLOAD_CHUNK_BYTES = 2_500_000;
const RESOLVE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_EXPIRY_MS = 60 * 60 * 1000;
const PASSWORD_RESET_RATE_WINDOW_MS = 60 * 60 * 1000;
const PASSWORD_RESET_RATE_LIMIT = 3;
const PASSWORD_RESET_CONFIRMATION = "If an account exists for that email, a reset link is on its way";
const roleSchema = z.enum(["artist", "curator"]);
const GENRES = ["Hip-Hop", "Pop", "Electronic/Dance", "R&B", "Indie", "Rock", "Latin", "Afrobeats", "Country", "Jazz", "Lo-Fi", "Classical", "Ambient", "Punk/Metal"] as const;
const MOODS = ["Energetic", "Chill", "Dark", "Uplifting", "Romantic", "Aggressive", "Nostalgic", "Dreamy", "Hype", "Melancholic", "Playful", "Epic"] as const;
const genreSchema = z.enum(GENRES);
const moodSchema = z.enum(MOODS);
const invitePlanSchema = z.enum(["starter", "growth", "professional"]);
const inviteCreditSchema = z.object({ plan: invitePlanSchema, limit: z.number().int().positive().nullable(), remaining: z.number().int().nonnegative().nullable(), resetsAt: z.number().int().positive().nullable() });
type Role = z.infer<typeof roleSchema>;
type InvitePlan = z.infer<typeof invitePlanSchema>;

const userSchema = z.object({ name: z.string(), email: z.string(), username: z.string(), role: roleSchema, bio: z.string().optional(), avatarUrl: z.string().optional() });
const authResponse = z.object({ ok: z.boolean(), user: userSchema.optional(), sessionToken: z.string().optional(), notice: z.string().optional(), error: z.string().optional() });


async function sha256(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Buffer.from(digest).toString("hex"); }
function normalizeEmail(value: string): string { return value.trim().toLowerCase(); }
function randomHex(bytes: number): string { return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex"); }
async function derivePasswordHash(password: string, saltHex: string): Promise<string> { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]); const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: Buffer.from(saltHex, "hex"), iterations: 210000 }, key, 256); return Buffer.from(bits).toString("hex"); }
function secureEqual(left: string, right: string): boolean { const a = Buffer.from(left, "hex"); const b = Buffer.from(right, "hex"); if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0); return diff === 0; }
function safeArray(value: string): string[] { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }
function defaultUsername(role: Role, id: number): string { return role === "artist" ? `artist-${id}` : `curator-${id}`; }
function inviteLimit(plan: InvitePlan): number | null { return plan === "starter" ? 5 : plan === "growth" ? 20 : null; }
function nextInviteReset(now: Date): Date { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)); }
async function refreshInviteCredits(ctx: Ctx, curatorUserId: number): Promise<{ plan: InvitePlan; limit: number | null; remaining: number | null; resetsAt: number | null } | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select({ id: schema.curatorProfiles.id, plan: schema.curatorProfiles.invitePlan, remaining: schema.curatorProfiles.inviteCreditsRemaining, resetsAt: schema.curatorProfiles.inviteCreditsResetAt }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, curatorUserId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const limit = inviteLimit(row.plan);
  if (limit === null) return { plan: row.plan, limit: null, remaining: null, resetsAt: null };
  const now = new Date();
  if (row.resetsAt.getTime() <= now.getTime()) {
    const resetsAt = nextInviteReset(now);
    await db.update(schema.curatorProfiles).set({ inviteCreditsRemaining: limit, inviteCreditsResetAt: resetsAt }).where(eq(schema.curatorProfiles.id, row.id));
    return { plan: row.plan, limit, remaining: limit, resetsAt: resetsAt.getTime() };
  }
  return { plan: row.plan, limit, remaining: Math.max(0, row.remaining), resetsAt: row.resetsAt.getTime() };
}

type NotificationKind = typeof schema.notifications.$inferInsert.kind;
async function notify(ctx: Ctx, values: { userId: number; recipientRole: Role; kind: NotificationKind; title: string; body?: string; inviteId?: number; campaignId?: number; createdAt?: Date }): Promise<void> {
  await ctx.db<typeof schema>().insert(schema.notifications).values({ ...values, body: values.body ?? "", createdAt: values.createdAt ?? new Date() });
}

async function usersBlocked(ctx: Ctx, leftUserId: number, rightUserId: number): Promise<boolean> {
  const rows = await ctx.db<typeof schema>().select({ blockerUserId: schema.userBlocks.blockerUserId, blockedUserId: schema.userBlocks.blockedUserId }).from(schema.userBlocks);
  return rows.some((row) => (row.blockerUserId === leftUserId && row.blockedUserId === rightUserId) || (row.blockerUserId === rightUserId && row.blockedUserId === leftUserId));
}
async function expireResolveRequests(ctx: Ctx): Promise<number> {
  const db = ctx.db<typeof schema>();
  const now = new Date();
  const cutoff = now.getTime() - RESOLVE_EXPIRY_MS;
  const pending = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.status, "resolve_pending"))).filter((row) => Boolean(row.resolveRequestedAt && row.resolveRequestedAt.getTime() <= cutoff));
  let expired = 0;
  for (const invite of pending) {
    const campaign = (await db.select({ userId: schema.campaigns.userId, title: schema.campaigns.title }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0];
    const updated = await db.update(schema.collaborations).set({ status: "content_live", liveAt: now, resolveRequestedByRole: null, resolveRequestedAt: null, updatedAt: now }).where(and(eq(schema.collaborations.id, invite.id), eq(schema.collaborations.status, "resolve_pending"))).returning({ id: schema.collaborations.id });
    if (!updated[0] || !campaign) continue;
    await db.insert(schema.collaborationTimelineEvents).values({ inviteId: invite.id, eventType: "resolve_expired", label: "Resolve request expired · collaboration auto-resolved", detail: "No response was received within 7 days.", createdAt: now });
    await notify(ctx, { userId: campaign.userId, recipientRole: "artist", kind: "resolve_expired", title: "Collaboration auto-resolved", body: campaign.title, inviteId: invite.id, campaignId: invite.campaignId, createdAt: now });
    const curatorProfile = (await db.select({ isDemo: schema.curatorProfiles.isDemo }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, invite.curatorUserId)).limit(1))[0];
    const curatorNotificationUserId = curatorProfile?.isDemo ? campaign.userId : invite.curatorUserId;
    await notify(ctx, { userId: curatorNotificationUserId, recipientRole: "curator", kind: "resolve_expired", title: "Collaboration auto-resolved", body: campaign.title, inviteId: invite.id, campaignId: invite.campaignId, createdAt: now });
    expired += 1;
  }
  if (expired) ctx.invalidateQueries();
  return expired;
}

async function createSession(ctx: Ctx, userId: number, role: Role, now = new Date()): Promise<string> { const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, ""); await ctx.db<typeof schema>().insert(schema.userSessions).values({ tokenHash: await sha256(token), userId, role, createdAt: now, expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS) }); return token; }
async function authUser(ctx: Ctx, sessionToken: string): Promise<{ id: number; role: Role; username: string } | null> {
  const db = ctx.db<typeof schema>(); const sessions = await db.select().from(schema.userSessions).where(eq(schema.userSessions.tokenHash, await sha256(sessionToken))).limit(1); const session = sessions[0];
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  const rows = await db.select({ id: schema.users.id, role: schema.users.role, username: schema.users.username }).from(schema.users).where(eq(schema.users.id, session.userId)).limit(1); const user = rows[0];
  if (!user?.role) return null; return { id: user.id, role: user.role, username: user.username ?? defaultUsername(user.role, user.id) };
}
function roleError(expected: Role): string { return `This workspace is for ${expected}s. Sign in through your ${expected} account.`; }

const campaignSchema = z.object({ id: z.number(), title: z.string(), genre: z.string(), mood: z.string(), platforms: z.array(z.string()), notes: z.string(), status: z.enum(["draft", "active", "completed"]), collaborationCount: z.number(), activeCollaborationCount: z.number(), resolvedCollaborationCount: z.number(), createdAt: z.string() });
const platformStatSchema = z.object({ platform: z.enum(["TikTok", "Instagram", "YouTube"]), followers: z.number() });
const publicReviewSchema = z.object({ id: z.number(), reviewerUsername: z.string(), rating: z.number().int().min(1).max(5), body: z.string(), updatedAt: z.string() });
const curatorProfileSchema = z.object({ id: z.number(), displayName: z.string(), username: z.string(), bio: z.string(), avatarUrl: z.string().optional(), platformStats: z.array(platformStatSchema), followerCount: z.number(), ratesTerms: z.string(), genres: z.array(genreSchema), moods: z.array(moodSchema), portfolioLinks: z.array(z.string()), acceptingInvites: z.boolean(), advertised: z.boolean(), isDemo: z.boolean(), averageRating: z.number().nullable(), reviewCount: z.number().int().nonnegative(), reviews: z.array(publicReviewSchema) });
const accountProfileSchema = z.object({ displayName: z.string(), email: z.string(), username: z.string(), bio: z.string(), avatarUrl: z.string().optional(), role: roleSchema, authMethod: z.enum(["email", "google"]), hasPassword: z.boolean(), notifyInvites: z.boolean(), notifyMessages: z.boolean(), notifyDeliverables: z.boolean(), preferredPlatforms: z.array(z.string()), preferredGenres: z.array(genreSchema), preferredMoods: z.array(moodSchema), defaultTerms: z.string(), turnaround: z.string(), discoverable: z.boolean(), available: z.boolean(), advertiseBoost: z.boolean() });
const inviteStatusSchema = z.enum(["invited", "accepted", "declined", "resolve_pending", "content_live"]);
const inviteSchema = z.object({ id: z.number(), campaignId: z.number(), campaignTitle: z.string(), genre: z.string(), mood: z.string(), platforms: z.array(z.string()), notes: z.string(), curator: curatorProfileSchema.optional(), status: inviteStatusSchema, createdAt: z.string(), updatedAt: z.string(), acceptedAt: z.string().optional(), liveAt: z.string().optional(), resolveRequestedByRole: roleSchema.optional(), resolveRequestedAt: z.string().optional() });
const deliverableStageSchema = z.enum(["waiting_draft", "awaiting_review", "changes_requested", "approved", "posted"]);
const workspaceReviewSchema = z.object({ rating: z.number().int().min(1).max(5), body: z.string(), updatedAt: z.string() });
const workspaceSchema = z.object({ inviteId: z.number(), campaignTitle: z.string(), partnerUsername: z.string(), currentRole: roleSchema, testingPreviewEnabled: z.boolean(), status: inviteStatusSchema, resolveRequestedByRole: roleSchema.optional(), resolveRequestedAt: z.string().optional(), resolveExpiresAt: z.string().optional(), blocked: z.boolean(), blockedByMe: z.boolean(), draftReady: z.boolean(), revisionsComplete: z.boolean(), postedLive: z.boolean(), liveLink: z.string(), deliverableStage: deliverableStageSchema, draftUrl: z.string().optional(), draftFilename: z.string().optional(), draftMimeType: z.string().optional(), revisionRoundsUsed: z.number().int().min(0).max(2), revisionRoundsRemaining: z.number().int().min(0).max(2), myReview: workspaceReviewSchema.optional(), receivedReview: workspaceReviewSchema.optional(), messages: z.array(z.object({ id: z.number(), senderUsername: z.string(), senderRole: roleSchema, mine: z.boolean(), body: z.string(), createdAt: z.string() })), timeline: z.array(z.object({ label: z.string(), detail: z.string().optional(), at: z.string() })) });
const passwordResetRelayItemSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  reset_url: z.string().url(),
  created_at: z.string().datetime(),
});
const reportRelayRoleSchema = z.enum(["artist", "curator", "unknown"]);
const reportRelayItemSchema = z.object({
  id: z.string(),
  created_at: z.string().datetime(),
  reporter_username: z.string(),
  reporter_role: reportRelayRoleSchema,
  reported_username: z.string(),
  reported_role: reportRelayRoleSchema,
  reason: z.string(),
  details: z.string(),
  collaboration_id: z.string().nullable(),
  message_id: z.string().nullable(),
  workspace_path: z.string().nullable(),
});

function profileFromRow(row: typeof schema.curatorProfiles.$inferSelect, account?: { avatarUrl?: string; username?: string | null; preferredGenres?: string; preferredMoods?: string }): z.infer<typeof curatorProfileSchema> { const statsRaw = safeArray(row.platformStats); const stats: Array<{ platform: "TikTok" | "Instagram" | "YouTube"; followers: number }> = []; for (const entry of statsRaw) { try { const parsed: unknown = JSON.parse(entry); if (parsed && typeof parsed === "object" && "platform" in parsed && "followers" in parsed) { const p = parsed as { platform?: unknown; followers?: unknown }; if ((p.platform === "TikTok" || p.platform === "Instagram" || p.platform === "YouTube") && typeof p.followers === "number") stats.push({ platform: p.platform, followers: p.followers }); } } catch { /* ignore malformed legacy data */ } } return { id: row.id, displayName: row.displayName, username: account?.username ?? `curator-${row.userId}`, bio: row.bio, avatarUrl: account?.avatarUrl, platformStats: stats.length ? stats : row.platforms.split(",").filter(Boolean).map((platform) => ({ platform: platform as "TikTok" | "Instagram" | "YouTube", followers: row.followerCount })), followerCount: row.followerCount, ratesTerms: row.ratesTerms, genres: safeArray(account?.preferredGenres ?? "[]").filter((value): value is typeof GENRES[number] => GENRES.includes(value as typeof GENRES[number])), moods: safeArray(account?.preferredMoods ?? "[]").filter((value): value is typeof MOODS[number] => MOODS.includes(value as typeof MOODS[number])), portfolioLinks: safeArray(row.portfolioLinks), acceptingInvites: row.acceptingInvites, advertised: row.advertised, isDemo: row.isDemo, averageRating: null, reviewCount: 0, reviews: [] } }
async function withCuratorReviews(ctx: Ctx, userId: number, profile: z.infer<typeof curatorProfileSchema>): Promise<z.infer<typeof curatorProfileSchema>> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.collaborationReviews).where(eq(schema.collaborationReviews.targetUserId, userId)).orderBy(desc(schema.collaborationReviews.updatedAt));
  const publicRows = rows.filter((row) => row.reviewerRole === "artist");
  const reviews = await Promise.all(publicRows.map(async (row) => {
    const reviewer = (await db.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.id, row.reviewerUserId)).limit(1))[0];
    return { id: row.id, reviewerUsername: reviewer?.username ?? `artist-${row.reviewerUserId}`, rating: Math.max(1, Math.min(5, row.rating)), body: row.body, updatedAt: row.updatedAt.toISOString() };
  }));
  const averageRating = reviews.length ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length : null;
  return { ...profile, averageRating, reviewCount: reviews.length, reviews };
}
async function invitePayload(ctx: Ctx, invite: typeof schema.collaborations.$inferSelect): Promise<z.infer<typeof inviteSchema> | null> { const db = ctx.db<typeof schema>(); const campaigns = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1); const campaign = campaigns[0]; if (!campaign) return null; const profiles = await db.select().from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, invite.curatorUserId)).limit(1); const curator = profiles[0]; const curatorUsers = curator ? await db.select({ avatarBlobKey: schema.users.avatarBlobKey, username: schema.users.username, preferredGenres: schema.users.preferredGenres, preferredMoods: schema.users.preferredMoods }).from(schema.users).where(eq(schema.users.id, curator.userId)).limit(1) : []; const curatorUser = curatorUsers[0]; const avatarUrl = curatorUser?.avatarBlobKey ? await ctx.blobs.getUrl(curatorUser.avatarBlobKey) : undefined; return { id: invite.id, campaignId: campaign.id, campaignTitle: campaign.title, genre: campaign.genre, mood: campaign.mood, platforms: campaign.platforms.split(",").filter(Boolean), notes: campaign.notes, curator: curator ? profileFromRow(curator, { avatarUrl, username: curatorUser?.username, preferredGenres: curatorUser?.preferredGenres, preferredMoods: curatorUser?.preferredMoods }) : undefined, status: invite.status, createdAt: invite.createdAt.toISOString(), updatedAt: invite.updatedAt.toISOString(), acceptedAt: invite.acceptedAt?.toISOString(), liveAt: invite.liveAt?.toISOString(), resolveRequestedByRole: invite.resolveRequestedByRole ?? undefined, resolveRequestedAt: invite.resolveRequestedAt?.toISOString() }; }

export const Actions = {
  verifyGoogleCredential: defineAction({
    request: z.object({ credential: z.string().min(100).max(12000), role: roleSchema }),
    response: authResponse,
    async handler(): Promise<z.infer<typeof authResponse>> {
      return { ok: false, error: "Google sign-in is disabled in this self-hosted alpha. Use email and password." };
    },
  }),

  createEmailAccount: defineAction({ request: z.object({ name: z.string().trim().min(2).max(80), email: z.string().trim().email().max(254), password: z.string().min(8).max(128), role: roleSchema }), response: authResponse, async handler(ctx, args): Promise<z.infer<typeof authResponse>> { const db = ctx.db<typeof schema>(); const email = normalizeEmail(args.email); const existing = (await db.select({ passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.email, email)).limit(1))[0]; if (existing) return existing.passwordHash ? { ok: false, error: "An email-and-password account already exists for this email. Sign in instead." } : { ok: false, error: "This email already uses Google sign-in. Continue with Google instead." }; const now = new Date(); const salt = randomHex(16); try { const inserted = await db.insert(schema.users).values({ googleSub: `password:${crypto.randomUUID()}`, email, name: args.name.trim(), role: args.role, passwordHash: await derivePasswordHash(args.password, salt), passwordSalt: salt, createdAt: now, lastSignInAt: now }).returning({ id: schema.users.id }); const row = inserted[0]; if (!row) return { ok: false, error: "We couldn't create your Sync account." }; const username = defaultUsername(args.role, row.id); await db.update(schema.users).set({ username }).where(eq(schema.users.id, row.id)); const sessionToken = await createSession(ctx, row.id, args.role, now); ctx.invalidateQueries(); return { ok: true, user: { name: args.name.trim(), email, username, role: args.role }, sessionToken }; } catch { return { ok: false, error: "An account with this email already exists. Sign in instead." }; } } }),

  signInWithEmail: defineAction({ request: z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(128), role: roleSchema }), response: authResponse, async handler(ctx, args): Promise<z.infer<typeof authResponse>> { try { const db = ctx.db<typeof schema>(); const normalizedEmail = normalizeEmail(args.email); const rows = await db.select().from(schema.users).where(eq(schema.users.email, normalizedEmail)).limit(1); const user = rows[0]; if (user && (!user.passwordHash || !user.passwordSalt)) return { ok: false, error: "This account uses Google sign-in — continue with Google, or set a password in Settings to enable email sign-in." }; if (!user?.passwordHash || !user.passwordSalt) return { ok: false, error: "That email and password combination isn't correct." }; const candidateHash = await derivePasswordHash(args.password, user.passwordSalt); if (!secureEqual(candidateHash, user.passwordHash)) return { ok: false, error: "That email and password combination isn't correct." }; const storedRole = user.role ?? args.role; const username = user.username ?? defaultUsername(storedRole, user.id); const now = new Date(); await db.update(schema.users).set({ role: storedRole, username, lastSignInAt: now }).where(eq(schema.users.id, user.id)); const sessionToken = await createSession(ctx, user.id, storedRole, now); ctx.invalidateQueries(); return { ok: true, user: { name: user.name, email: user.email, username, role: storedRole }, sessionToken, notice: storedRole !== args.role ? `This account is registered as a${storedRole === "artist" ? "n" : ""} ${storedRole}. We opened the correct dashboard.` : undefined }; } catch { return { ok: false, error: "Email sign-in couldn't be completed right now. Try again." }; } } }),

  requestPasswordReset: defineAction({
    request: z.object({ email: z.string().trim().email().max(254), resetBaseUrl: z.string().url().max(2000) }),
    response: z.object({ ok: z.literal(true), message: z.literal(PASSWORD_RESET_CONFIRMATION) }),
    async handler(ctx, args): Promise<{ ok: true; message: typeof PASSWORD_RESET_CONFIRMATION }> {
      const db = ctx.db<typeof schema>();
      const email = normalizeEmail(args.email);
      const now = new Date();
      const rate = (await db.select().from(schema.passwordResetRateLimits).where(eq(schema.passwordResetRateLimits.email, email)).limit(1))[0];
      if (rate && now.getTime() - rate.windowStartedAt.getTime() < PASSWORD_RESET_RATE_WINDOW_MS && rate.requestCount >= PASSWORD_RESET_RATE_LIMIT) return { ok: true, message: PASSWORD_RESET_CONFIRMATION };
      if (rate && now.getTime() - rate.windowStartedAt.getTime() < PASSWORD_RESET_RATE_WINDOW_MS) await db.update(schema.passwordResetRateLimits).set({ requestCount: rate.requestCount + 1 }).where(eq(schema.passwordResetRateLimits.email, email));
      else if (rate) await db.update(schema.passwordResetRateLimits).set({ windowStartedAt: now, requestCount: 1 }).where(eq(schema.passwordResetRateLimits.email, email));
      else await db.insert(schema.passwordResetRateLimits).values({ email, windowStartedAt: now, requestCount: 1 });

      const user = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1))[0];
      const rawToken = randomHex(32);
      const tokenHash = await sha256(rawToken);
      if (user) {
        const base = new URL(args.resetBaseUrl);
        base.pathname = "/";
        base.search = "";
        base.hash = `reset?token=${encodeURIComponent(rawToken)}`;
        await db.update(schema.passwordResetRequests).set({ usedAt: now, resetUrl: null }).where(and(eq(schema.passwordResetRequests.userId, user.id), isNull(schema.passwordResetRequests.usedAt)));
        await db.insert(schema.passwordResetRequests).values({ userId: user.id, email, tokenHash, resetUrl: base.toString(), createdAt: now, expiresAt: new Date(now.getTime() + PASSWORD_RESET_EXPIRY_MS) });
        ctx.invalidateQueries();
      }
      return { ok: true, message: PASSWORD_RESET_CONFIRMATION };
    },
  }),

  validatePasswordReset: defineAction({
    request: z.object({ token: z.string().min(32).max(256) }),
    response: z.object({ valid: z.boolean(), error: z.string().optional() }),
    async handler(ctx, args) {
      const row = (await ctx.db<typeof schema>().select({ expiresAt: schema.passwordResetRequests.expiresAt, usedAt: schema.passwordResetRequests.usedAt }).from(schema.passwordResetRequests).where(eq(schema.passwordResetRequests.tokenHash, await sha256(args.token))).limit(1))[0];
      if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) return { valid: false, error: "This reset link is invalid or has expired. Request a new one from the sign-in screen." };
      return { valid: true };
    },
  }),

  resetPassword: defineAction({
    request: z.object({ token: z.string().min(32).max(256), newPassword: z.string().min(8).max(128) }),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const tokenHash = await sha256(args.token);
      const row = (await db.select().from(schema.passwordResetRequests).where(eq(schema.passwordResetRequests.tokenHash, tokenHash)).limit(1))[0];
      const now = new Date();
      if (!row || row.usedAt || row.expiresAt.getTime() <= now.getTime()) return { ok: false, error: "This reset link is invalid or has expired. Request a new one from the sign-in screen." };
      const claimed = await db.update(schema.passwordResetRequests).set({ usedAt: now, resetUrl: null }).where(and(eq(schema.passwordResetRequests.id, row.id), eq(schema.passwordResetRequests.tokenHash, tokenHash), isNull(schema.passwordResetRequests.usedAt))).returning({ id: schema.passwordResetRequests.id });
      if (!claimed[0]) return { ok: false, error: "This reset link has already been used." };
      const salt = randomHex(16);
      await db.update(schema.users).set({ passwordHash: await derivePasswordHash(args.newPassword, salt), passwordSalt: salt }).where(eq(schema.users.id, row.userId));
      await db.delete(schema.userSessions).where(eq(schema.userSessions.userId, row.userId));
      await db.update(schema.passwordResetRequests).set({ usedAt: now, resetUrl: null }).where(eq(schema.passwordResetRequests.userId, row.userId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  changePassword: defineAction({ request: z.object({ sessionToken: z.string().min(32).max(256), currentPassword: z.string().max(128).optional(), newPassword: z.string().min(8).max(128) }), response: z.object({ ok: z.boolean(), passwordEnabled: z.boolean().optional(), error: z.string().optional() }), async handler(ctx, args) { const auth = await authUser(ctx, args.sessionToken); if (!auth) return { ok: false, error: "Your session expired. Sign in again." }; const db = ctx.db<typeof schema>(); const rows = await db.select({ passwordHash: schema.users.passwordHash, passwordSalt: schema.users.passwordSalt }).from(schema.users).where(eq(schema.users.id, auth.id)).limit(1); const user = rows[0]; if (!user) return { ok: false, error: "Your account couldn't be loaded." }; const hasPassword = Boolean(user.passwordHash && user.passwordSalt); if (hasPassword) { if (!args.currentPassword) return { ok: false, error: "Enter your current password." }; const currentHash = await derivePasswordHash(args.currentPassword, user.passwordSalt ?? ""); if (!user.passwordHash || !secureEqual(currentHash, user.passwordHash)) return { ok: false, error: "Current password is incorrect." }; if (args.currentPassword === args.newPassword) return { ok: false, error: "Choose a new password that is different from your current password." }; } const salt = randomHex(16); await db.update(schema.users).set({ passwordHash: await derivePasswordHash(args.newPassword, salt), passwordSalt: salt }).where(eq(schema.users.id, auth.id)); ctx.invalidateQueries(); return { ok: true, passwordEnabled: true }; } }),

  resumeSession: defineAction({ request: z.object({ sessionToken: z.string().min(32).max(256) }), response: authResponse, async handler(ctx, args): Promise<z.infer<typeof authResponse>> { const db = ctx.db<typeof schema>(); const sessions = await db.select().from(schema.userSessions).where(eq(schema.userSessions.tokenHash, await sha256(args.sessionToken))).limit(1); const session = sessions[0]; if (!session || session.expiresAt.getTime() <= Date.now()) return { ok: false, error: "Your session expired. Sign in again." }; const rows = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).limit(1); const user = rows[0]; if (!user?.role) return { ok: false, error: "Choose Artist or Curator and sign in again to finish setting up this account." }; const username = user.username ?? defaultUsername(user.role, user.id); if (!user.username) await db.update(schema.users).set({ username }).where(eq(schema.users.id, user.id)); const avatarUrl = user.avatarBlobKey ? await ctx.blobs.getUrl(user.avatarBlobKey) : undefined; return { ok: true, user: { name: user.name, email: user.email, username, role: user.role, bio: user.bio, avatarUrl } }; } }),

  switchRoleForTesting: defineAction({ request: z.object({ sessionToken: z.string().min(32).max(256) }), response: authResponse, async handler(ctx, args): Promise<z.infer<typeof authResponse>> { const db = ctx.db<typeof schema>(); const tokenHash = await sha256(args.sessionToken); const sessions = await db.select().from(schema.userSessions).where(eq(schema.userSessions.tokenHash, tokenHash)).limit(1); const session = sessions[0]; if (!session || session.expiresAt.getTime() <= Date.now()) return { ok: false, error: "Your session expired. Sign in again." }; const rows = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).limit(1); const user = rows[0]; if (!user?.role) return { ok: false, error: "This account does not have a role yet." }; const role: Role = user.role === "artist" ? "curator" : "artist"; const username = user.username ?? defaultUsername(role, user.id); await db.update(schema.users).set({ role, username }).where(eq(schema.users.id, user.id)); await db.update(schema.userSessions).set({ role }).where(eq(schema.userSessions.tokenHash, tokenHash)); ctx.invalidateQueries(); return { ok: true, user: { name: user.name, email: user.email, username, role }, notice: `Switched to ${role} for testing.` }; } }),

  listCampaigns: defineAction({ request: z.object({ sessionToken: z.string() }), response: z.object({ ok: z.boolean(), campaigns: z.array(campaignSchema), error: z.string().optional() }), async handler(ctx, args) { const user = await authUser(ctx, args.sessionToken); if (!user || user.role !== "artist") return { ok: false, campaigns: [], error: roleError("artist") }; const db = ctx.db<typeof schema>(); const rows = await db.select().from(schema.campaigns).where(eq(schema.campaigns.userId, user.id)).orderBy(desc(schema.campaigns.createdAt)); const collaborationRows = await db.select({ campaignId: schema.collaborations.campaignId, status: schema.collaborations.status }).from(schema.collaborations); return { ok: true, campaigns: rows.map((r) => { const campaignCollaborations = collaborationRows.filter((item) => item.campaignId === r.id); const activeCollaborationCount = campaignCollaborations.filter((item) => item.status === "invited" || item.status === "accepted" || item.status === "resolve_pending").length; const resolvedCollaborationCount = campaignCollaborations.filter((item) => item.status === "content_live").length; const meaningfulCount = activeCollaborationCount + resolvedCollaborationCount; const status = meaningfulCount === 0 ? "draft" as const : activeCollaborationCount === 0 ? "completed" as const : "active" as const; return { id: r.id, title: r.title, genre: r.genre, mood: r.mood, platforms: r.platforms.split(",").filter(Boolean), notes: r.notes, status, collaborationCount: campaignCollaborations.length, activeCollaborationCount, resolvedCollaborationCount, createdAt: r.createdAt.toISOString() }; }) }; } }),
  createCampaign: defineAction({ request: z.object({ sessionToken: z.string(), title: z.string().trim().min(1).max(120), genre: z.string().trim().min(1).max(60), mood: z.string().trim().min(1).max(80), platforms: z.array(z.enum(["TikTok", "Instagram", "YouTube"])).min(1), notes: z.string().max(1000) }), response: z.object({ ok: z.boolean(), campaign: campaignSchema.optional(), error: z.string().optional() }), async handler(ctx, args) { const user = await authUser(ctx, args.sessionToken); if (!user || user.role !== "artist") return { ok: false, error: roleError("artist") }; const now = new Date(); const rows = await ctx.db<typeof schema>().insert(schema.campaigns).values({ userId: user.id, title: args.title, genre: args.genre, mood: args.mood, targetNiche: "Independent music promotion", platforms: args.platforms.join(","), notes: args.notes.trim(), status: "draft", createdAt: now }).returning({ id: schema.campaigns.id }); const row = rows[0]; if (!row) return { ok: false, error: "Campaign couldn't be created." }; ctx.invalidateQueries(); return { ok: true, campaign: { id: row.id, title: args.title, genre: args.genre, mood: args.mood, platforms: args.platforms, notes: args.notes.trim(), status: "draft" as const, collaborationCount: 0, activeCollaborationCount: 0, resolvedCollaborationCount: 0, createdAt: now.toISOString() } }; } }),

  getAccountProfile: defineAction({ request: z.object({ sessionToken: z.string() }), response: z.object({ ok: z.boolean(), profile: accountProfileSchema.optional(), error: z.string().optional() }), async handler(ctx, args) { const auth = await authUser(ctx, args.sessionToken); if (!auth) return { ok: false, error: "Your session expired." }; const db = ctx.db<typeof schema>(); const rows = await db.select().from(schema.users).where(eq(schema.users.id, auth.id)).limit(1); const row = rows[0]; if (!row?.role) return { ok: false, error: "Profile couldn't be loaded." }; const avatarUrl = row.avatarBlobKey ? await ctx.blobs.getUrl(row.avatarBlobKey) : undefined; return { ok: true, profile: { displayName: row.name, email: row.email, username: row.username ?? defaultUsername(row.role, row.id), bio: row.bio, avatarUrl, role: row.role, authMethod: (row.passwordHash && row.passwordSalt ? "email" : "google") as "email" | "google", hasPassword: Boolean(row.passwordHash && row.passwordSalt), notifyInvites: row.notifyInvites, notifyMessages: row.notifyMessages, notifyDeliverables: row.notifyDeliverables, preferredPlatforms: safeArray(row.preferredPlatforms), preferredGenres: safeArray(row.preferredGenres).filter((value): value is typeof GENRES[number] => GENRES.includes(value as typeof GENRES[number])), preferredMoods: safeArray(row.preferredMoods).filter((value): value is typeof MOODS[number] => MOODS.includes(value as typeof MOODS[number])), defaultTerms: row.defaultTerms, turnaround: row.turnaround, discoverable: row.discoverable, available: row.available, advertiseBoost: row.advertiseBoost } }; } }),
  saveAccountProfile: defineAction({ request: z.object({ sessionToken: z.string(), displayName: z.string().trim().min(2).max(80), username: z.string().trim().min(3).max(30).regex(/^[a-zA-Z0-9._-]+$/), bio: z.string().trim().max(500), avatarBase64: z.string().max(8_000_000).optional(), avatarMimeType: z.enum(["image/jpeg", "image/png", "image/webp"]).optional() }), response: z.object({ ok: z.boolean(), profile: accountProfileSchema.optional(), error: z.string().optional() }), async handler(ctx, args) { const auth = await authUser(ctx, args.sessionToken); if (!auth) return { ok: false, error: "Your session expired." }; const db = ctx.db<typeof schema>(); const rows = await db.select().from(schema.users).where(eq(schema.users.id, auth.id)).limit(1); const row = rows[0]; if (!row?.role) return { ok: false, error: "Profile couldn't be saved." }; let avatarBlobKey = row.avatarBlobKey; if (args.avatarBase64 && args.avatarMimeType) { const raw = args.avatarBase64.replace(/^data:image\/(?:jpeg|png|webp);base64,/, ""); const bytes = Uint8Array.from(Buffer.from(raw, "base64")); if (bytes.byteLength > 5_000_000) return { ok: false, error: "Choose an image smaller than 5 MB." }; avatarBlobKey = `avatars/${auth.id}/${crypto.randomUUID()}`; await ctx.blobs.put(avatarBlobKey, bytes, { contentType: args.avatarMimeType }); } const name = args.displayName.trim(); const username = args.username.trim(); const bio = args.bio.trim(); await db.update(schema.users).set({ name, username, bio, avatarBlobKey }).where(eq(schema.users.id, auth.id)); if (row.role === "curator") await db.update(schema.curatorProfiles).set({ displayName: name, bio, updatedAt: new Date() }).where(eq(schema.curatorProfiles.userId, auth.id)); const avatarUrl = avatarBlobKey ? await ctx.blobs.getUrl(avatarBlobKey) : undefined; ctx.invalidateQueries(); return { ok: true, profile: { displayName: name, email: row.email, username, bio, avatarUrl, role: row.role, authMethod: (row.passwordHash && row.passwordSalt ? "email" : "google") as "email" | "google", hasPassword: Boolean(row.passwordHash && row.passwordSalt), notifyInvites: row.notifyInvites, notifyMessages: row.notifyMessages, notifyDeliverables: row.notifyDeliverables, preferredPlatforms: safeArray(row.preferredPlatforms), preferredGenres: safeArray(row.preferredGenres).filter((value): value is typeof GENRES[number] => GENRES.includes(value as typeof GENRES[number])), preferredMoods: safeArray(row.preferredMoods).filter((value): value is typeof MOODS[number] => MOODS.includes(value as typeof MOODS[number])), defaultTerms: row.defaultTerms, turnaround: row.turnaround, discoverable: row.discoverable, available: row.available, advertiseBoost: row.advertiseBoost } }; } }),
  savePreferences: defineAction({ request: z.object({ sessionToken: z.string(), notifyInvites: z.boolean(), notifyMessages: z.boolean(), notifyDeliverables: z.boolean(), preferredPlatforms: z.array(z.enum(["TikTok", "Instagram", "YouTube"])).max(3), preferredGenres: z.array(genreSchema).max(GENRES.length), preferredMoods: z.array(moodSchema).max(MOODS.length), defaultTerms: z.string().max(1000), turnaround: z.string().max(120), discoverable: z.boolean(), available: z.boolean(), advertiseBoost: z.boolean() }), response: z.object({ ok: z.boolean(), error: z.string().optional() }), async handler(ctx, args) { const auth = await authUser(ctx, args.sessionToken); if (!auth) return { ok: false, error: "Your session expired." }; const db = ctx.db<typeof schema>(); await db.update(schema.users).set({ notifyInvites: args.notifyInvites, notifyMessages: args.notifyMessages, notifyDeliverables: args.notifyDeliverables, preferredPlatforms: JSON.stringify(args.preferredPlatforms), preferredGenres: JSON.stringify(args.preferredGenres), preferredMoods: JSON.stringify(args.preferredMoods), defaultTerms: args.defaultTerms.trim(), turnaround: args.turnaround.trim(), discoverable: args.discoverable, available: args.available, advertiseBoost: args.advertiseBoost }).where(eq(schema.users.id, auth.id)); if (auth.role === "curator") await db.update(schema.curatorProfiles).set({ acceptingInvites: args.available, advertised: args.discoverable, ratesTerms: args.defaultTerms.trim(), updatedAt: new Date() }).where(eq(schema.curatorProfiles.userId, auth.id)); ctx.invalidateQueries(); return { ok: true }; } }),
  signOutAll: defineAction({ request: z.object({ sessionToken: z.string() }), response: z.object({ ok: z.boolean(), error: z.string().optional() }), async handler(ctx, args) { const auth = await authUser(ctx, args.sessionToken); if (!auth) return { ok: false, error: "Your session expired." }; await ctx.db<typeof schema>().delete(schema.userSessions).where(eq(schema.userSessions.userId, auth.id)); ctx.invalidateQueries(); return { ok: true }; } }),

  getSettings: defineAction({ request: z.object({ sessionToken: z.string() }), response: z.object({ ok: z.boolean(), settings: z.object({ emailUpdates: z.boolean(), matchAlerts: z.boolean() }).optional(), error: z.string().optional() }), async handler(ctx, args) { const user = await authUser(ctx, args.sessionToken); if (!user) return { ok: false, error: "Your session expired." }; const rows = await ctx.db<typeof schema>().select({ emailUpdates: schema.users.emailUpdates, matchAlerts: schema.users.matchAlerts }).from(schema.users).where(eq(schema.users.id, user.id)).limit(1); return rows[0] ? { ok: true, settings: rows[0] } : { ok: false, error: "Settings couldn't be loaded." }; } }),
  updateSettings: defineAction({ request: z.object({ sessionToken: z.string(), emailUpdates: z.boolean(), matchAlerts: z.boolean() }), response: z.object({ ok: z.boolean(), settings: z.object({ emailUpdates: z.boolean(), matchAlerts: z.boolean() }).optional(), error: z.string().optional() }), async handler(ctx, args) { const user = await authUser(ctx, args.sessionToken); if (!user) return { ok: false, error: "Your session expired." }; const settings = { emailUpdates: args.emailUpdates, matchAlerts: args.matchAlerts }; await ctx.db<typeof schema>().update(schema.users).set(settings).where(eq(schema.users.id, user.id)); ctx.invalidateQueries(); return { ok: true, settings }; } }),
  updateUsername: defineAction({ request: z.object({ sessionToken: z.string(), username: z.string().trim().min(3).max(30).regex(/^[a-zA-Z0-9._-]+$/) }), response: z.object({ ok: z.boolean(), username: z.string().optional(), error: z.string().optional() }), async handler(ctx, args) { const user = await authUser(ctx, args.sessionToken); if (!user) return { ok: false, error: "Your session expired." }; const username = args.username.trim(); await ctx.db<typeof schema>().update(schema.users).set({ username }).where(eq(schema.users.id, user.id)); ctx.invalidateQueries(); return { ok: true, username }; } }),

  getCuratorProfile: defineAction({ request: z.object({ sessionToken: z.string() }), response: z.object({ ok: z.boolean(), profile: curatorProfileSchema.optional(), error: z.string().optional() }), async handler(ctx, args) { const user = await authUser(ctx, args.sessionToken); if (!user || user.role !== "curator") return { ok: false, error: roleError("curator") }; const db = ctx.db<typeof schema>(); const rows = await db.select().from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, user.id)).limit(1); const accountRows = await db.select({ avatarBlobKey: schema.users.avatarBlobKey, username: schema.users.username, preferredGenres: schema.users.preferredGenres, preferredMoods: schema.users.preferredMoods }).from(schema.users).where(eq(schema.users.id, user.id)).limit(1); const account = accountRows[0]; const avatarUrl = account?.avatarBlobKey ? await ctx.blobs.getUrl(account.avatarBlobKey) : undefined; return { ok: true, profile: rows[0] ? profileFromRow(rows[0], { avatarUrl, username: account?.username, preferredGenres: account?.preferredGenres, preferredMoods: account?.preferredMoods }) : undefined }; } }),
  saveCuratorProfile: defineAction({ request: z.object({ sessionToken: z.string(), displayName: z.string().trim().min(2).max(60), bio: z.string().trim().max(500), platformStats: z.array(platformStatSchema).min(1).max(3), ratesTerms: z.string().trim().max(500), portfolioLinks: z.array(z.string().url().max(500)).max(6), acceptingInvites: z.boolean(), advertised: z.boolean() }), response: z.object({ ok: z.boolean(), profile: curatorProfileSchema.optional(), error: z.string().optional() }), async handler(ctx, args) { const user = await authUser(ctx, args.sessionToken); if (!user || user.role !== "curator") return { ok: false, error: roleError("curator") }; const db = ctx.db<typeof schema>(); const existing = await db.select({ id: schema.curatorProfiles.id, isDemo: schema.curatorProfiles.isDemo }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, user.id)).limit(1); const accountRows = await db.select({ preferredGenres: schema.users.preferredGenres, preferredMoods: schema.users.preferredMoods }).from(schema.users).where(eq(schema.users.id, user.id)).limit(1); const now = new Date(); const followerCount = args.platformStats.reduce((sum, item) => sum + item.followers, 0); const values = { displayName: args.displayName.trim(), bio: args.bio.trim(), platforms: args.platformStats.map((s) => s.platform).join(","), platformStats: JSON.stringify(args.platformStats.map((s) => JSON.stringify(s))), followerCount, ratesTerms: args.ratesTerms.trim(), portfolioLinks: JSON.stringify(args.portfolioLinks), acceptingInvites: args.acceptingInvites, advertised: args.advertised, updatedAt: now }; let id: number; if (existing[0]) { id = existing[0].id; await db.update(schema.curatorProfiles).set(values).where(eq(schema.curatorProfiles.id, id)); } else { const rows = await db.insert(schema.curatorProfiles).values({ userId: user.id, ...values, inviteCreditsResetAt: nextInviteReset(now), createdAt: now }).returning({ id: schema.curatorProfiles.id }); if (!rows[0]) return { ok: false, error: "Profile couldn't be saved." }; id = rows[0].id; } ctx.invalidateQueries(); return { ok: true, profile: { id, displayName: values.displayName, username: user.username, bio: values.bio, platformStats: args.platformStats, followerCount, ratesTerms: values.ratesTerms, genres: safeArray(accountRows[0]?.preferredGenres ?? "[]").filter((value): value is typeof GENRES[number] => GENRES.includes(value as typeof GENRES[number])), moods: safeArray(accountRows[0]?.preferredMoods ?? "[]").filter((value): value is typeof MOODS[number] => MOODS.includes(value as typeof MOODS[number])), portfolioLinks: args.portfolioLinks, acceptingInvites: args.acceptingInvites, advertised: args.advertised, isDemo: existing[0]?.isDemo ?? false, averageRating: null, reviewCount: 0, reviews: [] } }; } }),
  listCurators: defineAction({ request: z.object({ sessionToken: z.string(), query: z.string().max(80).optional() }), response: z.object({ ok: z.boolean(), curators: z.array(curatorProfileSchema), error: z.string().optional() }), async handler(ctx, args) { const user = await authUser(ctx, args.sessionToken); if (!user || user.role !== "artist") return { ok: false, curators: [], error: roleError("artist") }; const db = ctx.db<typeof schema>(); const rows = await db.select().from(schema.curatorProfiles).where(eq(schema.curatorProfiles.advertised, true)).orderBy(desc(schema.curatorProfiles.updatedAt)); const blockRows = await db.select({ blockerUserId: schema.userBlocks.blockerUserId, blockedUserId: schema.userBlocks.blockedUserId }).from(schema.userBlocks); const hiddenUserIds = new Set(blockRows.filter((block) => block.blockerUserId === user.id || block.blockedUserId === user.id).map((block) => block.blockerUserId === user.id ? block.blockedUserId : block.blockerUserId)); const visibleRows = (await Promise.all(rows.filter((row) => !hiddenUserIds.has(row.userId)).map(async (row) => ({ row, credits: await refreshInviteCredits(ctx, row.userId) })))).filter(({ credits }) => credits && (credits.remaining === null || credits.remaining > 0)).map(({ row }) => row); const profiles = await Promise.all(visibleRows.map(async (row) => { const accounts = await db.select({ avatarBlobKey: schema.users.avatarBlobKey, username: schema.users.username, preferredGenres: schema.users.preferredGenres, preferredMoods: schema.users.preferredMoods }).from(schema.users).where(eq(schema.users.id, row.userId)).limit(1); const account = accounts[0]; const avatarUrl = account?.avatarBlobKey ? await ctx.blobs.getUrl(account.avatarBlobKey) : undefined; return withCuratorReviews(ctx, row.userId, profileFromRow(row, { avatarUrl, username: account?.username, preferredGenres: account?.preferredGenres, preferredMoods: account?.preferredMoods })); })); const q = args.query?.trim().toLowerCase() ?? ""; return { ok: true, curators: profiles.filter((p) => !q || `${p.displayName} ${p.username} ${p.bio} ${p.genres.join(" ")} ${p.moods.join(" ")} ${p.platformStats.map((s) => s.platform).join(" ")}`.toLowerCase().includes(q)) }; } }),

  installRequestedDemoCurators: defineAction({ request: z.object({}), response: z.object({ ok: z.literal(true), installed: z.number() }), async handler(ctx): Promise<{ ok: true; installed: number }> { const db = ctx.db<typeof schema>(); const now = new Date(); const demos = [
    { key: "nightframe", displayName: "Mara Vale", username: "nightframe.edits", bio: "Cinematic night-drive edits, intimate performance cuts, and slow-burn storytelling for moody electronic and alt-pop releases.", platforms: [{ platform: "TikTok" as const, followers: 48200 }, { platform: "Instagram" as const, followers: 17600 }], genres: ["Electronic/Dance", "Pop", "Indie"], moods: ["Dark", "Dreamy", "Nostalgic"], terms: "$180 per vertical video · 3–5 day turnaround · one revision included", turnaround: "Usually available within 3–5 days" },
    { key: "loopculture", displayName: "Theo Park", username: "loopculture.lab", bio: "Fast, rhythm-led cuts built around hooks, movement, and repeatable formats for hip-hop, dance, and left-field pop.", platforms: [{ platform: "TikTok" as const, followers: 91300 }, { platform: "YouTube" as const, followers: 22400 }, { platform: "Instagram" as const, followers: 12800 }], genres: ["Hip-Hop", "Electronic/Dance", "Pop"], moods: ["Energetic", "Hype", "Playful"], terms: "$275 per concept + final cut · 5–7 day turnaround · usage terms agreed per campaign", turnaround: "Booking new work for the next 1–2 weeks" },
  ]; let installed = 0; for (const demo of demos) { const googleSub = `demo:curator:${demo.key}`; const existingUsers = await db.select().from(schema.users).where(eq(schema.users.googleSub, googleSub)).limit(1); let demoUserId = existingUsers[0]?.id; const userValues = { email: `${demo.key}@demo.sync.invalid`, name: demo.displayName, role: "curator" as const, username: demo.username, bio: demo.bio, preferredPlatforms: JSON.stringify(demo.platforms.map((item) => item.platform)), contentStyles: "[]", preferredGenres: JSON.stringify(demo.genres), preferredMoods: JSON.stringify(demo.moods), defaultTerms: demo.terms, turnaround: demo.turnaround, discoverable: true, available: true, advertiseBoost: false, lastSignInAt: now }; if (demoUserId) await db.update(schema.users).set(userValues).where(eq(schema.users.id, demoUserId)); else { const createdUsers = await db.insert(schema.users).values({ googleSub, ...userValues, createdAt: now }).returning({ id: schema.users.id }); demoUserId = createdUsers[0]?.id; } if (!demoUserId) continue; const existingProfiles = await db.select({ id: schema.curatorProfiles.id }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, demoUserId)).limit(1); const profileValues = { displayName: demo.displayName, bio: demo.bio, platforms: demo.platforms.map((item) => item.platform).join(","), platformStats: JSON.stringify(demo.platforms.map((item) => JSON.stringify(item))), followerCount: demo.platforms.reduce((sum, item) => sum + item.followers, 0), ratesTerms: demo.terms, portfolioLinks: "[]", acceptingInvites: true, advertised: true, isDemo: true, invitePlan: "starter" as const, inviteCreditsRemaining: 5, inviteCreditsResetAt: nextInviteReset(now), updatedAt: now }; if (existingProfiles[0]) await db.update(schema.curatorProfiles).set(profileValues).where(eq(schema.curatorProfiles.id, existingProfiles[0].id)); else await db.insert(schema.curatorProfiles).values({ userId: demoUserId, ...profileValues, createdAt: now }); installed += 1; } ctx.invalidateQueries(); return { ok: true, installed }; } }),

  sendCampaignInvite: defineAction({
    request: z.object({ sessionToken: z.string(), campaignId: z.number().int().positive(), curatorProfileId: z.number().int().positive() }),
    response: z.object({ ok: z.boolean(), invite: inviteSchema.optional(), error: z.string().optional() }),
    async handler(ctx, args) {
      const user = await authUser(ctx, args.sessionToken);
      if (!user || user.role !== "artist") return { ok: false, error: roleError("artist") };
      const db = ctx.db<typeof schema>();
      const campaign = (await db.select().from(schema.campaigns).where(and(eq(schema.campaigns.id, args.campaignId), eq(schema.campaigns.userId, user.id))).limit(1))[0];
      const curator = (await db.select().from(schema.curatorProfiles).where(and(eq(schema.curatorProfiles.id, args.curatorProfileId), eq(schema.curatorProfiles.advertised, true))).limit(1))[0];
      if (!campaign || !curator?.acceptingInvites) return { ok: false, error: "That campaign or curator isn't available." };
      if (await usersBlocked(ctx, user.id, curator.userId)) return { ok: false, error: "Invitations are unavailable between blocked accounts." };
      const duplicates = await db.select({ id: schema.collaborations.id, status: schema.collaborations.status }).from(schema.collaborations).where(and(eq(schema.collaborations.campaignId, campaign.id), eq(schema.collaborations.curatorUserId, curator.userId)));
      if (duplicates.some((item) => item.status === "invited" || item.status === "accepted" || item.status === "resolve_pending")) return { ok: false, error: "This curator already has a pending or active collaboration in that campaign." };
      const credits = await refreshInviteCredits(ctx, curator.userId);
      if (!credits || (credits.remaining !== null && credits.remaining <= 0)) return { ok: false, error: "This curator has reached their monthly invite limit." };
      const now = new Date();
      try {
        const invite = (await db.insert(schema.collaborations).values({ campaignId: campaign.id, curatorUserId: curator.userId, status: "invited", createdAt: now, updatedAt: now }).returning())[0];
        if (!invite) return { ok: false, error: "Invite couldn't be sent." };
        const notificationUserId = curator.isDemo ? campaign.userId : curator.userId;
        await notify(ctx, { userId: notificationUserId, recipientRole: "curator", kind: "invite_received", title: "New campaign invite", body: campaign.title, inviteId: invite.id, campaignId: campaign.id, createdAt: now });
        ctx.invalidateQueries();
        return { ok: true, invite: (await invitePayload(ctx, invite)) ?? undefined };
      } catch { return { ok: false, error: "Invite couldn't be sent right now." }; }
    }
  }),
  listCampaignInvites: defineAction({ request: z.object({ sessionToken: z.string(), campaignId: z.number().int().positive() }), response: z.object({ ok: z.boolean(), invites: z.array(inviteSchema), error: z.string().optional() }), async handler(ctx, args) { const user = await authUser(ctx, args.sessionToken); if (!user || user.role !== "artist") return { ok: false, invites: [], error: roleError("artist") }; const db = ctx.db<typeof schema>(); const campaigns = await db.select().from(schema.campaigns).where(and(eq(schema.campaigns.id, args.campaignId), eq(schema.campaigns.userId, user.id))).limit(1); if (!campaigns[0]) return { ok: false, invites: [], error: "Campaign isn't available." }; const rows = await db.select().from(schema.collaborations).where(eq(schema.collaborations.campaignId, args.campaignId)).orderBy(desc(schema.collaborations.createdAt)); const payloads = await Promise.all(rows.map((r) => invitePayload(ctx, r))); return { ok: true, invites: payloads.filter((v): v is NonNullable<typeof v> => v !== null) }; } }),
  listCuratorInvites: defineAction({ request: z.object({ sessionToken: z.string() }), response: z.object({ ok: z.boolean(), invites: z.array(inviteSchema), credits: inviteCreditSchema.optional(), error: z.string().optional() }), async handler(ctx, args) { const user = await authUser(ctx, args.sessionToken); if (!user || user.role !== "curator") return { ok: false, invites: [], error: roleError("curator") }; const db = ctx.db<typeof schema>(); const allRows = await db.select().from(schema.collaborations).orderBy(desc(schema.collaborations.createdAt)); const demoProfiles = await db.select({ userId: schema.curatorProfiles.userId }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.isDemo, true)); const demoUserIds = new Set(demoProfiles.map((profile) => profile.userId)); const ownedCampaigns = await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(eq(schema.campaigns.userId, user.id)); const ownedCampaignIds = new Set(ownedCampaigns.map((campaign) => campaign.id)); const rows = allRows.filter((row) => row.curatorUserId === user.id || (demoUserIds.has(row.curatorUserId) && ownedCampaignIds.has(row.campaignId))); const payloads = await Promise.all(rows.map((r) => invitePayload(ctx, r))); const credits = await refreshInviteCredits(ctx, user.id); return { ok: true, invites: payloads.filter((v): v is NonNullable<typeof v> => v !== null), credits: credits ?? undefined }; } }),
  updateInviteStatus: defineAction({
    request: z.object({ sessionToken: z.string(), inviteId: z.number().int().positive(), status: z.enum(["accepted", "declined"]) }),
    response: z.object({ ok: z.boolean(), status: inviteStatusSchema.optional(), credits: inviteCreditSchema.optional(), error: z.string().optional() }),
    async handler(ctx, args) {
      const user = await authUser(ctx, args.sessionToken);
      if (!user) return { ok: false, error: "Your session expired." };
      const db = ctx.db<typeof schema>();
      const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, args.inviteId)).limit(1))[0];
      if (!invite) return { ok: false, error: "Invite isn't available." };
      const campaign = (await db.select({ userId: schema.campaigns.userId, title: schema.campaigns.title }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0];
      const demoProfile = (await db.select({ isDemo: schema.curatorProfiles.isDemo }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, invite.curatorUserId)).limit(1))[0];
      const canTestDemoInvite = demoProfile?.isDemo === true && campaign?.userId === user.id;
      const now = new Date();
      if (user.role !== "curator" || (invite.curatorUserId !== user.id && !canTestDemoInvite) || invite.status !== "invited") return { ok: false, error: "Invite can't be updated." };
      if (!campaign) return { ok: false, error: "Campaign isn't available." };
      if (await usersBlocked(ctx, campaign.userId, invite.curatorUserId)) return { ok: false, error: "This invite can no longer be accepted because one account blocked the other." };
      if (args.status === "accepted") await refreshInviteCredits(ctx, invite.curatorUserId);
      try {
        const updated = await db.update(schema.collaborations).set({ status: args.status, updatedAt: now, acceptedAt: args.status === "accepted" ? now : invite.acceptedAt }).where(and(eq(schema.collaborations.id, invite.id), eq(schema.collaborations.status, "invited"))).returning({ status: schema.collaborations.status });
        if (!updated[0]) return { ok: false, error: "Invite can't be updated." };
      } catch (error) {
        if (args.status === "accepted" && error instanceof Error && error.message.includes("invite credits exhausted")) return { ok: false, error: "You've used all of this month's invite credits. Your credits will reset next month." };
        return { ok: false, error: "Invite couldn't be updated right now." };
      }
      if (args.status === "accepted") { try { await db.insert(schema.collaborationWorkspaces).values({ inviteId: invite.id, updatedAt: now }); } catch { /* already exists */ } }
      await notify(ctx, { userId: campaign.userId, recipientRole: "artist", kind: args.status === "accepted" ? "invite_accepted" : "invite_declined", title: args.status === "accepted" ? "Invite accepted" : "Invite declined", body: campaign.title, inviteId: invite.id, campaignId: invite.campaignId, createdAt: now });
      const credits = await refreshInviteCredits(ctx, invite.curatorUserId);
      ctx.invalidateQueries();
      return { ok: true, status: args.status, credits: credits ?? undefined };
    }
  }),
  requestResolve: defineAction({
    request: z.object({ sessionToken: z.string(), inviteId: z.number().int().positive(), previewAs: roleSchema.optional() }),
    response: z.object({ ok: z.boolean(), status: inviteStatusSchema.optional(), requestedByRole: roleSchema.optional(), requestedAt: z.string().optional(), error: z.string().optional() }),
    async handler(ctx, args) {
      await expireResolveRequests(ctx);
      const user = await authUser(ctx, args.sessionToken);
      if (!user) return { ok: false, error: "Your session expired." };
      const db = ctx.db<typeof schema>();
      const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, args.inviteId)).limit(1))[0];
      if (!invite) return { ok: false, error: "Collaboration isn't available." };
      const campaign = (await db.select({ userId: schema.campaigns.userId, title: schema.campaigns.title }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0];
      const demoProfile = (await db.select({ isDemo: schema.curatorProfiles.isDemo }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, invite.curatorUserId)).limit(1))[0];
      const usesDemoCuratorProxy = demoProfile?.isDemo === true && campaign?.userId === user.id;
      const testingPreviewEnabled = campaign?.userId === invite.curatorUserId || usesDemoCuratorProxy;
      if (args.previewAs && !testingPreviewEnabled) return { ok: false, error: "Preview as is only available for a one-account testing workspace." };
      const actingRole: Role = args.previewAs ?? user.role;
      const canTestAsDemoCurator = actingRole === "curator" && usesDemoCuratorProxy;
      const isParticipant = actingRole === "artist" ? campaign?.userId === user.id : invite.curatorUserId === user.id || canTestAsDemoCurator;
      if (!isParticipant || !campaign || invite.status !== "accepted") return { ok: false, error: "Only a participant can request resolution for an accepted collaboration." };
      const now = new Date();
      // Demo curator collaborations are operated by the campaign owner through the temporary testing preview.
      // Route curator-side notifications back to that real account and preserve their recipient role.
      const recipientUserId = actingRole === "artist" && usesDemoCuratorProxy ? campaign.userId : actingRole === "artist" ? invite.curatorUserId : campaign.userId;
      await db.batch([
        db.update(schema.collaborations).set({ status: "resolve_pending", resolveRequestedByRole: actingRole, resolveRequestedAt: now, updatedAt: now }).where(and(eq(schema.collaborations.id, args.inviteId), eq(schema.collaborations.status, "accepted"))),
        db.insert(schema.collaborationTimelineEvents).values({ inviteId: invite.id, eventType: "resolve_requested", label: `Resolve requested by ${actingRole}`, detail: "Auto-resolves after 7 days without a response.", createdAt: now }),
        db.insert(schema.notifications).values({ userId: recipientUserId, recipientRole: actingRole === "artist" ? "curator" : "artist", kind: "resolve_requested", title: "Resolve requested", body: campaign.title, inviteId: invite.id, campaignId: invite.campaignId, createdAt: now }),
      ]);
      ctx.invalidateQueries();
      return { ok: true, status: "resolve_pending" as const, requestedByRole: actingRole, requestedAt: now.toISOString() };
    }
  }),
  cancelResolveRequest: defineAction({
    request: z.object({ sessionToken: z.string(), inviteId: z.number().int().positive(), previewAs: roleSchema.optional() }), response: z.object({ ok: z.boolean(), status: inviteStatusSchema.optional(), error: z.string().optional() }),
    async handler(ctx, args) {
      await expireResolveRequests(ctx);
      const user = await authUser(ctx, args.sessionToken); if (!user) return { ok: false, error: "Your session expired." };
      const db = ctx.db<typeof schema>(); const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, args.inviteId)).limit(1))[0]; if (!invite) return { ok: false, error: "Collaboration isn't available." };
      const campaign = (await db.select({ userId: schema.campaigns.userId }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0];
      const curatorProfile = (await db.select({ isDemo: schema.curatorProfiles.isDemo }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, invite.curatorUserId)).limit(1))[0];
      const usesDemoCuratorProxy = curatorProfile?.isDemo === true && campaign?.userId === user.id;
      const testingPreviewEnabled = campaign?.userId === invite.curatorUserId || usesDemoCuratorProxy;
      if (args.previewAs && !testingPreviewEnabled) return { ok: false, error: "Preview as is only available for a one-account testing workspace." };
      const actingRole: Role = args.previewAs ?? user.role;
      const isParticipant = actingRole === "artist" ? campaign?.userId === user.id : invite.curatorUserId === user.id || (actingRole === "curator" && usesDemoCuratorProxy);
      if (!isParticipant || invite.status !== "resolve_pending" || invite.resolveRequestedByRole !== actingRole) return { ok: false, error: "Only the requester can cancel this resolve request." };
      const now = new Date();
      await db.batch([
        db.update(schema.collaborations).set({ status: "accepted", resolveRequestedByRole: null, resolveRequestedAt: null, updatedAt: now }).where(and(eq(schema.collaborations.id, args.inviteId), eq(schema.collaborations.status, "resolve_pending"))),
        db.insert(schema.collaborationTimelineEvents).values({ inviteId: invite.id, eventType: "resolve_cancelled", label: "Resolve request cancelled", createdAt: now }),
      ]);
      ctx.invalidateQueries(); return { ok: true, status: "accepted" as const };
    }
  }),
  confirmResolve: defineAction({
    request: z.object({ sessionToken: z.string(), inviteId: z.number().int().positive(), previewAs: roleSchema.optional() }), response: z.object({ ok: z.boolean(), status: inviteStatusSchema.optional(), liveAt: z.string().optional(), error: z.string().optional() }),
    async handler(ctx, args) {
      await expireResolveRequests(ctx);
      const user = await authUser(ctx, args.sessionToken); if (!user) return { ok: false, error: "Your session expired." };
      const db = ctx.db<typeof schema>(); const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, args.inviteId)).limit(1))[0]; if (!invite) return { ok: false, error: "Collaboration isn't available." };
      const campaign = (await db.select({ userId: schema.campaigns.userId, title: schema.campaigns.title }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0];
      const curatorProfile = (await db.select({ isDemo: schema.curatorProfiles.isDemo }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, invite.curatorUserId)).limit(1))[0];
      const usesDemoCuratorProxy = curatorProfile?.isDemo === true && campaign?.userId === user.id;
      const testingPreviewEnabled = campaign?.userId === invite.curatorUserId || usesDemoCuratorProxy;
      if (args.previewAs && !testingPreviewEnabled) return { ok: false, error: "Preview as is only available for a one-account testing workspace." };
      const actingRole: Role = args.previewAs ?? user.role;
      const canTestAsDemoCurator = actingRole === "curator" && usesDemoCuratorProxy;
      const isParticipant = actingRole === "artist" ? campaign?.userId === user.id : invite.curatorUserId === user.id || canTestAsDemoCurator;
      if (!isParticipant || !campaign || invite.status !== "resolve_pending" || !invite.resolveRequestedByRole || invite.resolveRequestedByRole === actingRole) return { ok: false, error: "Only the other participant can confirm this resolve request." };
      const now = new Date();
      // In the temporary one-account demo flow, the campaign owner operates both sides through
      // Preview as. Keep the notification on that account, scoped to the requester's logical role.
      const requesterUserId = invite.resolveRequestedByRole === "artist" ? campaign.userId : usesDemoCuratorProxy ? campaign.userId : invite.curatorUserId;
      await db.batch([
        db.update(schema.collaborations).set({ status: "content_live", liveAt: now, resolveRequestedByRole: null, resolveRequestedAt: null, updatedAt: now }).where(and(eq(schema.collaborations.id, args.inviteId), eq(schema.collaborations.status, "resolve_pending"))),
        db.insert(schema.collaborationTimelineEvents).values({ inviteId: invite.id, eventType: "resolve_confirmed", label: "Resolve confirmed · collaboration resolved", createdAt: now }),
      ]);
      await notify(ctx, { userId: requesterUserId, recipientRole: invite.resolveRequestedByRole, kind: "resolve_confirmed", title: "Collaboration resolved", body: campaign.title, inviteId: invite.id, campaignId: invite.campaignId, createdAt: now });
      ctx.invalidateQueries(); return { ok: true, status: "content_live" as const, liveAt: now.toISOString() };
    }
  }),

  getWorkspace: defineAction({
    request: z.object({ sessionToken: z.string(), inviteId: z.number().int().positive() }),
    response: z.object({ ok: z.boolean(), workspace: workspaceSchema.optional(), error: z.string().optional() }),
    async handler(ctx, args) {
      await expireResolveRequests(ctx);
      const user = await authUser(ctx, args.sessionToken);
      if (!user) return { ok: false, error: "Your session expired." };
      const db = ctx.db<typeof schema>();
      const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, args.inviteId)).limit(1))[0];
      if (!invite || (invite.status !== "accepted" && invite.status !== "resolve_pending" && invite.status !== "content_live")) return { ok: false, error: "Messaging opens after the curator accepts the invite." };
      const campaign = (await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0];
      if (!campaign || (user.id !== campaign.userId && user.id !== invite.curatorUserId)) return { ok: false, error: "Workspace isn't available." };
      const workspace = (await db.select().from(schema.collaborationWorkspaces).where(eq(schema.collaborationWorkspaces.inviteId, invite.id)).limit(1))[0];
      if (!workspace) return { ok: false, error: "Workspace is still being prepared." };
      const curatorName = (await db.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.id, invite.curatorUserId)).limit(1))[0]?.username ?? `curator-${invite.curatorUserId}`;
      const demoProfile = (await db.select({ isDemo: schema.curatorProfiles.isDemo }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, invite.curatorUserId)).limit(1))[0];
      const testingPreviewEnabled = campaign.userId === invite.curatorUserId || (demoProfile?.isDemo === true && campaign.userId === user.id);
      const artistName = (await db.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.id, campaign.userId)).limit(1))[0]?.username ?? `artist-${campaign.userId}`;
      const partnerUserId = user.id === campaign.userId ? invite.curatorUserId : campaign.userId;
      const blockRows = await db.select().from(schema.userBlocks);
      const block = blockRows.find((row) => (row.blockerUserId === user.id && row.blockedUserId === partnerUserId) || (row.blockerUserId === partnerUserId && row.blockedUserId === user.id));
      const messageRows = await db.select().from(schema.collaborationMessages).where(eq(schema.collaborationMessages.inviteId, invite.id)).orderBy(asc(schema.collaborationMessages.createdAt));
      const deliverableEvents = await db.select().from(schema.collaborationDeliverableEvents).where(eq(schema.collaborationDeliverableEvents.inviteId, invite.id)).orderBy(asc(schema.collaborationDeliverableEvents.createdAt));
      const resolveEvents = await db.select().from(schema.collaborationTimelineEvents).where(eq(schema.collaborationTimelineEvents.inviteId, invite.id)).orderBy(asc(schema.collaborationTimelineEvents.createdAt));
      const timeline: Array<{ label: string; detail?: string; at: string }> = [{ label: "Invite sent", at: invite.createdAt.toISOString() }];
      if (invite.acceptedAt) timeline.push({ label: "Collaboration accepted", at: invite.acceptedAt.toISOString() });
      timeline.push(...deliverableEvents.map((event) => ({ label: event.label, detail: event.detail || undefined, at: event.createdAt.toISOString() })));
      timeline.push(...resolveEvents.map((event) => ({ label: event.label, detail: event.detail || undefined, at: event.createdAt.toISOString() })));
      if (invite.resolveRequestedAt && invite.resolveRequestedByRole && !resolveEvents.some((event) => event.eventType === "resolve_requested")) timeline.push({ label: `Resolve requested by ${invite.resolveRequestedByRole}`, at: invite.resolveRequestedAt.toISOString() });
      if (invite.liveAt && !resolveEvents.some((event) => event.eventType === "resolve_confirmed" || event.eventType === "resolve_expired")) timeline.push({ label: "Collaboration resolved", at: invite.liveAt.toISOString() });
      timeline.sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime());
      const draftUrl = workspace.draftBlobKey ? await ctx.blobs.getUrl(workspace.draftBlobKey) : undefined;
      const reviewRows = await db.select().from(schema.collaborationReviews).where(eq(schema.collaborationReviews.inviteId, invite.id));
      const mine = reviewRows.find((row) => row.reviewerUserId === user.id);
      const received = reviewRows.find((row) => row.targetUserId === user.id);
      return { ok: true, workspace: {
        inviteId: invite.id, campaignTitle: campaign.title, partnerUsername: user.role === "artist" ? curatorName : artistName, currentRole: user.role,
        testingPreviewEnabled, status: invite.status, resolveRequestedByRole: invite.resolveRequestedByRole ?? undefined, resolveRequestedAt: invite.resolveRequestedAt?.toISOString(), resolveExpiresAt: invite.resolveRequestedAt ? new Date(invite.resolveRequestedAt.getTime() + RESOLVE_EXPIRY_MS).toISOString() : undefined,
        blocked: Boolean(block), blockedByMe: block?.blockerUserId === user.id,
        draftReady: workspace.draftReady, revisionsComplete: workspace.revisionsComplete, postedLive: workspace.postedLive, liveLink: workspace.liveLink,
        deliverableStage: workspace.deliverableStage, draftUrl, draftFilename: workspace.draftFilename ?? undefined, draftMimeType: workspace.draftMimeType ?? undefined,
        revisionRoundsUsed: Math.min(2, workspace.revisionRoundsUsed), revisionRoundsRemaining: Math.max(0, 2 - workspace.revisionRoundsUsed),
        myReview: mine ? { rating: mine.rating, body: mine.body, updatedAt: mine.updatedAt.toISOString() } : undefined,
        receivedReview: received ? { rating: received.rating, body: received.body, updatedAt: received.updatedAt.toISOString() } : undefined,
        messages: messageRows.map((message) => { const senderRole: Role = message.senderRole ?? (message.senderUserId === campaign.userId ? "artist" : "curator"); return { id: message.id, senderUsername: senderRole === "artist" ? artistName : curatorName, senderRole, mine: message.senderUserId === user.id, body: message.body, createdAt: message.createdAt.toISOString() }; }),
        timeline,
      } };
    }
  }),
  sendMessage: defineAction({
    request: z.object({ sessionToken: z.string(), inviteId: z.number().int().positive(), body: z.string().trim().min(1).max(2000), previewAs: roleSchema.optional() }),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
    async handler(ctx, args) {
      await expireResolveRequests(ctx);
      const user = await authUser(ctx, args.sessionToken); if (!user) return { ok: false, error: "Your session expired." };
      const db = ctx.db<typeof schema>(); const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, args.inviteId)).limit(1))[0]; if (!invite) return { ok: false, error: "Workspace isn't available." };
      if (invite.status === "content_live") return { ok: false, error: "This collaboration is resolved. Its message history is read-only." };
      if (invite.status !== "accepted" && invite.status !== "resolve_pending") return { ok: false, error: "Messaging opens after acceptance." };
      const campaign = (await db.select({ userId: schema.campaigns.userId, title: schema.campaigns.title }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0];
      if (!campaign || (user.id !== invite.curatorUserId && user.id !== campaign.userId)) return { ok: false, error: "Workspace isn't available." };
      if (await usersBlocked(ctx, campaign.userId, invite.curatorUserId)) return { ok: false, error: "Messaging is frozen because one participant blocked the other. Resolve remains available." };
      const demoProfile = (await db.select({ isDemo: schema.curatorProfiles.isDemo }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, invite.curatorUserId)).limit(1))[0];
      const testingPreviewEnabled = campaign.userId === invite.curatorUserId || (demoProfile?.isDemo === true && campaign.userId === user.id);
      if (args.previewAs && !testingPreviewEnabled) return { ok: false, error: "Preview as is only available for a one-account testing workspace." };
      const senderRole: Role = args.previewAs ?? user.role; const senderUserId = senderRole === "artist" ? campaign.userId : invite.curatorUserId;
      const targetUserId = senderRole === "artist" ? invite.curatorUserId : campaign.userId;
      const notificationUserId = senderRole === "artist" && demoProfile?.isDemo ? campaign.userId : targetUserId;
      const now = new Date();
      await db.insert(schema.collaborationMessages).values({ inviteId: args.inviteId, senderUserId, senderRole, body: args.body.trim(), createdAt: now });
      if (targetUserId !== senderUserId) await notify(ctx, { userId: notificationUserId, recipientRole: senderRole === "artist" ? "curator" : "artist", kind: "message_received", title: "New workspace message", body: campaign.title, inviteId: invite.id, campaignId: invite.campaignId, createdAt: now });
      ctx.invalidateQueries(); return { ok: true };
    }
  }),
  initDraftUpload: defineAction({
    request: z.object({ sessionToken: z.string(), inviteId: z.number().int().positive(), mimeType: z.enum(["video/mp4", "video/webm", "video/quicktime"]), filename: z.string().trim().min(1).max(180), totalBytes: z.number().int().positive().max(MAX_DRAFT_VIDEO_BYTES), totalChunks: z.number().int().positive().max(Math.ceil(MAX_DRAFT_VIDEO_BYTES / DRAFT_UPLOAD_CHUNK_BYTES)), previewAs: roleSchema.optional() }),
    response: z.object({ ok: z.boolean(), uploadId: z.string().optional(), chunkBytes: z.number().int().positive().optional(), receivedChunks: z.array(z.number().int().nonnegative()).optional(), error: z.string().optional() }),
    async handler(ctx, args) {
      const user = await authUser(ctx, args.sessionToken);
      if (!user) return { ok: false, error: "Your session expired." };
      if (args.totalBytes > MAX_DRAFT_VIDEO_BYTES) return { ok: false, error: "Choose a video no larger than 500 MB." };
      if (args.totalChunks !== Math.ceil(args.totalBytes / DRAFT_UPLOAD_CHUNK_BYTES)) return { ok: false, error: "The upload could not be initialized. Choose the file again." };
      const db = ctx.db<typeof schema>();
      const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, args.inviteId)).limit(1))[0];
      if (!invite) return { ok: false, error: "This collaboration is not available." };
      const campaign = (await db.select({ userId: schema.campaigns.userId }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0];
      const demoProfile = (await db.select({ isDemo: schema.curatorProfiles.isDemo }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, invite.curatorUserId)).limit(1))[0];
      const usesDemoCuratorProxy = demoProfile?.isDemo === true && campaign?.userId === user.id;
      const testingPreviewEnabled = campaign?.userId === invite.curatorUserId || usesDemoCuratorProxy;
      if (args.previewAs && !testingPreviewEnabled) return { ok: false, error: "Preview as is only available for a one-account testing workspace." };
      const actingRole: Role = args.previewAs ?? user.role;
      if (actingRole !== "curator" || (invite.curatorUserId !== user.id && !usesDemoCuratorProxy) || invite.status !== "accepted") return { ok: false, error: "Only the curator can upload a draft for an active collaboration." };
      const workspace = (await db.select().from(schema.collaborationWorkspaces).where(eq(schema.collaborationWorkspaces.inviteId, invite.id)).limit(1))[0];
      if (!workspace || (workspace.deliverableStage !== "waiting_draft" && workspace.deliverableStage !== "changes_requested")) return { ok: false, error: "This draft is not waiting for an upload." };
      const sessions = await db.select().from(schema.draftUploadSessions).where(and(eq(schema.draftUploadSessions.inviteId, invite.id), eq(schema.draftUploadSessions.curatorUserId, user.id)));
      const existing = sessions.find((session) => session.filename === args.filename.trim() && session.mimeType === args.mimeType && session.totalBytes === args.totalBytes && session.totalChunks === args.totalChunks);
      if (existing) {
        const chunks = await db.select({ chunkIndex: schema.draftUploadChunks.chunkIndex }).from(schema.draftUploadChunks).where(eq(schema.draftUploadChunks.uploadId, existing.id)).orderBy(asc(schema.draftUploadChunks.chunkIndex));
        return { ok: true, uploadId: existing.id, chunkBytes: DRAFT_UPLOAD_CHUNK_BYTES, receivedChunks: chunks.map((chunk) => chunk.chunkIndex) };
      }
      if (sessions.length) await db.delete(schema.draftUploadSessions).where(and(eq(schema.draftUploadSessions.inviteId, invite.id), eq(schema.draftUploadSessions.curatorUserId, user.id)));
      const uploadId = crypto.randomUUID();
      const now = new Date();
      await db.insert(schema.draftUploadSessions).values({ id: uploadId, inviteId: invite.id, curatorUserId: user.id, filename: args.filename.trim(), mimeType: args.mimeType, totalBytes: args.totalBytes, totalChunks: args.totalChunks, createdAt: now, updatedAt: now });
      return { ok: true, uploadId, chunkBytes: DRAFT_UPLOAD_CHUNK_BYTES, receivedChunks: [] };
    }
  }),
  uploadDraftChunk: defineAction({
    request: z.object({ sessionToken: z.string(), uploadId: z.string().uuid(), chunkIndex: z.number().int().nonnegative(), chunkBase64: z.string().min(1).max(3_500_000), previewAs: roleSchema.optional() }),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
    async handler(ctx, args) {
      const user = await authUser(ctx, args.sessionToken);
      if (!user) return { ok: false, error: "Your session expired." };
      const db = ctx.db<typeof schema>();
      const session = (await db.select().from(schema.draftUploadSessions).where(eq(schema.draftUploadSessions.id, args.uploadId)).limit(1))[0];
      if (!session || session.curatorUserId !== user.id) return { ok: false, error: "This upload session is not available." };
      const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, session.inviteId)).limit(1))[0];
      if (!invite) return { ok: false, error: "This collaboration is not available." };
      const campaign = (await db.select({ userId: schema.campaigns.userId }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0];
      const demoProfile = (await db.select({ isDemo: schema.curatorProfiles.isDemo }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, invite.curatorUserId)).limit(1))[0];
      const usesDemoCuratorProxy = demoProfile?.isDemo === true && campaign?.userId === user.id;
      const testingPreviewEnabled = campaign?.userId === invite.curatorUserId || usesDemoCuratorProxy;
      if (args.previewAs && !testingPreviewEnabled) return { ok: false, error: "Preview as is only available for a one-account testing workspace." };
      const actingRole: Role = args.previewAs ?? user.role;
      if (actingRole !== "curator" || (invite.curatorUserId !== user.id && !usesDemoCuratorProxy) || invite.status !== "accepted") return { ok: false, error: "Only the curator can upload a draft for an active collaboration." };
      if (args.chunkIndex >= session.totalChunks) return { ok: false, error: "This video chunk is outside the upload range." };
      const bytes = Buffer.from(args.chunkBase64, "base64");
      const expectedBytes = args.chunkIndex === session.totalChunks - 1 ? session.totalBytes - (args.chunkIndex * DRAFT_UPLOAD_CHUNK_BYTES) : DRAFT_UPLOAD_CHUNK_BYTES;
      if (!bytes.byteLength || bytes.byteLength !== expectedBytes || bytes.byteLength > DRAFT_UPLOAD_CHUNK_BYTES) return { ok: false, error: "A video chunk was incomplete. The upload can be retried." };
      const existing = (await db.select({ id: schema.draftUploadChunks.id, byteLength: schema.draftUploadChunks.byteLength }).from(schema.draftUploadChunks).where(and(eq(schema.draftUploadChunks.uploadId, session.id), eq(schema.draftUploadChunks.chunkIndex, args.chunkIndex))).limit(1))[0];
      if (!existing) {
        await ctx.blobs.put(`upload-chunks/${session.id}/${args.chunkIndex}`, bytes, { contentType: "application/octet-stream" });
        await db.insert(schema.draftUploadChunks).values({ uploadId: session.id, chunkIndex: args.chunkIndex, byteLength: bytes.byteLength, bytes: Buffer.alloc(0) });
      } else if (existing.byteLength !== bytes.byteLength) return { ok: false, error: "A previously uploaded chunk does not match this file. Choose the file again." };
      await db.update(schema.draftUploadSessions).set({ updatedAt: new Date() }).where(eq(schema.draftUploadSessions.id, session.id));
      return { ok: true };
    }
  }),
  finalizeDraftUpload: defineAction({
    request: z.object({ sessionToken: z.string(), uploadId: z.string().uuid(), previewAs: roleSchema.optional() }),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
    async handler(ctx, args) {
      const user = await authUser(ctx, args.sessionToken);
      if (!user) return { ok: false, error: "Your session expired." };
      const db = ctx.db<typeof schema>();
      const session = (await db.select().from(schema.draftUploadSessions).where(eq(schema.draftUploadSessions.id, args.uploadId)).limit(1))[0];
      if (!session || session.curatorUserId !== user.id) return { ok: false, error: "This upload session is not available." };
      const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, session.inviteId)).limit(1))[0];
      if (!invite) return { ok: false, error: "This collaboration is not available." };
      const campaignForAccess = (await db.select({ userId: schema.campaigns.userId }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0];
      const demoProfile = (await db.select({ isDemo: schema.curatorProfiles.isDemo }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.userId, invite.curatorUserId)).limit(1))[0];
      const usesDemoCuratorProxy = demoProfile?.isDemo === true && campaignForAccess?.userId === user.id;
      const testingPreviewEnabled = campaignForAccess?.userId === invite.curatorUserId || usesDemoCuratorProxy;
      if (args.previewAs && !testingPreviewEnabled) return { ok: false, error: "Preview as is only available for a one-account testing workspace." };
      const actingRole: Role = args.previewAs ?? user.role;
      if (actingRole !== "curator" || (invite.curatorUserId !== user.id && !usesDemoCuratorProxy) || invite.status !== "accepted") return { ok: false, error: "Only the curator can upload a draft for an active collaboration." };
      const workspace = (await db.select().from(schema.collaborationWorkspaces).where(eq(schema.collaborationWorkspaces.inviteId, invite.id)).limit(1))[0];
      if (!workspace || (workspace.deliverableStage !== "waiting_draft" && workspace.deliverableStage !== "changes_requested")) return { ok: false, error: "This draft is not waiting for an upload." };
      const chunks = await db.select().from(schema.draftUploadChunks).where(eq(schema.draftUploadChunks.uploadId, session.id)).orderBy(asc(schema.draftUploadChunks.chunkIndex));
      const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      if (chunks.length !== session.totalChunks || totalBytes !== session.totalBytes || chunks.some((chunk, index) => chunk.chunkIndex !== index)) return { ok: false, error: "The upload is incomplete. Retry the missing parts and finish again." };
      const chunkBuffers = await Promise.all(chunks.map((chunk) => ctx.blobs.get(`upload-chunks/${session.id}/${chunk.chunkIndex}`)));
      if (chunkBuffers.some((chunk, index) => chunk.byteLength !== chunks[index]?.byteLength)) return { ok: false, error: "The upload is incomplete. Retry the missing parts and finish again." };
      const bytes = Buffer.concat(chunkBuffers, session.totalBytes);
      const key = `deliverables/${invite.id}/${crypto.randomUUID()}`;
      await ctx.blobs.put(key, bytes, { contentType: session.mimeType });
      const now = new Date();
      const isReupload = workspace.draftBlobKey !== null || workspace.revisionRoundsUsed > 0;
      await db.batch([
        db.update(schema.collaborationWorkspaces).set({ draftReady: true, revisionsComplete: false, deliverableStage: "awaiting_review", draftBlobKey: key, draftMimeType: session.mimeType, draftFilename: session.filename, updatedAt: now }).where(eq(schema.collaborationWorkspaces.inviteId, invite.id)),
        db.insert(schema.collaborationDeliverableEvents).values({ inviteId: invite.id, eventType: isReupload ? "draft_reuploaded" : "draft_uploaded", label: isReupload ? "Draft re-uploaded" : "Draft uploaded", createdAt: now }),
        db.delete(schema.draftUploadSessions).where(eq(schema.draftUploadSessions.id, session.id)),
      ]);
      await Promise.all(chunks.map((chunk) => ctx.blobs.delete(`upload-chunks/${session.id}/${chunk.chunkIndex}`).catch(() => undefined)));
      if (workspace.draftBlobKey) await ctx.blobs.delete(workspace.draftBlobKey).catch(() => undefined);
      const campaign = (await db.select({ userId: schema.campaigns.userId, title: schema.campaigns.title }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0];
      if (campaign) await notify(ctx, { userId: campaign.userId, recipientRole: "artist", kind: "draft_uploaded", title: isReupload ? "Revised draft uploaded" : "Draft uploaded", body: campaign.title, inviteId: invite.id, campaignId: invite.campaignId, createdAt: now });
      ctx.invalidateQueries();
      return { ok: true };
    }
  }),
  requestDraftChanges: defineAction({
    request: z.object({ sessionToken: z.string(), inviteId: z.number().int().positive(), reason: z.string().trim().min(5).max(1200) }),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
    async handler(ctx, args) {
      const user = await authUser(ctx, args.sessionToken);
      if (!user || user.role !== "artist") return { ok: false, error: roleError("artist") };
      const db = ctx.db<typeof schema>();
      const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, args.inviteId)).limit(1))[0];
      if (!invite || invite.status !== "accepted") return { ok: false, error: "This collaboration is not available for review." };
      const campaign = (await db.select({ userId: schema.campaigns.userId, title: schema.campaigns.title }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0];
      const workspace = (await db.select().from(schema.collaborationWorkspaces).where(eq(schema.collaborationWorkspaces.inviteId, invite.id)).limit(1))[0];
      if (campaign?.userId !== user.id || !workspace || workspace.deliverableStage !== "awaiting_review") return { ok: false, error: "Only the artist can request changes while a draft is awaiting review." };
      if (workspace.revisionRoundsUsed >= 2) return { ok: false, error: "Both included revision rounds have been used. Approve the draft or cancel the collaboration." };
      const now = new Date();
      await db.batch([
        db.update(schema.collaborationWorkspaces).set({ deliverableStage: "changes_requested", revisionRoundsUsed: workspace.revisionRoundsUsed + 1, updatedAt: now }).where(eq(schema.collaborationWorkspaces.inviteId, invite.id)),
        db.insert(schema.collaborationDeliverableEvents).values({ inviteId: invite.id, eventType: "changes_requested", label: "Changes requested", detail: args.reason.trim(), createdAt: now }),
      ]);
      await notify(ctx, { userId: invite.curatorUserId, recipientRole: "curator", kind: "draft_declined", title: "Changes requested", body: campaign.title, inviteId: invite.id, campaignId: invite.campaignId, createdAt: now });
      ctx.invalidateQueries();
      return { ok: true };
    }
  }),
  approveDraft: defineAction({
    request: z.object({ sessionToken: z.string(), inviteId: z.number().int().positive() }),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
    async handler(ctx, args) {
      const user = await authUser(ctx, args.sessionToken);
      if (!user || user.role !== "artist") return { ok: false, error: roleError("artist") };
      const db = ctx.db<typeof schema>();
      const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, args.inviteId)).limit(1))[0];
      if (!invite || invite.status !== "accepted") return { ok: false, error: "This collaboration is not available for review." };
      const campaign = (await db.select({ userId: schema.campaigns.userId, title: schema.campaigns.title }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0];
      const workspace = (await db.select().from(schema.collaborationWorkspaces).where(eq(schema.collaborationWorkspaces.inviteId, invite.id)).limit(1))[0];
      if (campaign?.userId !== user.id || !workspace || workspace.deliverableStage !== "awaiting_review") return { ok: false, error: "Only the artist can approve a draft awaiting review." };
      const now = new Date();
      await db.batch([
        db.update(schema.collaborationWorkspaces).set({ revisionsComplete: true, deliverableStage: "approved", updatedAt: now }).where(eq(schema.collaborationWorkspaces.inviteId, invite.id)),
        db.insert(schema.collaborationDeliverableEvents).values({ inviteId: invite.id, eventType: "approved", label: "Draft approved", createdAt: now }),
      ]);
      await notify(ctx, { userId: invite.curatorUserId, recipientRole: "curator", kind: "draft_accepted", title: "Draft accepted", body: campaign.title, inviteId: invite.id, campaignId: invite.campaignId, createdAt: now });
      ctx.invalidateQueries();
      return { ok: true };
    }
  }),
  postDeliverableLive: defineAction({
    request: z.object({ sessionToken: z.string(), inviteId: z.number().int().positive(), liveLink: z.string().trim().url().max(500) }),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
    async handler(ctx, args) {
      const user = await authUser(ctx, args.sessionToken);
      if (!user || user.role !== "curator") return { ok: false, error: roleError("curator") };
      const db = ctx.db<typeof schema>();
      const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, args.inviteId)).limit(1))[0];
      const workspace = invite ? (await db.select().from(schema.collaborationWorkspaces).where(eq(schema.collaborationWorkspaces.inviteId, invite.id)).limit(1))[0] : undefined;
      if (!invite || invite.curatorUserId !== user.id || invite.status !== "accepted" || !workspace || workspace.deliverableStage !== "approved") return { ok: false, error: "The curator can add the live link after the artist approves the draft." };
      const now = new Date();
      await db.batch([
        db.update(schema.collaborationWorkspaces).set({ postedLive: true, liveLink: args.liveLink.trim(), deliverableStage: "posted", updatedAt: now }).where(eq(schema.collaborationWorkspaces.inviteId, invite.id)),
        db.insert(schema.collaborationDeliverableEvents).values({ inviteId: invite.id, eventType: "posted_live", label: "Posted live", detail: args.liveLink.trim(), createdAt: now }),
      ]);
      ctx.invalidateQueries();
      return { ok: true };
    }
  }),

  submitReport: defineAction({
    request: z.object({ sessionToken: z.string(), reason: z.enum(["spam", "harassment", "inappropriate_content", "scam_or_fraud", "copyright_violation", "other"]), details: z.string().trim().max(2000).default(""), curatorProfileId: z.number().int().positive().optional(), inviteId: z.number().int().positive().optional(), messageId: z.number().int().positive().optional() }),
    response: z.object({ ok: z.boolean(), duplicate: z.boolean().optional(), error: z.string().optional() }),
    async handler(ctx, args) {
      const user = await authUser(ctx, args.sessionToken); if (!user) return { ok: false, error: "Your session expired." };
      const db = ctx.db<typeof schema>();
      let targetUserId: number | undefined;
      let collaborationId: number | undefined;
      if (args.curatorProfileId) targetUserId = (await db.select({ userId: schema.curatorProfiles.userId }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.id, args.curatorProfileId)).limit(1))[0]?.userId;
      if (args.inviteId) {
        const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, args.inviteId)).limit(1))[0];
        const campaign = invite ? (await db.select({ userId: schema.campaigns.userId }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0] : undefined;
        if (!invite || !campaign || (user.id !== campaign.userId && user.id !== invite.curatorUserId)) return { ok: false, error: "That collaboration isn't available." };
        collaborationId = invite.id;
        targetUserId = user.id === campaign.userId ? invite.curatorUserId : campaign.userId;
        if (args.messageId) {
          const message = (await db.select().from(schema.collaborationMessages).where(and(eq(schema.collaborationMessages.id, args.messageId), eq(schema.collaborationMessages.inviteId, invite.id))).limit(1))[0];
          if (!message) return { ok: false, error: "That message isn't available." };
          targetUserId = message.senderUserId;
        }
      }
      if (!targetUserId || targetUserId === user.id) return { ok: false, error: "Choose another account or message to report." };
      const existing = (await db.select({ id: schema.userReports.id }).from(schema.userReports).where(and(eq(schema.userReports.reporterUserId, user.id), eq(schema.userReports.targetUserId, targetUserId), eq(schema.userReports.reason, args.reason))).limit(1))[0];
      const createdAt = new Date();
      if (existing) {
        // A repeated report may carry new context, and it must be placed back in the
        // relay queue even when the earlier report was already emailed. The unique
        // reporter/target/reason index intentionally keeps one durable case row.
        await db.update(schema.userReports).set({
          details: args.details.trim(),
          collaborationId: collaborationId ?? null,
          messageId: args.messageId ?? null,
          status: "active",
          emailed: false,
          emailedAt: null,
          createdAt,
        }).where(eq(schema.userReports.id, existing.id));
        ctx.invalidateQueries();
        return { ok: true, duplicate: false };
      }
      const inserted = await db.insert(schema.userReports).values({ reporterUserId: user.id, targetUserId, reason: args.reason, details: args.details.trim(), collaborationId, messageId: args.messageId, status: "active", createdAt }).returning({ id: schema.userReports.id });
      const report = inserted[0];
      if (!report) return { ok: false, error: "The report couldn't be submitted." };
      ctx.invalidateQueries(); return { ok: true, duplicate: false };
    }
  }),
  blockUser: defineAction({
    request: z.object({ sessionToken: z.string(), curatorProfileId: z.number().int().positive().optional(), inviteId: z.number().int().positive().optional() }),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
    async handler(ctx, args) {
      const user = await authUser(ctx, args.sessionToken); if (!user) return { ok: false, error: "Your session expired." };
      const db = ctx.db<typeof schema>(); let targetUserId: number | undefined;
      if (args.curatorProfileId) targetUserId = (await db.select({ userId: schema.curatorProfiles.userId }).from(schema.curatorProfiles).where(eq(schema.curatorProfiles.id, args.curatorProfileId)).limit(1))[0]?.userId;
      if (args.inviteId) { const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, args.inviteId)).limit(1))[0]; const campaign = invite ? (await db.select({ userId: schema.campaigns.userId }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0] : undefined; if (!invite || !campaign || (user.id !== campaign.userId && user.id !== invite.curatorUserId)) return { ok: false, error: "That collaboration isn't available." }; targetUserId = user.id === campaign.userId ? invite.curatorUserId : campaign.userId; }
      if (!targetUserId || targetUserId === user.id) return { ok: false, error: "Choose another account to block." };
      const exists = (await db.select({ id: schema.userBlocks.id }).from(schema.userBlocks).where(and(eq(schema.userBlocks.blockerUserId, user.id), eq(schema.userBlocks.blockedUserId, targetUserId))).limit(1))[0];
      if (!exists) await db.insert(schema.userBlocks).values({ blockerUserId: user.id, blockedUserId: targetUserId, createdAt: new Date() });
      ctx.invalidateQueries(); return { ok: true };
    }
  }),
  listBlockedUsers: defineAction({
    request: z.object({ sessionToken: z.string() }), response: z.object({ ok: z.boolean(), users: z.array(z.object({ id: z.number(), username: z.string(), role: roleSchema, blockedAt: z.string() })), error: z.string().optional() }),
    async handler(ctx, args) { const user = await authUser(ctx, args.sessionToken); if (!user) return { ok: false, users: [], error: "Your session expired." }; const db = ctx.db<typeof schema>(); const rows = await db.select().from(schema.userBlocks).where(eq(schema.userBlocks.blockerUserId, user.id)).orderBy(desc(schema.userBlocks.createdAt)); const users = await Promise.all(rows.map(async (row) => { const blocked = (await db.select({ username: schema.users.username, role: schema.users.role }).from(schema.users).where(eq(schema.users.id, row.blockedUserId)).limit(1))[0]; return blocked?.role ? { id: row.blockedUserId, username: blocked.username ?? defaultUsername(blocked.role, row.blockedUserId), role: blocked.role, blockedAt: row.createdAt.toISOString() } : null; })); return { ok: true, users: users.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)) }; }
  }),
  unblockUser: defineAction({
    request: z.object({ sessionToken: z.string(), blockedUserId: z.number().int().positive() }), response: z.object({ ok: z.boolean(), error: z.string().optional() }),
    async handler(ctx, args) { const user = await authUser(ctx, args.sessionToken); if (!user) return { ok: false, error: "Your session expired." }; await ctx.db<typeof schema>().delete(schema.userBlocks).where(and(eq(schema.userBlocks.blockerUserId, user.id), eq(schema.userBlocks.blockedUserId, args.blockedUserId))); ctx.invalidateQueries(); return { ok: true }; }
  }),
  submitReview: defineAction({
    request: z.object({ sessionToken: z.string(), inviteId: z.number().int().positive(), rating: z.number().int().min(1).max(5), body: z.string().trim().min(1).max(2000) }), response: z.object({ ok: z.boolean(), error: z.string().optional() }),
    async handler(ctx, args) {
      await expireResolveRequests(ctx);
      const user = await authUser(ctx, args.sessionToken); if (!user) return { ok: false, error: "Your session expired." }; const db = ctx.db<typeof schema>(); const invite = (await db.select().from(schema.collaborations).where(eq(schema.collaborations.id, args.inviteId)).limit(1))[0]; if (!invite || invite.status !== "content_live") return { ok: false, error: "Reviews unlock after the collaboration is resolved." };
      const campaign = (await db.select({ userId: schema.campaigns.userId }).from(schema.campaigns).where(eq(schema.campaigns.id, invite.campaignId)).limit(1))[0]; if (!campaign || (user.id !== campaign.userId && user.id !== invite.curatorUserId)) return { ok: false, error: "Only collaboration participants can review each other." };
      const targetUserId = user.id === campaign.userId ? invite.curatorUserId : campaign.userId; const now = new Date(); const existing = (await db.select({ id: schema.collaborationReviews.id }).from(schema.collaborationReviews).where(and(eq(schema.collaborationReviews.inviteId, invite.id), eq(schema.collaborationReviews.reviewerUserId, user.id))).limit(1))[0];
      if (existing) await db.update(schema.collaborationReviews).set({ rating: args.rating, body: args.body.trim(), updatedAt: now }).where(eq(schema.collaborationReviews.id, existing.id));
      else await db.insert(schema.collaborationReviews).values({ inviteId: invite.id, reviewerUserId: user.id, targetUserId, reviewerRole: user.role, rating: args.rating, body: args.body.trim(), createdAt: now, updatedAt: now });
      ctx.invalidateQueries(); return { ok: true };
    }
  }),
  listNotifications: defineAction({
    request: z.object({ sessionToken: z.string() }), response: z.object({ ok: z.boolean(), unreadCount: z.number().int().nonnegative(), notifications: z.array(z.object({ id: z.number(), kind: z.string(), title: z.string(), body: z.string(), inviteId: z.number().optional(), campaignId: z.number().optional(), read: z.boolean(), createdAt: z.string() })), error: z.string().optional() }),
    async handler(ctx, args) { await expireResolveRequests(ctx); const user = await authUser(ctx, args.sessionToken); if (!user) return { ok: false, unreadCount: 0, notifications: [], error: "Your session expired." }; const rows = await ctx.db<typeof schema>().select().from(schema.notifications).where(and(eq(schema.notifications.userId, user.id), eq(schema.notifications.recipientRole, user.role))).orderBy(desc(schema.notifications.createdAt)); return { ok: true, unreadCount: rows.filter((row) => !row.readAt).length, notifications: rows.slice(0, 60).map((row) => ({ id: row.id, kind: row.kind, title: row.title, body: row.body, inviteId: row.inviteId ?? undefined, campaignId: row.campaignId ?? undefined, read: Boolean(row.readAt), createdAt: row.createdAt.toISOString() })) }; }
  }),
  markNotificationsRead: defineAction({
    request: z.object({ sessionToken: z.string(), notificationId: z.number().int().positive().optional() }), response: z.object({ ok: z.boolean(), error: z.string().optional() }),
    async handler(ctx, args) { const user = await authUser(ctx, args.sessionToken); if (!user) return { ok: false, error: "Your session expired." }; const db = ctx.db<typeof schema>(); const condition = args.notificationId ? and(eq(schema.notifications.userId, user.id), eq(schema.notifications.recipientRole, user.role), eq(schema.notifications.id, args.notificationId)) : and(eq(schema.notifications.userId, user.id), eq(schema.notifications.recipientRole, user.role)); await db.update(schema.notifications).set({ readAt: new Date() }).where(condition); ctx.invalidateQueries(); return { ok: true }; }
  }),
  processResolveExpirations: defineAction({ request: z.object({}), response: z.object({ ok: z.boolean(), expired: z.number().int().nonnegative() }), async handler(ctx) { return { ok: true, expired: await expireResolveRequests(ctx) }; } }),

  list_pending_password_resets: defineAction({
    request: z.object({}),
    response: z.object({ resets: z.array(passwordResetRelayItemSchema) }),
    async handler(ctx): Promise<{ resets: Array<z.infer<typeof passwordResetRelayItemSchema>> }> {
      const db = ctx.db<typeof schema>();
      const now = new Date();
      const rows = await db.select().from(schema.passwordResetRequests).where(eq(schema.passwordResetRequests.emailed, false)).orderBy(asc(schema.passwordResetRequests.createdAt));
      const expiredIds = rows.filter((row) => !row.usedAt && row.expiresAt.getTime() <= now.getTime()).map((row) => row.id);
      if (expiredIds.length) await db.update(schema.passwordResetRequests).set({ usedAt: now, resetUrl: null }).where(inArray(schema.passwordResetRequests.id, expiredIds));
      return { resets: rows.filter((row) => !row.usedAt && row.expiresAt.getTime() > now.getTime() && Boolean(row.resetUrl)).map((row) => ({ id: String(row.id), email: row.email, reset_url: row.resetUrl ?? "", created_at: row.createdAt.toISOString() })) };
    },
  }),

  mark_password_reset_emailed: defineAction({
    request: z.object({ ids: z.array(z.string().regex(/^[1-9]\d*$/)).max(500) }),
    response: z.object({ count: z.number().int().nonnegative() }),
    async handler(ctx, args): Promise<{ count: number }> {
      const ids = Array.from(new Set(args.ids.map(Number))).filter((id) => Number.isSafeInteger(id) && id > 0);
      if (!ids.length) return { count: 0 };
      const updated = await ctx.db<typeof schema>().update(schema.passwordResetRequests).set({ emailed: true, emailedAt: new Date(), resetUrl: null }).where(and(eq(schema.passwordResetRequests.emailed, false), inArray(schema.passwordResetRequests.id, ids))).returning({ id: schema.passwordResetRequests.id });
      if (updated.length) ctx.invalidateQueries();
      return { count: updated.length };
    },
  }),

  list_unemailed_reports: defineAction({
    request: z.object({}),
    response: z.object({ reports: z.array(reportRelayItemSchema) }),
    async handler(ctx): Promise<{ reports: Array<z.infer<typeof reportRelayItemSchema>> }> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.userReports).where(eq(schema.userReports.emailed, false)).orderBy(asc(schema.userReports.createdAt));
      const reports = await Promise.all(rows.map(async (row): Promise<z.infer<typeof reportRelayItemSchema>> => {
        const reporter = (await db.select({ username: schema.users.username, role: schema.users.role }).from(schema.users).where(eq(schema.users.id, row.reporterUserId)).limit(1))[0];
        const reported = (await db.select({ username: schema.users.username, role: schema.users.role }).from(schema.users).where(eq(schema.users.id, row.targetUserId)).limit(1))[0];
        const reporterRole = reporter?.role ?? "unknown";
        const reportedRole = reported?.role ?? "unknown";
        return {
          id: String(row.id),
          created_at: row.createdAt.toISOString(),
          reporter_username: reporter?.username ?? (reporterRole === "unknown" ? `user-${row.reporterUserId}` : defaultUsername(reporterRole, row.reporterUserId)),
          reporter_role: reporterRole,
          reported_username: reported?.username ?? (reportedRole === "unknown" ? `user-${row.targetUserId}` : defaultUsername(reportedRole, row.targetUserId)),
          reported_role: reportedRole,
          reason: row.reason,
          details: row.details,
          collaboration_id: row.collaborationId === null ? null : String(row.collaborationId),
          message_id: row.messageId === null ? null : String(row.messageId),
          workspace_path: row.collaborationId === null ? null : `Dashboard > Collaborations > Collaboration #${row.collaborationId}`,
        };
      }));
      return { reports };
    },
  }),

  mark_reports_emailed: defineAction({
    request: z.object({ ids: z.array(z.string().regex(/^[1-9]\d*$/)).max(500) }),
    response: z.object({ count: z.number().int().nonnegative() }),
    async handler(ctx, args): Promise<{ count: number }> {
      const ids = Array.from(new Set(args.ids.map(Number))).filter((id) => Number.isSafeInteger(id) && id > 0);
      if (ids.length === 0) return { count: 0 };
      const updated = await ctx.db<typeof schema>().update(schema.userReports).set({ emailed: true, emailedAt: new Date() }).where(and(eq(schema.userReports.emailed, false), inArray(schema.userReports.id, ids))).returning({ id: schema.userReports.id });
      if (updated.length) ctx.invalidateQueries();
      return { count: updated.length };
    },
  }),

  signOut: defineAction({ request: z.object({ sessionToken: z.string() }), response: z.object({ ok: z.boolean() }), async handler(ctx, args) { await ctx.db<typeof schema>().delete(schema.userSessions).where(eq(schema.userSessions.tokenHash, await sha256(args.sessionToken))); ctx.invalidateQueries(); return { ok: true }; } }),
} satisfies ActionsModule;
