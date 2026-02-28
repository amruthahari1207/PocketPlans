// app/api/plan/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { cookies, headers } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import crypto from "node:crypto";

export const runtime = "nodejs";

/* =============================================================================
   PRODUCTION GOALS (what this version fixes)
   - Swap pool collapse: multi-lane retrieval (Nearby + TextSearch), fallback vibe mixing
   - Speed: Redis caching for details + search results, bounded details calls, parallel lanes
   - Safety: strict input caps, rate limit, no key leaks, timeouts, graceful degradation
   - Quality: shortlist rules unchanged (openNow=true, known close, >=75min, <=10km)
   - Abundance: swap pool allows unknown hours, >=45 if known, wider distance (<=14km)
============================================================================= */

/* ---------------- Types ---------------- */

type PlanRequest = {
  city?: string;
  vibe?: string;
  withWho?: string;
  vegFriendly?: boolean;
  seenPlaceIds?: string[];
  swappedPlaceIds?: string[];
};

type Option = {
  id: string; // internal id during build; remapped to 1..5 for UI shortlist
  name: string;
  category: string;
  rating: number;
  etaMin: number;
  openStatus: string;
  why: string;
  watchouts: string[];
  lat: number;
  lng: number;
  address: string;

  closingTime?: string | null;
  placeId?: string | null;
  priceLevel?: number | null;
  userRatingsTotal?: number | null;
  closeTs?: number | null;
  photoUrls?: string[];

  _score?: number; // internal
};

type WeatherPayload = {
  now: { temp: number; description: string; wind: number };
  nextHours: { timeLabel: string; temp: number; description: string; wind: number }[];
  cityLocalHour: number;
  alerts: string[];
  tzOffsetSec: number;
};

/* ---------------- OpenAI ---------------- */

function getOpenAIClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

/* ---------------- Constants ---------------- */

const CITY_CENTERS: Record<string, { lat: number; lng: number }> = {
  Boston: { lat: 42.3601, lng: -71.0589 },
  "New York": { lat: 40.7128, lng: -74.006 },
  "San Francisco": { lat: 37.7749, lng: -122.4194 },
  Chicago: { lat: 41.8781, lng: -87.6298 },
  Seattle: { lat: 47.6062, lng: -122.3321 },
  Austin: { lat: 30.2672, lng: -97.7431 },
  "Los Angeles": { lat: 34.0522, lng: -118.2437 },
  "Washington DC": { lat: 38.9072, lng: -77.0369 },
  Miami: { lat: 25.7617, lng: -80.1918 },
  Atlanta: { lat: 33.749, lng: -84.388 },
};

const ALLOWED_BY_VIBE: Record<string, string[]> = {
  Cozy: ["Cafe", "Dessert", "Bookstore", "Wine Bar", "Tea House"],
  Outdoors: ["Park", "Scenic Walk", "Waterfront", "Outdoor Market", "Activity"],
  Productive: ["Library", "Work Cafe", "Quiet Workspace", "Study Spot"],
  Social: ["Bar", "Group Dining", "Activity Venue", "Event Space"],
  Luxury: ["Fine Dining", "Rooftop Bar", "Specialty Dessert", "Premium Spot"],
};

const KEYWORD_BY_CATEGORY: Record<string, string> = {
  Cafe: "cafe",
  "Work Cafe": "cafe laptop friendly",
  Dessert: "dessert",
  Bookstore: "bookstore",
  "Wine Bar": "wine bar",
  "Tea House": "tea house",
  Library: "library",
  "Quiet Workspace": "coworking space",
  "Study Spot": "study cafe",
  Bar: "bar",
  "Group Dining": "restaurant",
  "Fine Dining": "fine dining",
  "Rooftop Bar": "rooftop bar",
  "Activity Venue": "arcade bowling",
  "Event Space": "museum",
  Park: "park",
  "Scenic Walk": "scenic walk",
  Waterfront: "waterfront",
  "Outdoor Market": "outdoor market",
  Activity: "things to do",
  "Specialty Dessert": "dessert",
  "Premium Spot": "premium lounge",
};

const MIN_REMAINING_MIN = 75; // shortlist
const RELAXED_REMAINING_MIN = 45; // swap pool (if close known)

const CITY_CENTER_RADIUS_NEARBY_M = 12000; // shortlist & baseline retrieval
const CITY_CENTER_RADIUS_SWAP_M = 16000; // swap pool retrieval
const MAX_DIST_KM_SHORTLIST = 10;
const MAX_DIST_KM_SWAP = 14;

const DETAILS_TTL_MS = 30 * 60 * 1000; // 30 min
const SEARCH_TTL_MS = 3 * 60 * 1000; // 3 min

// Hard caps to keep latency predictable (and costs safe)
const DETAILS_CAP_TOTAL = 55; // maximum details calls per request
const DETAILS_CONCURRENCY = 10;
const LANE_CONCURRENCY = 6;

const MAX_SEEN_IDS = 220;
const MAX_SWAPPED_IDS = 220;

const TARGET_SWAP_POOL = 26; // aim for this many swap candidates
const MAX_POOL_RETURN = 60; // send enough to feel abundant, but not huge payload

/* ---------------- Helpers ---------------- */

function pickDefaultCity(city?: string) {
  const c = (city || "Boston").trim();
  return CITY_CENTERS[c] ? c : "Boston";
}

function pickDefaultVibe(vibe?: string) {
  const v = (vibe || "Social").trim();
  return ALLOWED_BY_VIBE[v] ? v : "Social";
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function safeString(x: any, fallback: string) {
  return typeof x === "string" && x.trim() ? x.trim() : fallback;
}

function safeBool(x: any) {
  return x === true;
}

function sanitizeIdList(x: any, cap: number) {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const v of x) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s) continue;
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const sin1 = Math.sin(dLat / 2);
  const sin2 = Math.sin(dLng / 2);
  const h = sin1 * sin1 + Math.cos(lat1) * Math.cos(lat2) * sin2 * sin2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isOutdoorishCategory(category: string) {
  const cat = (category || "").toLowerCase();
  return (
    cat.includes("park") ||
    cat.includes("walk") ||
    cat.includes("water") ||
    cat.includes("outdoor") ||
    cat.includes("waterfront") ||
    cat.includes("scenic") ||
    cat.includes("market") ||
    cat.includes("activity")
  );
}

