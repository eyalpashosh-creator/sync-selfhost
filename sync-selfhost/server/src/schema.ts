import { sql } from "drizzle-orm";
import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: text("role", { enum: ["artist", "curator"] }),
  username: text("username"),
  bio: text("bio").notNull().default(""),
  avatarBlobKey: text("avatar_blob_key"),
  notifyInvites: integer("notify_invites", { mode: "boolean" }).notNull().default(true),
  notifyMessages: integer("notify_messages", { mode: "boolean" }).notNull().default(true),
  notifyDeliverables: integer("notify_deliverables", { mode: "boolean" }).notNull().default(true),
  preferredPlatforms: text("preferred_platforms").notNull().default("[]"),
  contentStyles: text("content_styles").notNull().default("[]"),
  preferredGenres: text("preferred_genres").notNull().default("[]"),
  preferredMoods: text("preferred_moods").notNull().default("[]"),
  defaultTerms: text("default_terms").notNull().default(""),
  turnaround: text("turnaround").notNull().default(""),
  advertiseBoost: integer("advertise_boost", { mode: "boolean" }).notNull().default(false),
  discoverable: integer("discoverable", { mode: "boolean" }).notNull().default(true),
  available: integer("available", { mode: "boolean" }).notNull().default(true),
  passwordHash: text("password_hash"),
  passwordSalt: text("password_salt"),
  emailUpdates: integer("email_updates", { mode: "boolean" }).notNull().default(true),
  matchAlerts: integer("match_alerts", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastSignInAt: integer("last_sign_in_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("users_username_lower_idx").on(sql`lower(${table.username})`)]);

export const userSessions = sqliteTable("user_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["artist", "curator"] }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("user_sessions_user_id_idx").on(table.userId), index("user_sessions_expires_at_idx").on(table.expiresAt)]);

export const passwordResetRequests = sqliteTable("password_reset_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  resetUrl: text("reset_url"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  emailed: integer("emailed", { mode: "boolean" }).notNull().default(false),
  emailedAt: integer("emailed_at", { mode: "timestamp_ms" }),
}, (table) => [index("password_reset_requests_user_idx").on(table.userId), index("password_reset_requests_pending_idx").on(table.emailed, table.expiresAt, table.usedAt)]);

export const passwordResetRateLimits = sqliteTable("password_reset_rate_limits", {
  email: text("email").primaryKey(),
  windowStartedAt: integer("window_started_at", { mode: "timestamp_ms" }).notNull(),
  requestCount: integer("request_count").notNull().default(1),
});

export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(), genre: text("genre").notNull(), mood: text("mood").notNull(),
  targetNiche: text("target_niche").notNull(), platforms: text("platforms").notNull(), notes: text("notes").notNull().default(""),
  status: text("status", { enum: ["draft", "active", "completed"] }).notNull().default("draft"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("campaigns_user_id_idx").on(table.userId), index("campaigns_created_at_idx").on(table.createdAt)]);

export const curatorProfiles = sqliteTable("curator_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(), bio: text("bio").notNull().default(""),
  platforms: text("platforms").notNull(), platformStats: text("platform_stats").notNull().default("[]"),
  followerCount: integer("follower_count").notNull().default(0),
  ratesTerms: text("rates_terms").notNull().default(""), portfolioLinks: text("portfolio_links").notNull().default("[]"),
  tiktokUrl: text("tiktok_url").notNull().default(""),
  instagramUrl: text("instagram_url").notNull().default(""),
  youtubeUrl: text("youtube_url").notNull().default(""),
  acceptingInvites: integer("accepting_invites", { mode: "boolean" }).notNull().default(true),
  advertised: integer("advertised", { mode: "boolean" }).notNull().default(true),
  isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
  invitePlan: text("invite_plan", { enum: ["starter", "growth", "professional"] }).notNull().default("starter"),
  inviteCreditsRemaining: integer("invite_credits_remaining").notNull().default(5),
  inviteCreditsResetAt: integer("invite_credits_reset_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("curator_profiles_accepting_idx").on(table.acceptingInvites)]);

export const collaborations = sqliteTable("collaborations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  curatorUserId: integer("curator_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["invited", "accepted", "declined", "resolve_pending", "content_live"] }).notNull().default("invited"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }), liveAt: integer("live_at", { mode: "timestamp_ms" }),
  resolveRequestedByRole: text("resolve_requested_by_role", { enum: ["artist", "curator"] }),
  resolveRequestedAt: integer("resolve_requested_at", { mode: "timestamp_ms" }),
}, (table) => [index("campaign_invites_campaign_idx").on(table.campaignId), index("campaign_invites_curator_idx").on(table.curatorUserId)]);

export const collaborationMessages = sqliteTable("collaboration_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }), inviteId: integer("invite_id").notNull().references(() => collaborations.id, { onDelete: "cascade" }),
  senderUserId: integer("sender_user_id").notNull().references(() => users.id, { onDelete: "cascade" }), senderRole: text("sender_role", { enum: ["artist", "curator"] }), body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("collaboration_messages_invite_idx").on(table.inviteId), index("collaboration_messages_created_idx").on(table.createdAt)]);

