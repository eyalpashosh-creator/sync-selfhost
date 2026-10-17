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

const profile = await action<{ ok: boolean; profile?: { id: number; tiktokUrl?: string; instagramUrl?: string; youtubeUrl?: string; genres?: string[]; moods?: string[] }; error?: string }>("saveCuratorProfile", {
  sessionToken: curator.sessionToken,
  displayName: "Alpha Curator",
  bio: "Short-form music video curator.",
  platformStats: [{ platform: "TikTok", followers: 100 }],
  ratesTerms: "$100 per approved post",
  tiktokUrl: "https://www.tiktok.com/@alphacurator",
  instagramUrl: "https://www.instagram.com/alphacurator",
  youtubeUrl: "https://www.youtube.com/@alphacurator",
  acceptingInvites: true,
  advertised: true,
});
assert(profile.ok && profile.profile, `curator profile failed: ${profile.error ?? "unknown"}`);
assert(profile.profile.tiktokUrl === "https://www.tiktok.com/@alphacurator", "TikTok URL did not round-trip");
assert(profile.profile.instagramUrl === "https://www.instagram.com/alphacurator", "Instagram URL did not round-trip");
assert(profile.profile.youtubeUrl === "https://www.youtube.com/@alphacurator", "YouTube URL did not round-trip");

// Custom Genre/Mood ("Other") values save and are searchable in Discover.
const prefs = await action<{ ok: boolean; error?: string }>("savePreferences", {
  sessionToken: curator.sessionToken,
  notifyInvites: true,
  notifyMessages: true,
  notifyDeliverables: true,
  preferredPlatforms: ["TikTok"],
  preferredGenres: ["ShoegazeZZ"],
  preferredMoods: ["WistfulZZ"],
  defaultTerms: "$100 per approved post",
  turnaround: "",
  discoverable: true,
  available: true,
});
assert(prefs.ok, `savePreferences failed: ${prefs.error ?? "unknown"}`);
const foundByCustomGenre = await action<{ ok: boolean; curators: Array<{ username: string; genres: string[]; moods: string[] }>; error?: string }>("listCurators", {
  sessionToken: artist.sessionToken,
  query: "ShoegazeZZ",
});
assert(foundByCustomGenre.ok && foundByCustomGenre.curators.some((c) => c.genres.includes("ShoegazeZZ") && c.moods.includes("WistfulZZ")), "custom genre/mood did not round-trip or is not searchable");

// Discover visibility follows the advertise toggle: hidden when off, listed when on.
const hiddenPrefs = await action<{ ok: boolean; error?: string }>("savePreferences", {
  sessionToken: curator.sessionToken,
  notifyInvites: true,
  notifyMessages: true,
  notifyDeliverables: true,
  preferredPlatforms: ["TikTok"],
  preferredGenres: ["ShoegazeZZ"],
  preferredMoods: ["WistfulZZ"],
  defaultTerms: "$100 per approved post",
  turnaround: "",
  discoverable: false,
  available: true,
});
assert(hiddenPrefs.ok, `hiding profile failed: ${hiddenPrefs.error ?? "unknown"}`);
const hiddenList = await action<{ ok: boolean; curators: Array<{ username: string }>; error?: string }>("listCurators", {
  sessionToken: artist.sessionToken,
  query: "ShoegazeZZ",
});
assert(hiddenList.ok && !hiddenList.curators.some((c) => c.genres.includes("ShoegazeZZ")), "curator with discoverable=false still appears in Discover");
const visiblePrefs = await action<{ ok: boolean; error?: string }>("savePreferences", {
  sessionToken: curator.sessionToken,
  notifyInvites: true,
  notifyMessages: true,
  notifyDeliverables: true,
  preferredPlatforms: ["TikTok"],
  preferredGenres: ["ShoegazeZZ"],
  preferredMoods: ["WistfulZZ"],
  defaultTerms: "$100 per approved post",
  turnaround: "",
  discoverable: true,
  available: true,
});
assert(visiblePrefs.ok, `re-listing profile failed: ${visiblePrefs.error ?? "unknown"}`);
const visibleList = await action<{ ok: boolean; curators: Array<{ username: string }>; error?: string }>("listCurators", {
  sessionToken: artist.sessionToken,
  query: "ShoegazeZZ",
});
assert(visibleList.ok && visibleList.curators.some((c) => c.genres.includes("ShoegazeZZ")), "curator with discoverable=true missing from Discover");

const campaign = await action<{ ok: boolean; campaign?: { id: number }; error?: string }>("createCampaign", {
  sessionToken: artist.sessionToken,
  title: "Alpha smoke campaign",
  genre: "Ambient",
  mood: "Dreamy",
  platforms: ["TikTok"],
  notes: "Smoke-test campaign",
});
assert(campaign.ok && campaign.campaign, `campaign creation failed: ${campaign.error ?? "unknown"}`);

// Campaign editing: owner can update; another artist is rejected.
const edited = await action<{ ok: boolean; campaign?: { id: number; title: string; genre: string; mood: string }; error?: string }>("updateCampaign", {
  sessionToken: artist.sessionToken,
  campaignId: campaign.campaign.id,
  title: "Alpha smoke campaign (edited)",
  genre: "ShoegazeZZ",
  mood: "WistfulZZ",
  platforms: ["TikTok"],
  notes: "Smoke-test campaign, edited",
});
assert(edited.ok && edited.campaign?.title === "Alpha smoke campaign (edited)" && edited.campaign?.genre === "ShoegazeZZ", `campaign edit failed: ${edited.error ?? "unknown"}`);
const otherArtist = await action<{ ok: boolean; sessionToken?: string; error?: string }>("createEmailAccount", { name: "Other Artist", email: `other-artist-${suffix}@example.test`, password, role: "artist" });
assert(otherArtist.ok && otherArtist.sessionToken, `second artist sign-up failed: ${otherArtist.error ?? "unknown"}`);
const forbiddenEdit = await action<{ ok: boolean; error?: string }>("updateCampaign", {
  sessionToken: otherArtist.sessionToken,
  campaignId: campaign.campaign.id,
  title: "Hacked title",
  genre: "Ambient",
  mood: "Dreamy",
  platforms: ["TikTok"],
  notes: "",
});
assert(!forbiddenEdit.ok && forbiddenEdit.error === "That campaign isn't available.", `non-owner campaign edit was not rejected: ${JSON.stringify(forbiddenEdit)}`);

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

console.log(JSON.stringify({ ok: true, tested: ["sign-up", "sign-in", "curator profile with social links", "custom genre/mood", "discover visibility toggle", "create campaign", "edit campaign", "non-owner edit rejected", "send invite", "accept invite"] }, null, 2));