/** Google types -> internal categories (must stay inside ALLOWED_BY_VIBE[vibe]) */
function googleTypeToInternalCategory(types: string[] = [], vibe: string) {
  const allowed = new Set(ALLOWED_BY_VIBE[vibe] ?? ALLOWED_BY_VIBE["Social"]);
  const t = new Set(types);

  if (t.has("bar") || t.has("night_club"))
    return allowed.has("Bar") ? "Bar" : ALLOWED_BY_VIBE[vibe]?.[0] ?? "Venue";

  if (t.has("bowling_alley") || t.has("movie_theater") || t.has("amusement_park") || t.has("casino"))
    return allowed.has("Activity Venue") ? "Activity Venue" : ALLOWED_BY_VIBE[vibe]?.[0] ?? "Activity";

  if (t.has("restaurant")) {
    if (allowed.has("Group Dining")) return "Group Dining";
    if (allowed.has("Fine Dining")) return "Fine Dining";
    if (allowed.has("Work Cafe")) return "Work Cafe";
    if (allowed.has("Study Spot")) return "Study Spot";
    return allowed.has("Cafe") ? "Cafe" : ALLOWED_BY_VIBE[vibe]?.[0] ?? "Restaurant";
  }

  if (t.has("cafe")) {
    if (allowed.has("Work Cafe")) return "Work Cafe";
    if (allowed.has("Cafe")) return "Cafe";
    return ALLOWED_BY_VIBE[vibe]?.[0] ?? "Cafe";
  }

  if (t.has("bakery")) return allowed.has("Dessert") ? "Dessert" : ALLOWED_BY_VIBE[vibe]?.[0] ?? "Dessert";
  if (t.has("library")) return allowed.has("Library") ? "Library" : ALLOWED_BY_VIBE[vibe]?.[0] ?? "Study Spot";
  if (t.has("book_store")) return allowed.has("Bookstore") ? "Bookstore" : ALLOWED_BY_VIBE[vibe]?.[0] ?? "Bookstore";
  if (t.has("park")) return allowed.has("Park") ? "Park" : ALLOWED_BY_VIBE[vibe]?.[0] ?? "Park";

  if (t.has("tourist_attraction") || t.has("point_of_interest")) {
    if (allowed.has("Scenic Walk")) return "Scenic Walk";
    if (allowed.has("Waterfront")) return "Waterfront";
    if (allowed.has("Activity")) return "Activity";
  }

  if (t.has("museum") || t.has("art_gallery") || t.has("stadium") || t.has("theater")) {
    if (allowed.has("Event Space")) return "Event Space";
    if (allowed.has("Activity Venue")) return "Activity Venue";
    if (allowed.has("Activity")) return "Activity";
  }

  return ALLOWED_BY_VIBE[vibe]?.[0] ?? "Cafe";
}

/* ---------------- Fetch w/ timeout ---------------- */

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- Weather ---------------- */

function hourLabelFromDt(dtSec: number, tzOffsetSec: number) {
  const d = new Date((dtSec + tzOffsetSec) * 1000);
  const h = d.getUTCHours();
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${suffix}`;
}

function cityLocalHourNow(tzOffsetSec: number) {
  const d = new Date(Date.now() + tzOffsetSec * 1000);
  return d.getUTCHours();
}

async function getWeather(city: string): Promise<WeatherPayload | null> {
  const key = process.env.OPENWEATHER_KEY;
  if (!key) return null;

  const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)},US&units=metric&appid=${key}`;
  const res = await fetchWithTimeout(url, { cache: "no-store" }, 7000);
  if (!res.ok) return null;

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    return null;
  }

  const tzOffsetSec: number = data?.city?.timezone ?? 0;
  const nowEpochSec = Math.floor(Date.now() / 1000);

  const list = Array.isArray(data?.list) ? data.list : [];
  const upcoming = list.filter((x: any) => typeof x?.dt === "number" && x.dt >= nowEpochSec);

  const first = upcoming[0] ?? list[0];
  if (!first) return null;

  const now = {
    temp: Math.round(first.main?.temp ?? 0),
    description: first.weather?.[0]?.description ?? "unknown",
    wind: Math.round((first.wind?.speed ?? 0) * 10) / 10,
  };

  const nextHours = upcoming.slice(0, 4).map((x: any) => ({
    timeLabel: hourLabelFromDt(x.dt, tzOffsetSec),
    temp: Math.round(x.main?.temp ?? 0),
    description: x.weather?.[0]?.description ?? "unknown",
    wind: Math.round((x.wind?.speed ?? 0) * 10) / 10,
  }));

  const cityLocalHour = cityLocalHourNow(tzOffsetSec);

  const alerts: string[] = [];
  const descs: string[] = nextHours.map((h: any) => String(h.description ?? "").toLowerCase());
  const hasSnow = descs.some((d: string) => d.includes("snow"));
  const hasRain = descs.some((d: string) => d.includes("rain") || d.includes("drizzle") || d.includes("shower"));
  const hasThunder = descs.some((d: string) => d.includes("thunder"));
  const hasFog = descs.some((d: string) => d.includes("fog") || d.includes("mist"));

  const maxWind = Math.max(...nextHours.map((h: any) => Number(h.wind ?? 0)));
  const windy = maxWind >= 9;
  const veryWindy = maxWind >= 13;

  const temps = nextHours.map((h: any) => Number(h.temp ?? 0));
  const minTemp = Math.min(...temps);
  const maxTemp = Math.max(...temps);
  const drop = maxTemp - minTemp;

  if (hasSnow) alerts.push("Snow expected soon");
  if (!hasSnow && hasRain) alerts.push("Rain likely soon");
  if (hasThunder) alerts.push("Thunderstorms possible");
  if (hasFog) alerts.push("Low visibility (fog/mist)");
  if (veryWindy) alerts.push("Very windy later");
  else if (windy) alerts.push("Windy later");
  if (drop >= 6) alerts.push(`Big temp swing (≈${Math.round(drop)}°C)`);

  return { now, nextHours, cityLocalHour, alerts: alerts.slice(0, 2), tzOffsetSec };
}

function getWeatherFlags(weather: WeatherPayload | null) {
  const next = weather?.nextHours?.slice(0, 2) ?? [];
  const descs = next.map((h: any) => String(h.description ?? "").toLowerCase());
  const temps = next.map((h: any) => Number(h.temp ?? 0));
  const winds = next.map((h: any) => Number(h.wind ?? 0));

  const precip = descs.some((d: string) =>
    d.includes("snow") || d.includes("rain") || d.includes("drizzle") || d.includes("shower") || d.includes("thunder")
  );

  const minTemp = temps.length ? Math.min(...temps) : 999;
  const maxWind = winds.length ? Math.max(...winds) : 0;

  return {
    precip,
    cold: minTemp <= 2,
    veryCold: minTemp <= -5,
    windy: maxWind >= 9,
    veryWindy: maxWind >= 13,
    minTemp,
  };
}

function cityLocalNow(tzOffsetSec: number) {
  return new Date(Date.now() + tzOffsetSec * 1000);
}