export const collaborationWorkspaces = sqliteTable("collaboration_workspaces", {
  id: integer("id").primaryKey({ autoIncrement: true }), inviteId: integer("invite_id").notNull().unique().references(() => collaborations.id, { onDelete: "cascade" }),
  draftReady: integer("draft_ready", { mode: "boolean" }).notNull().default(false),
  revisionsComplete: integer("revisions_complete", { mode: "boolean" }).notNull().default(false),
  postedLive: integer("posted_live", { mode: "boolean" }).notNull().default(false), liveLink: text("live_link").notNull().default(""),
  deliverableStage: text("deliverable_stage", { enum: ["waiting_draft", "awaiting_review", "changes_requested", "approved", "posted"] }).notNull().default("waiting_draft"),
  draftBlobKey: text("draft_blob_key"),
  draftMimeType: text("draft_mime_type"),
  draftFilename: text("draft_filename"),
  revisionRoundsUsed: integer("revision_rounds_used").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("collaboration_workspaces_invite_idx").on(table.inviteId)]);

export const draftUploadSessions = sqliteTable("draft_upload_sessions", {
  id: text("id").primaryKey(),
  inviteId: integer("invite_id").notNull().references(() => collaborations.id, { onDelete: "cascade" }),
  curatorUserId: integer("curator_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type", { enum: ["video/mp4", "video/webm", "video/quicktime"] }).notNull(),
  totalBytes: integer("total_bytes").notNull(),
  totalChunks: integer("total_chunks").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("draft_upload_sessions_invite_idx").on(table.inviteId), index("draft_upload_sessions_curator_idx").on(table.curatorUserId)]);

export const draftUploadChunks = sqliteTable("draft_upload_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uploadId: text("upload_id").notNull().references(() => draftUploadSessions.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  byteLength: integer("byte_length").notNull(),
  bytes: blob("bytes", { mode: "buffer" }).notNull(),
}, (table) => [uniqueIndex("draft_upload_chunks_upload_chunk_idx").on(table.uploadId, table.chunkIndex), index("draft_upload_chunks_upload_idx").on(table.uploadId)]);

export const userBlocks = sqliteTable("user_blocks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  blockerUserId: integer("blocker_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  blockedUserId: integer("blocked_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("user_blocks_pair_idx").on(table.blockerUserId, table.blockedUserId), index("user_blocks_blocked_idx").on(table.blockedUserId)]);

export const userReports = sqliteTable("user_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reporterUserId: integer("reporter_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  targetUserId: integer("target_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reason: text("reason", { enum: ["spam", "harassment", "inappropriate_content", "scam_or_fraud", "copyright_violation", "other"] }).notNull(),
  details: text("details").notNull().default(""),
  collaborationId: integer("collaboration_id").references(() => collaborations.id, { onDelete: "set null" }),
  messageId: integer("message_id").references(() => collaborationMessages.id, { onDelete: "set null" }),
  status: text("status", { enum: ["active", "closed"] }).notNull().default("active"),
  emailed: integer("emailed", { mode: "boolean" }).notNull().default(false),
  emailedAt: integer("emailed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("user_reports_reporter_target_reason_idx").on(table.reporterUserId, table.targetUserId, table.reason), index("user_reports_target_idx").on(table.targetUserId), index("user_reports_emailed_created_idx").on(table.emailed, table.createdAt)]);

export const collaborationTimelineEvents = sqliteTable("collaboration_timeline_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  inviteId: integer("invite_id").notNull().references(() => collaborations.id, { onDelete: "cascade" }),
  eventType: text("event_type", { enum: ["resolve_requested", "resolve_cancelled", "resolve_confirmed", "resolve_expired"] }).notNull(),
  label: text("label").notNull(),
  detail: text("detail").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("collaboration_timeline_events_invite_idx").on(table.inviteId), index("collaboration_timeline_events_created_idx").on(table.createdAt)]);

export const collaborationReviews = sqliteTable("collaboration_reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  inviteId: integer("invite_id").notNull().references(() => collaborations.id, { onDelete: "cascade" }),
  reviewerUserId: integer("reviewer_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  targetUserId: integer("target_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reviewerRole: text("reviewer_role", { enum: ["artist", "curator"] }).notNull(),
  rating: integer("rating").notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("collaboration_reviews_invite_reviewer_idx").on(table.inviteId, table.reviewerUserId), index("collaboration_reviews_target_idx").on(table.targetUserId)]);

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["invite_received", "invite_accepted", "invite_declined", "draft_uploaded", "draft_accepted", "draft_declined", "resolve_requested", "resolve_confirmed", "resolve_expired", "message_received"] }).notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  recipientRole: text("recipient_role", { enum: ["artist", "curator"] }),
  inviteId: integer("invite_id").references(() => collaborations.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
  readAt: integer("read_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("notifications_user_created_idx").on(table.userId, table.createdAt), index("notifications_user_read_idx").on(table.userId, table.readAt)]);

export const collaborationDeliverableEvents = sqliteTable("collaboration_deliverable_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  inviteId: integer("invite_id").notNull().references(() => collaborations.id, { onDelete: "cascade" }),
  eventType: text("event_type", { enum: ["draft_uploaded", "changes_requested", "draft_reuploaded", "approved", "posted_live"] }).notNull(),
  label: text("label").notNull(),
  detail: text("detail").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("collaboration_deliverable_events_invite_idx").on(table.inviteId), index("collaboration_deliverable_events_created_idx").on(table.createdAt)]);
