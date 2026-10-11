const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function action<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${baseUrl}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: name, args }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${name} HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body as T;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const password = "AlphaTest-Password-123";
const artistEmail = `artist-${suffix}@example.test`;
const curatorEmail = `curator-${suffix}@example.test`;

const artist = await action<{ ok: boolean; sessionToken?: string; error?: string }>("createEmailAccount", { name: "Alpha Artist", email: artistEmail, password, role: "artist" });
assert(artist.ok && artist.sessionToken, `artist sign-up failed: ${artist.error ?? "unknown"}`);
const curator = await action<{ ok: boolean; sessionToken?: string; error?: string }>("createEmailAccount", { name: "Alpha Curator", email: curatorEmail, password, role: "curator" });
assert(curator.ok && curator.sessionToken, `curator sign-up failed: ${curator.error ?? "unknown"}`);

const signedIn = await action<{ ok: boolean; sessionToken?: string; error?: string }>("signInWithEmail", { email: artistEmail, password, role: "artist" });
assert(signedIn.ok && signedIn.sessionToken, `artist sign-in failed: ${signedIn.error ?? "unknown"}`);

const profile = await action<{ ok: boolean; profile?: { id: number }; error?: string }>("saveCuratorProfile", {
  sessionToken: curator.sessionToken,
  displayName: "Alpha Curator",
  bio: "Short-form music video curator.",
  platformStats: [{ platform: "TikTok", followers: 100 }],
  ratesTerms: "$100 per approved post",
  portfolioLinks: [],
  acceptingInvites: true,
  advertised: true,
});
assert(profile.ok && profile.profile, `curator profile failed: ${profile.error ?? "unknown"}`);

const campaign = await action<{ ok: boolean; campaign?: { id: number }; error?: string }>("createCampaign", {
  sessionToken: artist.sessionToken,
  title: "Alpha smoke campaign",
  genre: "Ambient",
  mood: "Dreamy",
  platforms: ["TikTok"],
  notes: "Smoke-test campaign",
});
assert(campaign.ok && campaign.campaign, `campaign creation failed: ${campaign.error ?? "unknown"}`);

const invite = await action<{ ok: boolean; invite?: { id: number }; error?: string }>("sendCampaignInvite", {
  sessionToken: artist.sessionToken,
  campaignId: campaign.campaign.id,
  curatorProfileId: profile.profile.id,
});
assert(invite.ok && invite.invite, `invite creation failed: ${invite.error ?? "unknown"}`);

const accepted = await action<{ ok: boolean; status?: string; error?: string }>("updateInviteStatus", {
  sessionToken: curator.sessionToken,
  inviteId: invite.invite.id,
  status: "accepted",
});
assert(accepted.ok && accepted.status === "accepted", `invite acceptance failed: ${accepted.error ?? "unknown"}`);

console.log(JSON.stringify({ ok: true, tested: ["sign-up", "sign-in", "create campaign", "send invite", "accept invite"] }, null, 2));