function minutesSinceMidnight(d: Date) {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function parseClosingTimeToMinutes(closingTime: string | null) {
  if (!closingTime) return null;
  const m = closingTime.match(/^(\d{1,2}):(\d{2})\s(AM|PM)$/i);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();

  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  return hour * 60 + min;
}

function minutesUntilClose(cityNow: Date, closingTime: string | null, closeTs?: number | null) {
  if (typeof closeTs === "number") {
    const diff = closeTs - Date.now();
    return diff > 0 ? Math.floor(diff / 60000) : 0;
  }

  const closeMin = parseClosingTimeToMinutes(closingTime);
  if (closeMin == null) return null;

  const nowMin = minutesSinceMidnight(cityNow);
  return closeMin >= nowMin ? closeMin - nowMin : 24 * 60 - nowMin + closeMin;
}

/* ---------------- Concurrency helper ---------------- */

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let i = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      out[idx] = await fn(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return out;
}

/* ---------------- Upstash Redis REST (no npm deps) ---------------- */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function hasRedis() {
  return Boolean(UPSTASH_URL && UPSTASH_TOKEN);
}

async function redisPipeline(commands: any[]): Promise<any[]> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error("Redis not configured");

  const res = await fetchWithTimeout(
    `${UPSTASH_URL}/pipeline`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        "Content-Type": "application/json",
      },
      // ✅ Upstash expects the array directly, not { commands: ... }
      body: JSON.stringify(commands),
      cache: "no-store",
    },
    4000
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Redis pipeline failed: ${res.status} ${text}`);
  }

  return (await res.json()) as any[];
}

async function redisGet(key: string): Promise<string | null> {
  const out = await redisPipeline([["GET", key]]);
  const r = out?.[0]?.result ?? null;
  return typeof r === "string" ? r : null;
}

async function redisSetPx(key: string, value: string, ttlMs: number) {
  await redisPipeline([["SET", key, value, "PX", String(ttlMs)]]);
}

/** Atomic INCR with PX expiry if first hit */
async function redisIncrWithTtl(key: string, ttlMs: number): Promise<number> {
  const script = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return c
`.trim();

  const out = await redisPipeline([["EVAL", script, "1", key, String(ttlMs)]]);
  const r = out?.[0]?.result;
  if (typeof r === "number") return r;
  if (typeof r === "string" && /^\d+$/.test(r)) return parseInt(r, 10);
  return 1;
}

function msUntilUtcMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return Math.max(60_000, next.getTime() - now.getTime());
}

/* ---------------- Rate limiting policy ---------------- */

function stableHash(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 32);
}

function getClientIpSafe(h: Headers) {
  const xff = h.get("x-forwarded-for") || "";
  return xff.split(",")[0]?.trim() || "0.0.0.0";
}

function getGuestKey(h: Headers) {
  const ip = getClientIpSafe(h);
  const ua = h.get("user-agent") || "ua";
  return `guest:${stableHash(`${ip}|${ua}`)}`;
}

async function enforceRateLimit(identityKey: string, mode: "guest" | "auth") {
  if (!hasRedis()) {
    // In production, we require Redis to avoid abuse.
    if (process.env.NODE_ENV !== "production") return { ok: true as const };
    return {
      ok: false as const,
      status: 500,
      retryAfterSec: 0,
      message: "Server not configured (rate limiter missing).",
    };
  }

  const perMinMax = mode === "guest" ? 3 : 12;
  const perDayMax = mode === "guest" ? 15 : 200;

  const minKey = `rl:min:${identityKey}`;
  const dayKey = `rl:day:${identityKey}:${new Date().toISOString().slice(0, 10)}`;

  const [minCount, dayCount] = await Promise.all([
    redisIncrWithTtl(minKey, 60_000),
    redisIncrWithTtl(dayKey, msUntilUtcMidnight()),
  ]);

  if (minCount > perMinMax) {
    return { ok: false as const, status: 429, retryAfterSec: 60, message: "Too many requests. Please slow down." };
  }
  if (dayCount > perDayMax) {
    return { ok: false as const, status: 429, retryAfterSec: 3600, message: "Daily limit reached. Try again later." };
  }

  return { ok: true as const };
}

/* ---------------- Google Places: Nearby + Text Search + Details ---------------- */

type GoogleCandidate = { placeId: string; name: string; lat: number; lng: number };

function buildSearchCacheKey(parts: Record<string, string | number | boolean | null | undefined>) {
  const base = Object.entries(parts)
    .map(([k, v]) => `${k}=${String(v ?? "")}`)
    .join("&");
  return `pp:search:${stableHash(base)}`;
}

async function googleNearbySearch(opts: {
  lat: number;
  lng: number;
  radiusM: number;
  keyword: string;
  allowCache: boolean;
}) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return [];

  const cacheKey = buildSearchCacheKey({
    lane: "nearby",
    lat: opts.lat.toFixed(4),
    lng: opts.lng.toFixed(4),
    radius: opts.radiusM,
    q: opts.keyword.toLowerCase().slice(0, 80),
  });

  if (opts.allowCache && hasRedis()) {
    const cached = await redisGet(cacheKey);
    if (cached) {
      try {
        const arr = JSON.parse(cached);
        if (Array.isArray(arr)) return arr as GoogleCandidate[];
      } catch {}
    }
  }

  const url =
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
    `?location=${opts.lat},${opts.lng}` +
    `&radius=${opts.radiusM}` +
    `&keyword=${encodeURIComponent(opts.keyword)}` +
    `&key=${key}`;

  const res = await fetchWithTimeout(url, { cache: "no-store" }, 6500);
  if (!res.ok) return [];

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    return [];
  }

  const results = Array.isArray(data?.results) ? data.results : [];
  const out = results
    .map((r: any) => {
      const placeId = r?.place_id;
      const name = r?.name;
      const lat = r?.geometry?.location?.lat;
      const lng = r?.geometry?.location?.lng;
      if (!placeId || !name || typeof lat !== "number" || typeof lng !== "number") return null;
      return { placeId, name, lat, lng } as GoogleCandidate;
    })
    .filter(Boolean) as GoogleCandidate[];

  if (opts.allowCache && hasRedis()) {
    try {
      await redisSetPx(cacheKey, JSON.stringify(out), SEARCH_TTL_MS);
    } catch {}
  }

  return out;
}

async function googleTextSearch(opts: {
  lat: number;
  lng: number;
  radiusM: number;
  query: string;
  allowCache: boolean;
}) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return [];

  const cacheKey = buildSearchCacheKey({
    lane: "text",
    lat: opts.lat.toFixed(4),
    lng: opts.lng.toFixed(4),
    radius: opts.radiusM,
    q: opts.query.toLowerCase().slice(0, 90),
  });

  if (opts.allowCache && hasRedis()) {
    const cached = await redisGet(cacheKey);
    if (cached) {
      try {
        const arr = JSON.parse(cached);
        if (Array.isArray(arr)) return arr as GoogleCandidate[];
      } catch {}
    }
  }

  // Text Search supports location & radius via "location" + "radius"
  const url =
    `https://maps.googleapis.com/maps/api/place/textsearch/json` +
    `?query=${encodeURIComponent(opts.query)}` +
    `&location=${opts.lat},${opts.lng}` +
    `&radius=${opts.radiusM}` +
    `&key=${key}`;

  const res = await fetchWithTimeout(url, { cache: "no-store" }, 6500);
  if (!res.ok) return [];

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    return [];
  }

  const results = Array.isArray(data?.results) ? data.results : [];
  const out = results
    .map((r: any) => {
      const placeId = r?.place_id;
      const name = r?.name;
      const lat = r?.geometry?.location?.lat;
      const lng = r?.geometry?.location?.lng;
      if (!placeId || !name || typeof lat !== "number" || typeof lng !== "number") return null;
      return { placeId, name, lat, lng } as GoogleCandidate;
    })
    .filter(Boolean) as GoogleCandidate[];

  if (opts.allowCache && hasRedis()) {
    try {
      await redisSetPx(cacheKey, JSON.stringify(out), SEARCH_TTL_MS);
    } catch {}
  }

  return out;
}

/* ---------------- Details parsing (closing time) ---------------- */

function parseHHMM(raw: string) {
  const hh = parseInt(raw.slice(0, 2), 10);
  const mm = parseInt(raw.slice(2), 10);
  return hh * 60 + mm;
}

function formatMinutesToLabel(mins: number) {
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(m).padStart(2, "0");
  return `${h12}:${mm} ${suffix}`;
}

function cityNowFromOffset(tzOffsetSec: number) {
  return new Date(Date.now() + tzOffsetSec * 1000);
}

function getActivePeriodClose(periods: any[], tzOffsetSec: number) {
  if (!Array.isArray(periods) || periods.length === 0) return null;

  const cityNow = cityNowFromOffset(tzOffsetSec);
  const nowDay = cityNow.getUTCDay();
  const nowMinOfDay = cityNow.getUTCHours() * 60 + cityNow.getUTCMinutes();
  const nowW = nowDay * 1440 + nowMinOfDay;
  const WEEK = 7 * 1440;

  // Choose the active period that yields a valid close in the future (smallest minsLeft is fine)
  let best: { minsLeft: number } | null = null;

  for (const p of periods) {
    const oDay = p?.open?.day;
    const oTime = p?.open?.time;
    const cDay = p?.close?.day;
    const cTime = p?.close?.time;

    if (typeof oDay !== "number" || typeof oTime !== "string") continue;
    if (typeof cDay !== "number" || typeof cTime !== "string") continue;

    const openW = oDay * 1440 + parseHHMM(oTime);
    let closeW = cDay * 1440 + parseHHMM(cTime);
    if (closeW <= openW) closeW += WEEK;

    const in1 = openW <= nowW && nowW < closeW;
    const in2 = openW <= nowW + WEEK && nowW + WEEK < closeW;
    if (!in1 && !in2) continue;

    const effectiveNow = in1 ? nowW : nowW + WEEK;
    const minsLeft = closeW - effectiveNow;
    if (minsLeft <= 0) continue;

    if (!best || minsLeft < best.minsLeft) best = { minsLeft };
  }

  if (!best) return null;

  const closeTs = Date.now() + best.minsLeft * 60_000;
  const closeMinOfDay = minutesSinceMidnight(cityNowFromOffset(tzOffsetSec)) + best.minsLeft;
  const closingTimeLabel = formatMinutesToLabel(closeMinOfDay % 1440);

  return { closingTimeLabel, closeTs };
}

function buildPhotoUrls(photos: any[], max = 8) {
  if (!Array.isArray(photos)) return [];
  const refs = photos
    .map((p) => p?.photo_reference)
    .filter((r: any) => typeof r === "string")
    .slice(0, max);
  return refs.map((ref) => `/api/photo?mw=1200&ref=${encodeURIComponent(ref)}`);
}

async function fetchPlaceDetailsById(placeId: string, tzOffsetSec: number) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;

  const cacheKey = `pp:details:${placeId}:${tzOffsetSec}`;

  if (hasRedis()) {
    const cached = await redisGet(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {}
    }
  }

  const detailsUrl =
    `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${placeId}` +
    `&fields=place_id,name,rating,user_ratings_total,price_level,types,opening_hours,business_status,formatted_address,geometry,photos` +
    `&key=${key}`;

  const res = await fetchWithTimeout(detailsUrl, { cache: "no-store" }, 6500);
  if (!res.ok) return null;

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    return null;
  }

  const result = data?.result;
  if (!result?.place_id || !result?.name) return null;

  const hours = result?.opening_hours;
  const periods = hours?.periods ?? [];

  let closingTime: string | null = null;
  let closeTs: number | null = null;

  if (hours?.open_now === true && Array.isArray(periods) && periods.length > 0) {
    const active = getActivePeriodClose(periods, tzOffsetSec);
    if (active) {
      closingTime = active.closingTimeLabel;
      closeTs = active.closeTs;
    }
  }

  const payload = {
    placeId: String(result.place_id),
    name: String(result.name),
    rating: typeof result.rating === "number" ? result.rating : null,
    userRatingsTotal: typeof result.user_ratings_total === "number" ? result.user_ratings_total : null,
    priceLevel: typeof result.price_level === "number" ? result.price_level : null,
    types: Array.isArray(result.types) ? result.types : [],
    openNow: hours?.open_now ?? null, // null => unknown
    businessStatus: result.business_status ?? null,
    closingTime,
    closeTs,
    formattedAddress: result.formatted_address ?? null,
    lat: result.geometry?.location?.lat ?? null,
    lng: result.geometry?.location?.lng ?? null,
    photoUrls: buildPhotoUrls(result.photos ?? [], 8),
  };

  if (hasRedis()) {
    try {
      await redisSetPx(cacheKey, JSON.stringify(payload), DETAILS_TTL_MS);
    } catch {}
  }

  return payload;
}

/* ---------------- GPT: why/watchouts only ---------------- */

async function gptWriteWhyWatchouts(args: {
  city: string;
  vibe: string;
  withWho: string;
  vegFriendly: boolean;
  allowedCategories: string[];
  weatherSummary: string;
  venues: Array<{ placeId: string; name: string; category: string }>;
}) {
  const client = getOpenAIClient();
  if (!client) return null;

  // Keep the prompt small and safe; ensure JSON-only response
  const prompt = `
You write short copy for a local planner app.

STRICT RULES:
- Use only the venues provided (placeId + name + category).
- Do NOT invent venues, do NOT rename venues, do NOT change categories.
- Output ONLY valid JSON array. No markdown, no commentary.

Context:
CITY: ${args.city}
VIBE: ${args.vibe}
WITH: ${args.withWho}
VEG-FRIENDLY (food only): ${args.vegFriendly}
Allowed categories: ${args.allowedCategories.join(", ")}
Weather: ${args.weatherSummary}

Task:
For each venue, write:
- why: 1 sentence (<= 18 words) tying vibe + withWho (and veg if relevant)
- watchouts: 2 short warnings (<= 8 words each), realistic, no repeats

Schema:
[
  {"placeId":"...","why":"...","watchouts":["...","..."]},
  ...
]

Venues:
${args.venues.map((v) => `- ${v.placeId} | ${v.name} | ${v.category}`).join("\n")}
`.trim();

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.5,
    max_tokens: 650,
  });

  const text = completion.choices[0].message.content || "[]";
  const t = text.trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    return arr;
  } catch {
    return null;
  }
}

/* ---------------- Scoring ---------------- */

function vibeStrengthBoost(vibe: string, category: string) {
  const c = (category || "").toLowerCase();
  const v = (vibe || "").toLowerCase();

  if (v === "productive") {
    if (c.includes("library")) return 18;
    if (c.includes("quiet workspace")) return 14;
    if (c.includes("work cafe")) return 12;
    if (c.includes("study")) return 10;
    return 6;
  }

  if (v === "social") {
    if (c.includes("bar")) return 16;
    if (c.includes("activity venue")) return 16;
    if (c.includes("group dining")) return 12;
    if (c.includes("event space")) return 10;
    return 6;
  }

  if (v === "cozy") {
    if (c.includes("tea")) return 14;
    if (c.includes("dessert")) return 12;
    if (c.includes("cafe")) return 10;
    if (c.includes("book")) return 10;
    if (c.includes("wine")) return 10;
    return 6;
  }

  if (v === "outdoors") {
    if (c.includes("waterfront")) return 14;
    if (c.includes("park")) return 12;
    if (c.includes("scenic")) return 12;
    if (c.includes("outdoor market")) return 10;
    if (c.includes("activity")) return 10;
    return 6;
  }

  if (v === "luxury") {
    if (c.includes("fine dining")) return 16;
    if (c.includes("rooftop")) return 14;
    if (c.includes("premium")) return 12;
    if (c.includes("specialty dessert")) return 10;
    return 6;
  }

  return 6;
}

function timeOfDayBoost(cityHour: number, category: string) {
  const c = (category || "").toLowerCase();

  const morning = cityHour >= 6 && cityHour <= 11;
  const afternoon = cityHour >= 12 && cityHour <= 16;
  const evening = cityHour >= 17 && cityHour <= 21;
  const late = cityHour >= 22 || cityHour <= 2;

  let b = 0;

  if (morning) {
    if (c.includes("cafe") || c.includes("tea") || c.includes("dessert")) b += 10;
    if (c.includes("library") || c.includes("study") || c.includes("quiet workspace")) b += 8;
  } else if (afternoon) {
    if (c.includes("cafe") || c.includes("dessert")) b += 6;
    if (c.includes("activity")) b += 6;
    if (c.includes("park") || c.includes("scenic") || c.includes("waterfront") || c.includes("outdoor")) b += 4;
  } else if (evening) {
    if (c.includes("bar") || c.includes("group dining") || c.includes("fine dining") || c.includes("rooftop")) b += 10;
    if (c.includes("event space") || c.includes("activity venue")) b += 6;
  } else if (late) {
    if (c.includes("bar") || c.includes("rooftop") || c.includes("group dining")) b += 8;
    if (c.includes("cafe") || c.includes("library") || c.includes("book")) b -= 6;
    if (c.includes("park") || c.includes("scenic") || c.includes("waterfront")) b -= 10;
  }

  return b;
}

function weatherSoftBoost(flags: any, category: string) {
  const outdoorish = isOutdoorishCategory(category);
  const bad = flags?.precip || flags?.veryCold || flags?.veryWindy;
  if (!bad) return outdoorish ? 4 : 0;
  return outdoorish ? -6 : 6;
}

function scoreOption(
  opt: Option,
  flags: any,
  cityHour: number,
  vibe: string,
  vegFriendly: boolean,
  seenSet: Set<string>,
  swappedSet: Set<string>
) {
  let score = 0;

  score += (opt.rating ?? 4.2) * 10;
  if (opt.userRatingsTotal) score += Math.log10(opt.userRatingsTotal + 1) * 6;

  score += vibeStrengthBoost(vibe, opt.category);
  score += timeOfDayBoost(cityHour, opt.category);
  score += weatherSoftBoost(flags, opt.category);

  const pid = (opt.placeId ?? "").trim();
  if (pid) {
    if (swappedSet.has(pid)) score -= 80; // strong avoid
    else if (seenSet.has(pid)) score -= 35;
  }

  // prefer known open-now a bit, but keep unknown-hours available for swaps
  const openText = String(opt.openStatus || "").toLowerCase();
  if (openText.includes("hours unknown")) score -= 4;

    if (vegFriendly) {
    const cat = (opt.category || "").toLowerCase();
    const foodish =
      cat.includes("dining") ||
      cat.includes("fine dining") ||
      cat.includes("cafe") ||
      cat.includes("dessert") ||
      cat.includes("rooftop") ||
      cat.includes("wine") ||
      cat.includes("bar");
    if (foodish) score += 6;
  }

  score += (Math.random() - 0.5) * 2.6;
  return score;
}

function weightedPick<T extends { _score?: number }>(items: T[]) {
  const temp = 18;
  const weights = items.map((x) => Math.exp(((x._score ?? 0) as number) / temp));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!isFinite(sum) || sum <= 0) return items[0] ?? null;

  let r = Math.random() * sum;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1] ?? null;
}

/* ---------------- Supabase server user (read-only cookies) ---------------- */

async function getSupabaseUserIdOrNull() {
  const cookieStore = await cookies();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnon) return null;

  const supabase = createServerClient(supabaseUrl, supabaseAnon, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set() {},
      remove() {},
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user?.id ?? null;
}

/* ---------------- Feasibility rules ---------------- */

function hardReject(
  opt: Option,
  args: {
    minRemaining: number; // if close known
    allowUnknownHours: boolean;
    maxDistKm: number;
    allowedSet: Set<string>;
    center: { lat: number; lng: number };
    cityNow: Date;
    cityHour: number;
    flags: any;
  }
) {
  if (!args.allowedSet.has(opt.category)) return "vibe_mismatch";

  const openText = String(opt.openStatus || "").toLowerCase();
  if (openText.includes("closed")) return "closed";

  // distance
  const distKm = haversineKm(args.center, { lat: opt.lat, lng: opt.lng });
  if (distKm > args.maxDistKm) return "too_far";

  const minsLeft = minutesUntilClose(args.cityNow, opt.closingTime ?? null, opt.closeTs ?? null);

  // allow unknown hours only for swap pool
  if (minsLeft == null) {
    return args.allowUnknownHours ? null : "unknown_hours";
  }

  if (minsLeft < args.minRemaining) return "closing_soon";

  // Weather guard: never recommend outdoor-ish in bad conditions
  if (isOutdoorishCategory(opt.category)) {
    if (args.flags.precip || args.flags.veryCold || args.flags.veryWindy) return "weather_block";
    if (args.flags.cold && args.cityHour >= 18) return "weather_block";
  }

  return null;
}

/* ---------------- Multi-lane retrieval (fixes swap pool collapse) ---------------- */

function fallbackVibesForSwap(primary: string) {
  // Only used for swap pool abundance; shortlist stays pure.
  // Productive collapses mid-day => allow cozy/chill-ish (mapped through allowed categories anyway)
  if (primary === "Productive") return ["Productive", "Cozy", "Social"];
  if (primary === "Cozy") return ["Cozy", "Productive", "Social"];
  if (primary === "Social") return ["Social", "Cozy", "Luxury"];
  if (primary === "Outdoors") return ["Outdoors", "Social", "Cozy"];
  if (primary === "Luxury") return ["Luxury", "Social", "Cozy"];
  return [primary, "Cozy", "Social"];
}

function buildLaneQueries(vibe: string, vegFriendly: boolean) {
  const allowed = ALLOWED_BY_VIBE[vibe] ?? ALLOWED_BY_VIBE["Social"];

  // Nearby keywords: category keywords + 1 vibe hint
  const baseNearby = allowed.map((c) => KEYWORD_BY_CATEGORY[c] ?? c);

  const nearbyKeywords = [
    ...(vegFriendly
      ? baseNearby.map((kw) => {
          const k = kw.toLowerCase();
          const isFood =
            k.includes("restaurant") ||
            k.includes("fine dining") ||
            k.includes("cafe") ||
            k.includes("dessert") ||
            k.includes("rooftop") ||
            k.includes("wine bar") ||
            k.includes("bar");
          return isFood ? `${kw} vegetarian` : kw;
        })
      : baseNearby),
    `${vibe.toLowerCase()} spots`,
  ]
    .filter(Boolean)
    .slice(0, 8);

  // Text queries (big win for Productive): more semantic keywords
  const baseText: string[] = [];
  if (vibe === "Productive") {
    baseText.push(
      "coworking",
      "study cafe",
      "quiet cafe",
      "work cafe",
      "library",
      "coffee shop laptop",
      "wifi cafe"
    );
  } else if (vibe === "Cozy") {
    baseText.push("cozy cafe", "tea house", "dessert cafe", "bookstore cafe", "quiet cafe");
  } else if (vibe === "Social") {
    baseText.push("cocktail bar", "bar", "fun activity", "arcade", "group dining");
  } else if (vibe === "Outdoors") {
    baseText.push("park", "waterfront", "scenic walk", "outdoor market");
  } else if (vibe === "Luxury") {
    baseText.push("fine dining", "rooftop bar", "tasting menu", "premium lounge");
  }

  const vegText = vegFriendly
    ? [
        "vegetarian restaurant",
        "vegan restaurant",
        "vegetarian cafe",
        "vegan cafe",
        "plant based restaurant",
      ]
    : [];

  const textQueries = Array.from(
    new Set([
      ...vegText,
      ...baseText,
      ...allowed.map((c) => KEYWORD_BY_CATEGORY[c] ?? c),
    ])
  )
    .filter(Boolean)
    .slice(0, 10);

  return { nearbyKeywords, textQueries };
}

async function collectCandidatesMultiLane(args: {
  center: { lat: number; lng: number };
  vibeForLanes: string;
  radiusM: number;
  allowCache: boolean;
  vegFriendly: boolean;
}) {
    const { nearbyKeywords, textQueries } = buildLaneQueries(args.vibeForLanes, args.vegFriendly);

  const nearbyJobs = nearbyKeywords.map((kw) =>
    googleNearbySearch({
      lat: args.center.lat,
      lng: args.center.lng,
      radiusM: args.radiusM,
      keyword: kw,
      allowCache: args.allowCache,
    })
  );

  const textJobs = textQueries.map((q) =>
    googleTextSearch({
      lat: args.center.lat,
      lng: args.center.lng,
      radiusM: args.radiusM,
      query: q,
      allowCache: args.allowCache,
    })
  );

  // Run lanes in parallel but bounded by overall concurrency
  const allJobs = [...nearbyJobs, ...textJobs];
  const results = await mapLimit(allJobs, LANE_CONCURRENCY, async (p) => await p);

  const flat = results.flat();

  // Dedup by placeId
  const seen = new Set<string>();
  const uniq: GoogleCandidate[] = [];
  for (const c of flat) {
    if (!c?.placeId) continue;
    if (seen.has(c.placeId)) continue;
    seen.add(c.placeId);
    uniq.push(c);
  }
  return uniq;
}

/* ---------------- Build Options from candidates (details calls bounded) ---------------- */

async function buildOptionsFromCandidates(args: {
  candidates: GoogleCandidate[];
  tzOffsetSec: number;
  vibe: string;
  allowedSet: Set<string>;
  center: { lat: number; lng: number };
}) {
  // Details are expensive: take closest-ish first using candidate lat/lng
  const sorted = [...args.candidates].sort((a, b) => {
    const da = haversineKm(args.center, { lat: a.lat, lng: a.lng });
    const db = haversineKm(args.center, { lat: b.lat, lng: b.lng });
    return da - db;
  });

  const slice = sorted.slice(0, DETAILS_CAP_TOTAL);

  const detailsList = await mapLimit(slice, DETAILS_CONCURRENCY, async (c) => {
    return await fetchPlaceDetailsById(c.placeId, args.tzOffsetSec);
  });

  const built: Option[] = [];

  for (const d of detailsList) {
    if (!d) continue;
    if (d.businessStatus === "CLOSED_PERMANENTLY") continue;

    // If google explicitly says open_now=false, skip entirely (both shortlist & swap pool)
    if (d.openNow === false) continue;

    const category = googleTypeToInternalCategory(d.types ?? [], args.vibe);
    if (!args.allowedSet.has(category)) continue;

    const lat = typeof d.lat === "number" ? d.lat : args.center.lat;
    const lng = typeof d.lng === "number" ? d.lng : args.center.lng;

    const openStatus =
      d.openNow === true
        ? d.closingTime
          ? `Open now • Closes at ${d.closingTime}`
          : "Open now"
        : "Hours unknown • Check on Maps";

    built.push({
      id: String(d.placeId ?? d.name),
      name: d.name,
      category,
      rating: clamp(typeof d.rating === "number" ? d.rating : 4.4, 4.1, 5.0),
      etaMin: 20,
      openStatus,
      why: "—",
      watchouts: ["Can be busy at peak hours", "Check live hours on Maps"],
      lat,
      lng,
      address: d.formattedAddress ?? "",
      closingTime: d.closingTime ?? null,
      placeId: d.placeId ?? null,
      priceLevel: d.priceLevel ?? null,
      userRatingsTotal: d.userRatingsTotal ?? null,
      closeTs: d.closeTs ?? null,
      photoUrls: Array.isArray(d.photoUrls) ? d.photoUrls : [],
    });
  }

  return built;
}

/* ---------------- Diversity caps for pool (feel abundant & different) ---------------- */

function diversifyPool(items: Option[], maxPerCategory = 6) {
  const counts = new Map<string, number>();
  const out: Option[] = [];
  for (const it of items) {
    const c = it.category || "Other";
    const n = counts.get(c) ?? 0;
    if (n >= maxPerCategory) continue;
    counts.set(c, n + 1);
    out.push(it);
  }
  return out;
}

/* ---------------- API ---------------- */

export async function GET() {
  return NextResponse.json({ ok: true, message: "Use POST to generate a plan." });
}

export async function POST(req: Request) {
  const t0 = Date.now();

  try {
    const h = await headers();

    const googleKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!googleKey) {
      return NextResponse.json({ ok: false, error: "Missing GOOGLE_PLACES_API_KEY." }, { status: 500 });
    }

    // Supabase (auth optional; guest allowed)
    const userId = await getSupabaseUserIdOrNull();
    const identityKey = userId ? `u:${userId}` : getGuestKey(h);
    const mode: "guest" | "auth" = userId ? "auth" : "guest";

    // Rate limiting (Redis-backed)
    const rl = await enforceRateLimit(identityKey, mode);
    if (!rl.ok) {
      return NextResponse.json(
        { ok: false, error: rl.message },
        { status: rl.status, headers: rl.retryAfterSec ? { "retry-after": String(rl.retryAfterSec) } : undefined }
      );
    }

    // Parse + sanitize body
    let body: PlanRequest | null = null;
    try {
      body = (await req.json()) as PlanRequest;
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
    }

    const city = pickDefaultCity(body?.city);
    const vibe = pickDefaultVibe(body?.vibe);
    const withWho = safeString(body?.withWho, "Solo");
    const vegFriendly = safeBool(body?.vegFriendly);

    const seenIds = sanitizeIdList(body?.seenPlaceIds, MAX_SEEN_IDS);
    const swappedIds = sanitizeIdList(body?.swappedPlaceIds, MAX_SWAPPED_IDS);
    const seenSet = new Set(seenIds);
    const swappedSet = new Set(swappedIds);

    const allowedCategories = ALLOWED_BY_VIBE[vibe] ?? ALLOWED_BY_VIBE["Social"];
    const allowedSet = new Set(allowedCategories);
    const center = CITY_CENTERS[city];

    // Weather first (tzOffset drives hour math)
    const weather = await getWeather(city);
    const flags = getWeatherFlags(weather);
    const cityHour = weather?.cityLocalHour ?? new Date().getHours();
    const tzOffsetSec = weather?.tzOffsetSec ?? 0;
    const cityNow = cityLocalNow(tzOffsetSec);

    // Build a "global exclude" for candidate placeIds:
    // - never show swapped again
    // - prefer to avoid seen, but keep as last resort for pool abundance
    const hardExclude = new Set<string>(swappedSet);

    const droppedCounts: Record<string, number> = {};

    // --- Multi-lane retrieval for swap abundance ---
    // We intentionally gather for swap first (bigger radius, extra lanes), then derive shortlist from it.
    const vibeOrder = fallbackVibesForSwap(vibe);

    let allCandidates: GoogleCandidate[] = [];
    for (let i = 0; i < vibeOrder.length; i++) {
      const vLane = vibeOrder[i];

      const candidates = await collectCandidatesMultiLane({
        center,
        vibeForLanes: vLane,
        radiusM: CITY_CENTER_RADIUS_SWAP_M,
        allowCache: true,
        vegFriendly,
      });

      allCandidates = [...allCandidates, ...candidates];

      // If we already have enough candidates, stop early (saves time + quota)
      if (allCandidates.length >= 140) break;
    }

    // Dedup across vibes
    {
      const seen = new Set<string>();
      const uniq: GoogleCandidate[] = [];
      for (const c of allCandidates) {
        if (!c?.placeId) continue;
        if (seen.has(c.placeId)) continue;
        seen.add(c.placeId);
        uniq.push(c);
      }
      allCandidates = uniq;
    }

    // Optional: prioritize not-seen early, but don’t hard drop them (avoid pool collapse)
    allCandidates.sort((a, b) => {
      const as = seenSet.has(a.placeId) ? 1 : 0;
      const bs = seenSet.has(b.placeId) ? 1 : 0;
      if (as !== bs) return as - bs; // not-seen first
      const da = haversineKm(center, { lat: a.lat, lng: a.lng });
      const db = haversineKm(center, { lat: b.lat, lng: b.lng });
      return da - db;
    });

    // Filter out swapped immediately
    const candidatesFiltered = allCandidates.filter((c) => !hardExclude.has(c.placeId));

    // Build options (details calls bounded)
    const built = await buildOptionsFromCandidates({
      candidates: candidatesFiltered,
      tzOffsetSec,
      vibe,
      allowedSet,
      center,
    });

    // Score & base sorting
    const scoredAll = built
            .map((o) => ({ ...o, _score: scoreOption(o, flags, cityHour, vibe, vegFriendly, seenSet, swappedSet) }))
      .sort((a, b) => (b._score ?? 0) - (a._score ?? 0));

    // Dedup by placeId/name
    const deduped: Option[] = [];
    {
      const seenKeys = new Set<string>();
      for (const o of scoredAll) {
        const key = (o.placeId ?? "").trim() || `${o.name.toLowerCase()}|${o.address.toLowerCase()}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        deduped.push(o);
      }
    }

    // -----------------
    // SWAP POOL (abundance-focused)
    // Rules:
    // - openNow != false (handled earlier)
    // - if closing time exists => >=45 min
    // - unknown hours allowed
    // - distance <= 14km
    // - weather blocks outdoor in bad conditions
    // - strongly avoid swapped; softly avoid seen (we already sorted not-seen first)
    // -----------------
    const swapFeasible = deduped.filter((o) => {
      const r = hardReject(o, {
        minRemaining: RELAXED_REMAINING_MIN,
        allowUnknownHours: true,
        maxDistKm: MAX_DIST_KM_SWAP,
        allowedSet,
        center,
        cityNow,
        cityHour,
        flags,
      });
      if (r) {
        droppedCounts[r] = (droppedCounts[r] ?? 0) + 1;
        return false;
      }
      return true;
    });

    // Remove most seen items if we have enough (keeps swaps feeling fresh)
    let swapPool = swapFeasible;
    const swapNotSeen = swapFeasible.filter((o) => !seenSet.has((o.placeId ?? "").trim()));
    if (swapNotSeen.length >= Math.floor(TARGET_SWAP_POOL * 0.7)) {
      swapPool = swapNotSeen;
    }

    // Diversify + cap
    swapPool = diversifyPool(swapPool, 6).slice(0, MAX_POOL_RETURN);

    // -----------------
    // SHORTLIST (quality-focused, unchanged constraints)
    // Final shortlist requires:
    // - openNow=true
    // - known closing time (closeTs or closingTime)
    // - >= 75 min remaining
    // - <= 10km
    // -----------------
    const strictCandidates = deduped.filter((o) => {
      // Must be explicitly open now
      if (!String(o.openStatus || "").toLowerCase().includes("open now")) return false;

      // Must have known close
      const hasClose = Boolean(o.closeTs) || Boolean(o.closingTime);
      if (!hasClose) return false;

      const r = hardReject(o, {
        minRemaining: MIN_REMAINING_MIN,
        allowUnknownHours: false,
        maxDistKm: MAX_DIST_KM_SHORTLIST,
        allowedSet,
        center,
        cityNow,
        cityHour,
        flags,
      });
      if (r) {
        droppedCounts[r] = (droppedCounts[r] ?? 0) + 1;
        return false;
      }
      return true;
    });

    // Pick up to 5 with category cap (<=2 per category), weighted randomness
    const top30 = strictCandidates.slice(0, 30);
    const picked: Option[] = [];
    const catCount = new Map<string, number>();
    const remaining = [...top30];

    while (picked.length < 5 && remaining.length > 0) {
      const candidatesNow = remaining.filter((o) => (catCount.get(o.category || "Other") ?? 0) < 2);
      const poolForPick = candidatesNow.length > 0 ? candidatesNow : remaining;

      const chosen = weightedPick(poolForPick);
      if (!chosen) break;

      picked.push(chosen);
      catCount.set(chosen.category || "Other", (catCount.get(chosen.category || "Other") ?? 0) + 1);

      const chosenKey = (chosen.placeId ?? "").trim() || chosen.name.toLowerCase();
      for (let i = remaining.length - 1; i >= 0; i--) {
        const k = (remaining[i].placeId ?? "").trim() || remaining[i].name.toLowerCase();
        if (k === chosenKey) remaining.splice(i, 1);
      }
    }

    // Ensure not all same category if we can help it
    const uniqueCats = new Set(picked.map((p) => p.category));
    if (picked.length === 5 && uniqueCats.size === 1) {
      const cat0 = picked[0].category;
      const alt = top30.find((o) => o.category !== cat0);
      if (alt) picked[picked.length - 1] = alt;
    }

    const limitedAvailability = picked.length < 5;

    // -------------- GPT copy (why/watchouts) --------------
    // Only for the pool items we return (shortlist + swap pool), to keep prompt small
    const weatherSummary =
      weather?.now ? `${weather.now.temp}°C, ${weather.now.description}, wind ${weather.now.wind} m/s` : "unknown";

    const copyTargets = [...new Map(
      [...picked, ...swapPool]
        .filter((p) => p.placeId)
        .map((p) => [p.placeId as string, p])
    ).values()]
      .slice(0, 28);

    const gptCopy = await gptWriteWhyWatchouts({
      city,
      vibe,
      withWho,
      vegFriendly,
      allowedCategories,
      weatherSummary,
      venues: copyTargets.map((p) => ({ placeId: p.placeId as string, name: p.name, category: p.category })),
    });

    const copyById = new Map<string, { why: string; watchouts: string[] }>();
    if (Array.isArray(gptCopy)) {
      for (const row of gptCopy) {
        const pid = row?.placeId;
        const why = row?.why;
        const watchouts = row?.watchouts;
        if (typeof pid !== "string") continue;
        if (typeof why !== "string") continue;
        if (!Array.isArray(watchouts)) continue;
        copyById.set(pid, {
          why: why.trim(),
          watchouts: watchouts.filter((x: any) => typeof x === "string").slice(0, 2),
        });
      }
    }

    function applyCopy(opt: Option) {
      const pid = (opt.placeId ?? "").trim();
      const copy = pid ? copyById.get(pid) : null;

      opt.why = copy?.why || `Fits a ${vibe} vibe with ${withWho.toLowerCase()}.`;
      opt.watchouts = (copy?.watchouts?.length ? copy.watchouts : ["Can be busy at peak hours", "Check live hours on Maps"]).slice(0, 2);

      // Veg-friendly: only attach warning for food-ish categories
      if (vegFriendly) {
        const cat = (opt.category || "").toLowerCase();
        const foodish =
          cat.includes("dining") ||
          cat.includes("fine dining") ||
          cat.includes("cafe") ||
          cat.includes("dessert") ||
          cat.includes("rooftop") ||
          cat.includes("wine");
        const whyText = String(opt.why || "").toLowerCase();
        if (foodish && !whyText.includes("veget")) {
          opt.watchouts = [opt.watchouts[0] ?? "Can be busy at peak hours", "Veg options not confirmed — check menu."].slice(0, 2);
        }
      }
    }

    for (const o of picked) applyCopy(o);
    for (const o of swapPool) applyCopy(o);

    // Limited availability reason
    let reason: string | null = null;
    if (limitedAvailability) {
      const weatherDrops = allowedCategories.some((c) => isOutdoorishCategory(c)) ? (droppedCounts["weather_block"] ?? 0) : 0;
      const closeDrops = droppedCounts["closing_soon"] ?? 0;
      const unknownDrops = droppedCounts["unknown_hours"] ?? 0;

      if (weatherDrops > 0 && weatherDrops >= Math.max(closeDrops, unknownDrops)) {
        reason = "Weather limits outdoor options right now.";
      } else if (closeDrops > 0 && closeDrops >= Math.max(weatherDrops, unknownDrops)) {
        reason = "Many places close soon right now.";
      } else if (unknownDrops > 0) {
        reason = "Many places don’t have reliable hours right now.";
      } else {
        reason = "Limited matches — try adjusting filters.";
      }
    }

    // Remap shortlist IDs to 1..5 (UI contract)
    const finalOptions = picked.map((o, idx) => ({ ...o, id: String(idx + 1) }));

    function toPublicOption(o: Option) {
      const { _score, ...rest } = o;
      return rest;
    }

    // If swap pool is still tiny, let the client know (but keep options quality intact)
    const poolIsSmall = swapPool.length < 10;

    const ms = Date.now() - t0;

    return NextResponse.json({
      ok: true,
      options: finalOptions.map(toPublicOption),
      weather,
      meta: {
        limitedAvailability: limitedAvailability || poolIsSmall,
        reason: poolIsSmall && !limitedAvailability ? "Swaps are limited right now — try again shortly." : reason,
        pool: swapPool.map(toPublicOption),
        // (You can delete this if you don’t want it; it doesn’t break UI)
        // perf: { ms, detailsUsed: Math.min(candidatesFiltered.length, DETAILS_CAP_TOTAL), candidates: allCandidates.length },
      },
    });
  } catch (error) {
    console.error("PLAN ERROR:", error);
    return NextResponse.json({ ok: false, error: "Plan generation failed." }, { status: 500 });
  }
}