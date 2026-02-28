// app/plan/Plan.tsx
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Vibe = "Cozy" | "Social" | "Productive" | "Outdoors" | "Luxury";
type With = "Solo" | "Friends" | "Date" | "Family";

type City =
  | "Boston"
  | "New York"
  | "San Francisco"
  | "Chicago"
  | "Seattle"
  | "Austin"
  | "Los Angeles"
  | "Washington DC"
  | "Miami"
  | "Atlanta";

type Option = {
  id: string; // UI id (1..5)
  name: string;
  category: string;
  rating: number;
  openStatus: string;
  why: string;
  watchouts: string[];
  lat: number;
  lng: number;
  address: string;

  placeId?: string | null;
  closingTime?: string | null;
  photoUrls?: string[];
};

type ApiResponse = {
  ok: boolean;
  options: Option[];
  weather?: {
    now?: { temp: number; description: string; wind: number };
    nextHours?: { timeLabel: string; temp: number; description: string; wind: number }[];
    cityLocalHour?: number;
    alerts?: string[];
  };
  meta?: {
    limitedAvailability?: boolean;
    reason?: string | null;
    pool?: Option[]; // swap pool
  };
  error?: string;
};

function clampText(s: string, n = 80) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/* ---------------- Freshness (localStorage) ---------------- */

type FreshnessStore = Record<
  string,
  {
    recentSeen: Array<{ k: string; ts: number }>;
    recentSwapped: Array<{ k: string; ts: number }>;
  }
>;

const LS_KEY = "pp_freshness_v1";
const SEEN_TTL_MS = 36 * 60 * 60 * 1000; // 36h
const SWAP_TTL_MS = 48 * 60 * 60 * 1000; // 48h
const MAX_SEEN = 60;
const MAX_SWAPPED = 60;

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function loadFreshness(): FreshnessStore {
  if (typeof window === "undefined") return {};
  const parsed = safeParse<FreshnessStore>(window.localStorage.getItem(LS_KEY));
  return parsed && typeof parsed === "object" ? parsed : {};
}

function saveFreshness(store: FreshnessStore) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LS_KEY, JSON.stringify(store));
}

function nowMs() {
  return Date.now();
}

function pruneList(list: Array<{ k: string; ts: number }>, ttlMs: number, max: number) {
  const cutoff = nowMs() - ttlMs;
  const kept = list.filter((x) => x && typeof x.k === "string" && typeof x.ts === "number" && x.ts >= cutoff);
  kept.sort((a, b) => b.ts - a.ts);
  return kept.slice(0, max);
}

export default function PlanPage() {
  const router = useRouter();

  function blockLabel(idx: number, fallback: string) {
    if (idx === 0) return "~3h";
    if (idx === 1) return "~6h";
    if (idx === 2) return "~9h";
    if (idx === 3) return "~12h";
    return fallback;
  }

  // ---------- Auth ----------
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userInitial, setUserInitial] = useState<string>("G");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let mounted = true;

    (async () => {
      const { data } = await supabase.auth.getUser();
      const email = data.user?.email ?? null;
      if (!mounted) return;
      setUserEmail(email);
      setUserInitial((email?.[0] ?? "G").toUpperCase());
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const email = session?.user?.email ?? null;
      setUserEmail(email);
      setUserInitial((email?.[0] ?? "G").toUpperCase());
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    setMenuOpen(false);
    router.push("/");
  }

  // ---------- Planner Inputs ----------
  const [vibe, setVibe] = useState<Vibe>("Social");
  const [withWho, setWithWho] = useState<With>("Solo");
  const [city, setCity] = useState<City>("Boston");
  const [vegFriendly, setVegFriendly] = useState(false);

  // ---------- API-backed Results ----------
  const [options, setOptions] = useState<Option[]>([]);
  const [weatherData, setWeatherData] = useState<ApiResponse["weather"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [limitedAvailability, setLimitedAvailability] = useState(false);
  const [metaReason, setMetaReason] = useState<string | null>(null);
  const [hasGenerated, setHasGenerated] = useState(false);

  // pool for swap
  const [pool, setPool] = useState<Option[]>([]);
  const [bannedKeys, setBannedKeys] = useState<Set<string>>(new Set());
  const bannedKeysRef = useRef<Set<string>>(new Set());

  // details panel state
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeOption = useMemo(() => options.find((o) => o.id === activeId) ?? null, [options, activeId]);

  // "Your plan" (up to 2)
  const [picked, setPicked] = useState<Option[]>([]);

  // Toast
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  // ✅ Stable identity helper (never use UI id)
  function optKey(o: Option) {
    const pid = (o.placeId ?? "").trim();
    if (pid) return pid;
    const n = (o.name ?? "").trim().toLowerCase();
    const a = (o.address ?? "").trim().toLowerCase();
    return `${n}||${a}||${city.toLowerCase()}`;
  }

  function getCityFreshnessSets(currentCity: City) {
    const store = loadFreshness();
    const bucket = store[currentCity] ?? { recentSeen: [], recentSwapped: [] };

    bucket.recentSeen = pruneList(bucket.recentSeen, SEEN_TTL_MS, MAX_SEEN);
    bucket.recentSwapped = pruneList(bucket.recentSwapped, SWAP_TTL_MS, MAX_SWAPPED);

    store[currentCity] = bucket;
    saveFreshness(store);

    return {
      seenPlaceIds: bucket.recentSeen.map((x) => x.k),
      swappedPlaceIds: bucket.recentSwapped.map((x) => x.k),
    };
  }

  function markSeen(currentCity: City, keys: string[]) {
    const store = loadFreshness();
    const bucket = store[currentCity] ?? { recentSeen: [], recentSwapped: [] };

    const t = nowMs();
    const existing = new Set(bucket.recentSeen.map((x) => x.k));
    for (const k of keys) {
      if (!k) continue;
      if (existing.has(k)) continue;
      bucket.recentSeen.unshift({ k, ts: t });
    }

    bucket.recentSeen = pruneList(bucket.recentSeen, SEEN_TTL_MS, MAX_SEEN);
    bucket.recentSwapped = pruneList(bucket.recentSwapped, SWAP_TTL_MS, MAX_SWAPPED);

    store[currentCity] = bucket;
    saveFreshness(store);
  }

  function markSwapped(currentCity: City, key: string) {
    if (!key) return;
    const store = loadFreshness();
    const bucket = store[currentCity] ?? { recentSeen: [], recentSwapped: [] };

    const t = nowMs();
    const existing = new Set(bucket.recentSwapped.map((x) => x.k));
    if (!existing.has(key)) bucket.recentSwapped.unshift({ k: key, ts: t });

    bucket.recentSeen = pruneList(bucket.recentSeen, SEEN_TTL_MS, MAX_SEEN);
    bucket.recentSwapped = pruneList(bucket.recentSwapped, SWAP_TTL_MS, MAX_SWAPPED);

    store[currentCity] = bucket;
    saveFreshness(store);
  }

  async function fetchPlan() {
    setHasGenerated(true);
    setLoading(true);

    try {
      const freshness = getCityFreshnessSets(city);

      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city,
          vibe,
          withWho,
          vegFriendly,
          ...freshness,
        }),
      });

      let data: ApiResponse | null = null;
      try {
        data = (await res.json()) as ApiResponse;
      } catch {
        data = null;
      }

      if (!res.ok) {
        if (res.status === 429) {
          setToast(data?.error || "Too many requests — try again in a minute.");
          return;
        }
        if (res.status === 500) {
          setToast(data?.error || "Server error — check env vars / Redis config.");
          return;
        }
        setToast(data?.error || "Couldn’t load plan. Check /api/plan.");
        return;
      }

      const newOptions = data?.options ?? [];
      setOptions(newOptions);
      setWeatherData(data?.weather ?? null);
      setLimitedAvailability(Boolean(data?.meta?.limitedAvailability));
      setMetaReason(data?.meta?.reason ?? null);

      setPool(Array.isArray(data?.meta?.pool) ? data!.meta!.pool! : []);
      const emptyBan = new Set<string>();
      setBannedKeys(emptyBan);
      bannedKeysRef.current = emptyBan;

      const firstOpen =
        newOptions.find((o) => !String(o.openStatus || "").toLowerCase().includes("closed"))?.id ??
        newOptions[0]?.id ??
        null;
      setActiveId(firstOpen);

      const keysToMark = newOptions.map((o) => optKey(o)).filter(Boolean);
      markSeen(city, keysToMark);
    } catch (e) {
      console.error(e);
      setToast("Couldn’t load plan. Check /api/plan.");
    } finally {
      setLoading(false);
    }
  }

  // ---------- Components ----------
  function Pill({
    active,
    children,
    onClick,
  }: {
    active?: boolean;
    children: React.ReactNode;
    onClick: () => void;
  }) {
    return (
      <button onClick={onClick} className={`pp-pill ${active ? "pp-pill-active" : ""}`} type="button">
        {children}
      </button>
    );
  }

  function Toggle({
    label,
    checked,
    onChange,
  }: {
    label: string;
    checked: boolean;
    onChange: (v: boolean) => void;
  }) {
    return (
      <div className="pp-toggle-row">
        <span className="pp-toggle-label">{label}</span>
        <button
          type="button"
          className={`pp-toggle ${checked ? "pp-toggle-on" : ""}`}
          onClick={() => onChange(!checked)}
          aria-pressed={checked}
        >
          <span className="pp-toggle-knob" />
        </button>
      </div>
    );
  }

  function addToPlan(opt: Option) {
    const key = optKey(opt);
    setPicked((prev) => {
      const exists = prev.find((p) => optKey(p) === key);
      if (exists) {
        setToast("Removed from plan");
        return prev.filter((p) => optKey(p) !== key);
      }
      if (prev.length >= 2) {
        setToast("You can only pick 2 stops.");
        return prev;
      }
      setToast("Added to plan ✅");
      return [...prev, opt];
    });
  }

  function removeFromPlan(key: string) {
    setPicked((prev) => prev.filter((p) => optKey(p) !== key));
  }

  // ✅ Swap from pool locally (no regen)
  // ✅ Swap from pool locally (no regen) — with fallback passes
function swapOption(id: string) {
  setOptions((prev) => {
    const idx = prev.findIndex((o) => o.id === id);
    if (idx === -1) {
      setToast("Swap failed — option not found.");
      return prev;
    }

    const removed = prev[idx];
    const removedKey = optKey(removed);

    const used = new Set(prev.filter((o) => optKey(o) !== removedKey).map((o) => optKey(o)));
    const bannedNow = bannedKeysRef.current;

    // Count categories already in shortlist (excluding the removed one)
    const catCount = new Map<string, number>();
    for (const o of prev) {
      if (optKey(o) === removedKey) continue;
      const c = o.category || "Other";
      catCount.set(c, (catCount.get(c) ?? 0) + 1);
    }

    const isClosed = (s: string) => String(s || "").toLowerCase().includes("closed");

    // Base constraints: must not be duplicate, must not be banned, must not be the removed place
    const baseOk = (cand: Option) => {
      const k = optKey(cand);
      if (!k) return false;
      if (k === removedKey) return false;
      if (used.has(k)) return false;
      if (bannedNow.has(k)) return false;
      if (isClosed(cand.openStatus)) return false;
      return true;
    };

    // PASS 1: keep diversity (<= 2 per category)
    const pass1 = pool.find((cand) => {
      if (!baseOk(cand)) return false;
      const c = cand.category || "Other";
      return (catCount.get(c) ?? 0) < 2;
    });

    // PASS 2: relax a bit (<= 3 per category)
    const pass2 = pool.find((cand) => {
      if (!baseOk(cand)) return false;
      const c = cand.category || "Other";
      return (catCount.get(c) ?? 0) < 3;
    });

    // PASS 3: no category cap (still safe: no dupes, no banned, no closed)
    const pass3 = pool.find((cand) => baseOk(cand));

    const next = pass1 ?? pass2 ?? pass3;

    if (!next) {
      setToast("No more swap options right now. Try Generate again.");
      return prev;
    }

    // Only mark swapped out AFTER we actually swap
    markSwapped(city, removedKey);

    // Add swapped-in key to banned set so we don’t re-offer it immediately
    const nextKey = optKey(next);
    setBannedKeys((prevSet) => {
      const s = new Set(prevSet);
      if (nextKey) s.add(nextKey);
      bannedKeysRef.current = s;
      return s;
    });

    const replaced: Option = { ...next, id: removed.id };
    const copy = [...prev];
    copy[idx] = replaced;

    markSeen(city, [optKey(replaced)]);
    setToast("Swapped ✅");
    return copy;
  });
}

  const selectedContextPills = useMemo(() => {
    return [
      { label: vibe, kind: "green" },
      { label: withWho, kind: "violet" },
      { label: city, kind: "blue" },
    ];
  }, [vibe, withWho, city]);

  const mapsQuery = useMemo(() => {
    if (!activeOption) return "";
    return `${activeOption.name} ${activeOption.address} ${city}`;
  }, [activeOption, city]);

  const placeGoogleUrl = useMemo(() => {
    if (!activeOption) return "";
    const pid = (activeOption.placeId ?? "").trim();
    if (pid) return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(pid)}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`;
  }, [activeOption, mapsQuery]);

  const openCount = options.filter((o) => !String(o.openStatus || "").toLowerCase().includes("closed")).length;

  const isLate =
    weatherData?.cityLocalHour != null && (weatherData.cityLocalHour >= 21 || weatherData.cityLocalHour <= 5);

  const showLateHint = limitedAvailability && isLate && openCount <= 2;

  return (
    <main className="pp-page">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Serif+Display:ital@0;1&display=swap');

        :root {
          --bg1: #edfdf6;
          --bg2: #fafafa;
          --bg3: #f0efff;
          --text: #0f172a;
          --muted: #64748b;
          --card: rgba(255,255,255,0.84);
          --border: rgba(0,0,0,0.07);
          --shadow: 0 18px 55px rgba(0,0,0,0.08);
          --emerald: #059669;
          --emeraldDark: #047857;
        }

        * { box-sizing: border-box; }
        html, body { height: 100%; }
        body { margin: 0; font-family: 'DM Sans', system-ui, sans-serif; color: var(--text); }

        .pp-page {
          height: 100dvh;
          min-height: 100dvh;
          width: 100%;
          background: linear-gradient(135deg, var(--bg1) 0%, var(--bg2) 45%, var(--bg3) 100%);
          position: relative;
          padding: clamp(12px, 2vh, 22px) clamp(16px, 3vw, 48px) clamp(14px, 2vh, 20px);
          overflow: hidden;
        }

        .pp-grid {
          position: absolute;
          inset: 0;
          background-image:
            linear-gradient(rgba(0,0,0,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,0,0,0.04) 1px, transparent 1px);
          background-size: 56px 56px;
          opacity: 0.55;
          pointer-events: none;
        }

        .pp-shell {
          height: 100%;
          max-width: 1320px;
          margin: 0 auto;
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 14px;
          min-height: 0;
        }

        .pp-topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-shrink: 0;
        }

        .pp-brand { display: flex; align-items: center; gap: 10px; }
        .pp-logo {
          width: 40px; height: 40px;
          border-radius: 12px;
          background: linear-gradient(145deg, #059669, #10b981);
          box-shadow: 0 6px 20px rgba(16,185,129,0.35);
          position: relative;
          flex-shrink: 0;
        }
        .pp-logo::after { content: ""; position: absolute; inset: 26%; border-radius: 999px; border: 1.5px solid rgba(255,255,255,0.6); }
        .pp-logo::before { content: ""; position: absolute; inset: 39%; border-radius: 999px; background: rgba(255,255,255,0.75); }
        .pp-brand-name { font-family: 'DM Serif Display', serif; font-size: 22px; letter-spacing: -0.2px; }

        .pp-profile-wrap { position: relative; z-index: 9999; }
        .pp-profile {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          border: 1px solid var(--border);
          background: rgba(255,255,255,0.8);
          box-shadow: 0 8px 22px rgba(0,0,0,0.07);
          border-radius: 999px;
          padding: 8px 10px;
          cursor: pointer;
          user-select: none;
        }
        .pp-avatar {
          width: 28px; height: 28px;
          border-radius: 999px;
          background: rgba(16,185,129,0.15);
          color: var(--emerald);
          display: grid;
          place-items: center;
          font-weight: 700;
          font-size: 13px;
        }
        .pp-profile-text {
          font-size: 13px;
          color: #334155;
          font-weight: 600;
          max-width: 220px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pp-caret { opacity: 0.7; font-size: 12px; }

        .pp-menu {
          position: absolute;
          right: 0;
          top: calc(100% + 10px);
          width: 220px;
          border-radius: 14px;
          border: 1px solid var(--border);
          background: #fff;
          box-shadow: 0 20px 55px rgba(0,0,0,0.14);
          padding: 8px;
          z-index: 99999;
        }
        .pp-menu-item {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 10px;
          border-radius: 12px;
          border: none;
          background: transparent;
          cursor: pointer;
          font-weight: 600;
          color: #0f172a;
        }
        .pp-menu-item:hover { background: rgba(0,0,0,0.04); }
        .pp-menu-danger { color: #dc2626; }

        .pp-main {
          flex: 1;
          min-height: 0;
          display: grid;
          grid-template-columns: 420px 1fr;
          gap: 14px;
          overflow: hidden;
        }

        .pp-card {
          border-radius: 26px;
          border: 1px solid var(--border);
          background: var(--card);
          box-shadow: var(--shadow);
          backdrop-filter: blur(18px);
          min-height: 0;
        }

        .pp-left {
          height: 100%;
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 14px;
          overflow: auto;
        }
        .pp-h1 { font-size: 22px; font-family: 'DM Serif Display', serif; margin: 0; }
        .pp-sub { color: var(--muted); margin-top: 6px; font-size: 13px; line-height: 1.5; }
        .pp-section { margin-top: 6px; }
        .pp-label {
          font-size: 11px;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: #94a3b8;
          font-weight: 800;
          margin-bottom: 8px;
        }
        .pp-row { display: flex; flex-wrap: wrap; gap: 8px; }

        .pp-pill {
          border: 1px solid rgba(0,0,0,0.08);
          background: rgba(255,255,255,0.72);
          border-radius: 999px;
          padding: 8px 12px;
          font-size: 13px;
          font-weight: 650;
          color: #334155;
          cursor: pointer;
          transition: transform .12s, background .12s, border-color .12s;
        }
        .pp-pill:hover { transform: translateY(-1px); }
        .pp-pill-active {
          border-color: rgba(16,185,129,0.35);
          background: rgba(16,185,129,0.10);
          color: var(--emerald);
          box-shadow: 0 10px 24px rgba(16,185,129,0.12);
        }

        .pp-select {
          width: 100%;
          border-radius: 14px;
          border: 1px solid rgba(0,0,0,0.08);
          background: rgba(255,255,255,0.78);
          padding: 12px 12px;
          font-size: 13px;
          outline: none;
        }

        .pp-toggle-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }
        .pp-toggle-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 12px 12px;
          border-radius: 16px;
          border: 1px solid rgba(0,0,0,0.06);
          background: rgba(248,250,252,0.72);
        }
        .pp-toggle-label { font-size: 13px; font-weight: 650; color: #0f172a; }
        .pp-toggle {
          width: 44px; height: 26px;
          border-radius: 999px;
          border: 1px solid rgba(0,0,0,0.10);
          background: rgba(0,0,0,0.08);
          cursor: pointer;
          position: relative;
          transition: background .15s, border-color .15s;
        }
        .pp-toggle-on { background: rgba(16,185,129,0.35); border-color: rgba(16,185,129,0.35); }
        .pp-toggle-knob {
          width: 22px; height: 22px;
          border-radius: 999px;
          background: #fff;
          position: absolute;
          top: 50%;
          left: 2px;
          transform: translateY(-50%);
          transition: left .15s;
          box-shadow: 0 8px 18px rgba(0,0,0,0.15);
        }
        .pp-toggle-on .pp-toggle-knob { left: 20px; }

        .pp-generate { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 6px; }
        .pp-gen-btn {
          border-radius: 999px;
          border: 1px solid rgba(0,0,0,0.10);
          background: rgba(0,0,0,0.04);
          padding: 10px 14px;
          font-weight: 800;
          cursor: pointer;
          font-size: 12px;
        }
        .pp-gen-btn.primary {
          background: var(--emerald);
          color: #fff;
          border-color: rgba(16,185,129,0.35);
          box-shadow: 0 10px 26px rgba(16,185,129,0.20);
        }
        .pp-gen-btn.primary:hover { background: var(--emeraldDark); }

        .pp-right {
          height: 100%;
          padding: 18px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          overflow: hidden;
          min-height: 0;
        }

        .pp-right-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
          flex-shrink: 0;
        }
        .pp-right-title { font-size: 20px; font-family: 'DM Serif Display', serif; margin: 0; }
        .pp-right-sub { color: #64748b; font-size: 13px; margin-top: 6px; }

        .pp-context-pills { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
        .pp-mini-pill {
          font-size: 11px;
          font-weight: 700;
          padding: 5px 10px;
          border-radius: 999px;
          border: 1px solid;
          background: #fff;
        }
        .k-green { color: #059669; border-color: rgba(16,185,129,0.28); background: rgba(16,185,129,0.08); }
        .k-violet { color: #6366f1; border-color: rgba(99,102,241,0.28); background: rgba(99,102,241,0.08); }
        .k-blue { color: #2563eb; border-color: rgba(37,99,235,0.22); background: rgba(37,99,235,0.08); }

        .pp-weather {
          border-radius: 18px;
          border: 1px solid rgba(0,0,0,0.06);
          background: linear-gradient(90deg, rgba(16,185,129,0.10), rgba(99,102,241,0.10));
          padding: 12px 14px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          flex-shrink: 0;
        }
        .pp-weather strong { font-size: 13px; }
        .pp-weather span { font-size: 13px; color: #334155; font-weight: 650; }

        .pp-limited {
          border-radius: 14px;
          border: 1px solid rgba(245,158,11,0.25);
          background: rgba(245,158,11,0.08);
          padding: 10px 12px;
          font-size: 13px;
          font-weight: 700;
          color: #b45309;
          flex-shrink: 0;
        }

        .pp-planbar {
          border-radius: 18px;
          border: 1px solid rgba(0,0,0,0.06);
          background: rgba(255,255,255,0.75);
          padding: 12px 14px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
          flex-shrink: 0;
        }
        .pp-planbar-left { display: flex; flex-direction: column; gap: 6px; }
        .pp-planbar-title { font-weight: 900; font-size: 13px; }
        .pp-planbar-sub { color: #64748b; font-size: 12px; }
        .pp-planchips { display: flex; gap: 8px; flex-wrap: wrap; }
        .pp-chip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid rgba(0,0,0,0.08);
          background: rgba(248,250,252,0.9);
          font-size: 12px;
          font-weight: 800;
          color: #0f172a;
        }
        .pp-chip-x {
          border: none;
          background: transparent;
          cursor: pointer;
          font-weight: 900;
          opacity: 0.7;
        }

        .pp-right-body {
          flex: 1;
          min-height: 0;
          display: grid;
          grid-template-columns: 1.15fr 0.85fr;
          gap: 12px;
          overflow: hidden;
        }

        .pp-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
          overflow: auto;
          padding-right: 6px;
          min-height: 0;
        }

        .pp-option {
          border-radius: 18px;
          border: 1.5px solid rgba(0,0,0,0.07);
          background: #fff;
          padding: 14px 14px;
          cursor: pointer;
          transition: transform .12s, border-color .12s, box-shadow .12s;
        }
        .pp-option:hover { transform: translateY(-1px); }
        .pp-option.active {
          border-color: rgba(16,185,129,0.35);
          box-shadow: 0 14px 36px rgba(16,185,129,0.12);
          background: rgba(240,253,250,0.55);
        }

        .pp-option-name { font-weight: 900; font-size: 14px; color: #0f172a; }
        .pp-option-meta { font-size: 12px; color: #64748b; margin-top: 4px; }
        .pp-option-why { font-size: 13px; color: #334155; margin-top: 10px; line-height: 1.4; }

        .pp-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
        .pp-tag {
          font-size: 11px;
          font-weight: 800;
          padding: 5px 10px;
          border-radius: 999px;
          border: 1px solid;
          background: #fff;
        }
        .pp-tag-warn { color: #d97706; border-color: rgba(245,158,11,0.25); background: rgba(245,158,11,0.08); }

        .pp-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
        .pp-btn {
          border-radius: 999px;
          border: 1px solid rgba(0,0,0,0.10);
          background: rgba(0,0,0,0.04);
          padding: 8px 12px;
          font-weight: 900;
          cursor: pointer;
          font-size: 12px;
        }
        .pp-btn-primary {
          background: var(--emerald);
          border-color: rgba(16,185,129,0.35);
          color: #fff;
          box-shadow: 0 10px 26px rgba(16,185,129,0.20);
        }
        .pp-btn-primary:hover { background: var(--emeraldDark); }
        .pp-btn:hover { transform: translateY(-1px); }

        .pp-details {
          border-radius: 18px;
          border: 1px solid rgba(0,0,0,0.07);
          background: rgba(255,255,255,0.82);
          overflow: hidden;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }

        .pp-details-title { font-weight: 950; font-size: 13px; }
        .pp-toast {
          position: fixed;
          left: 50%;
          bottom: 22px;
          transform: translateX(-50%);
          background: rgba(15, 23, 42, 0.92);
          color: #fff;
          border-radius: 999px;
          padding: 10px 14px;
          font-weight: 800;
          font-size: 12px;
          box-shadow: 0 18px 55px rgba(0,0,0,0.25);
          z-index: 999999;
        }

        .pp-empty {
          padding: 30px;
          border-radius: 18px;
          border: 1px dashed rgba(0,0,0,0.12);
          background: rgba(255,255,255,0.6);
          text-align: center;
        }
        .pp-empty-title { font-weight: 900; font-size: 15px; margin-bottom: 6px; }
        .pp-empty-sub { font-size: 13px; color: #64748b; margin-bottom: 12px; }

        @media (max-width: 1100px) {
          .pp-right-body { grid-template-columns: 1fr; }
          .pp-details { display: none; }
        }
        @media (max-width: 980px) {
          .pp-main { grid-template-columns: 1fr; }
        }

        .pp-photo { width: 100%; height: 210px; border: none; background: rgba(0,0,0,0.04); position: relative; }
        .pp-photo-strip { display: flex; gap: 10px; overflow-x: auto; scroll-snap-type: x mandatory; padding: 10px; height: 100%; }
        .pp-photo-strip::-webkit-scrollbar { height: 8px; }
        .pp-photo-strip::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 999px; }
        .pp-photo-img { height: 100%; min-width: 100%; object-fit: cover; border-radius: 14px; scroll-snap-align: start; border: 1px solid rgba(0,0,0,0.06); }
        .pp-photo-empty { height: 210px; display: grid; place-items: center; font-weight: 800; font-size: 13px; color: #64748b; background: rgba(248,250,252,0.8); }

        .pp-linkbtns { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
        .pp-linkbtn {
          width: 100%;
          display: inline-flex;
          align-items: center;
          justify-content: space-between;
          border-radius: 14px;
          border: 1px solid rgba(0,0,0,0.10);
          background: rgba(0,0,0,0.04);
          padding: 10px 12px;
          font-weight: 900;
          font-size: 12px;
          cursor: pointer;
          text-decoration: none;
          color: #0f172a;
        }
        .pp-linkbtn:hover { transform: translateY(-1px); }
        .pp-linkicon { opacity: 0.65; font-weight: 900; }
      
         @media (max-width: 980px) {
          .pp-page {
            height: auto;
            min-height: 100dvh;
            overflow-y: auto;
            overflow-x: hidden;
        }

          .pp-shell {
            height: auto;
            min-height: 0;
          }

          .pp-main {
            overflow: visible;
          }

          .pp-right {
            overflow: visible;
          }
        } 
      `}</style>

      <div className="pp-grid" aria-hidden="true" />
      {toast && <div className="pp-toast">{toast}</div>}

      <div className="pp-shell">
        {/* Top bar */}
        <div className="pp-topbar">
          <div className="pp-brand">
            <div className="pp-logo" />
            <div className="pp-brand-name">PocketPlans</div>
          </div>

          <div className="pp-profile-wrap" ref={menuRef}>
            <div className="pp-profile" role="button" tabIndex={0} onClick={() => setMenuOpen((v) => !v)}>
              <div className="pp-avatar">{userInitial}</div>
              <div className="pp-profile-text">{userEmail ? userEmail.split("@")[0] : "Guest"}</div>
              <div className="pp-caret">▾</div>
            </div>

            {menuOpen && (
              <div className="pp-menu">
                {!userEmail ? (
                  <button className="pp-menu-item" onClick={() => router.push("/")}>
                    Sign in <span>→</span>
                  </button>
                ) : (
                  <>
                    <button
                      className="pp-menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        setToast("Profile settings coming next.");
                      }}
                    >
                      Profile <span>⚙️</span>
                    </button>
                    <button className="pp-menu-item pp-menu-danger" onClick={signOut}>
                      Sign out <span>⎋</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Main */}
        <div className="pp-main">
          {/* Left planner */}
          <section className="pp-card pp-left">
            <div>
              <h1 className="pp-h1">Planner</h1>
              <div className="pp-sub">
                Pick the vibe, with who and we'll do the rest!
              </div>
            </div>

            <div className="pp-section">
              <div className="pp-label">City (limit 10 for now)</div>
              <select className="pp-select" value={city} onChange={(e) => setCity(e.target.value as City)}>
                <option>Boston</option>
                <option>New York</option>
                <option>San Francisco</option>
                <option>Chicago</option>
                <option>Seattle</option>
                <option>Austin</option>
                <option>Los Angeles</option>
                <option>Washington DC</option>
                <option>Miami</option>
                <option>Atlanta</option>
              </select>
            </div>

            <div className="pp-section">
              <div className="pp-label">Vibe (high signal)</div>
              <div className="pp-row">
                {(["Cozy", "Social", "Productive", "Outdoors", "Luxury"] as Vibe[]).map((x) => (
                  <Pill key={x} active={vibe === x} onClick={() => setVibe(x)}>
                    {x}
                  </Pill>
                ))}
              </div>
            </div>

            <div className="pp-section">
              <div className="pp-label">With</div>
              <div className="pp-row">
                {(["Solo", "Friends", "Date", "Family"] as With[]).map((x) => (
                  <Pill key={x} active={withWho === x} onClick={() => setWithWho(x)}>
                    {x}
                  </Pill>
                ))}
              </div>
            </div>

            <div className="pp-section">
              <div className="pp-label">Optional filters</div>
              <div className="pp-toggle-grid">
                <Toggle label="Veg-friendly" checked={vegFriendly} onChange={setVegFriendly} />
              </div>
            </div>

            <div className="pp-generate">
              <button className="pp-gen-btn primary" onClick={fetchPlan} disabled={loading}>
                {loading ? "Generating…" : "Generate"}
              </button>
              <button
                className="pp-gen-btn"
                onClick={() => {
                  setPicked([]);
                  setToast("Plan cleared");
                }}
              >
                Clear Plan
              </button>
            </div>
          </section>

          {/* Right */}
          <section className="pp-card pp-right">
            <div className="pp-right-head">
              <div>
                <h2 className="pp-right-title">Your shortlist</h2>
                <div className="pp-right-sub">{options.length || 0} options — click a card to see details.</div>
              </div>

              <div className="pp-context-pills">
                {selectedContextPills.map((p) => (
                  <span
                    key={p.label}
                    className={`pp-mini-pill ${
                      p.kind === "green" ? "k-green" : p.kind === "violet" ? "k-violet" : "k-blue"
                    }`}
                  >
                    {p.label}
                  </span>
                ))}
              </div>
            </div>

            <div className="pp-weather">
              <strong>Weather</strong>
              {!hasGenerated ? (
                <span>Hit Generate to load forecast</span>
              ) : weatherData?.now ? (
                <span>
                  {weatherData.now.temp}°C • {weatherData.now.description} • Wind {weatherData.now.wind}m/s
                  <br />
                  Forecast (3-hr blocks):{" "}
                  {(weatherData.nextHours ?? []).map((h, idx) => (
                    <span key={idx} style={{ marginRight: 10 }}>
                      {blockLabel(idx, h.timeLabel)} {h.temp}°C
                    </span>
                  ))}
                  {(weatherData.alerts ?? []).length > 0 && (
                    <>
                      <br />
                      <span>
                        {(weatherData.alerts ?? []).map((a, i) => (
                          <span key={i} style={{ marginRight: 10 }}>
                            ⚠ {a}
                          </span>
                        ))}
                      </span>
                    </>
                  )}
                </span>
              ) : (
                <span>Weather unavailable</span>
              )}
            </div>

            {limitedAvailability && (
              <div className="pp-limited">
                {showLateHint
                  ? "It’s late there — fewer places are open right now."
                  : `Limited matches — ${metaReason ?? "Try loosening filters."}`}
              </div>
            )}

            <div className="pp-planbar">
              <div className="pp-planbar-left">
                <div className="pp-planbar-title">Your plan</div>
                <div className="pp-planbar-sub">Pick up to 2 stops.</div>
              </div>
              <div className="pp-planchips">
                {picked.length === 0 ? (
                  <span className="pp-chip" style={{ opacity: 0.7 }}>
                    No stops picked yet
                  </span>
                ) : (
                  picked.map((p) => {
                    const key = optKey(p);
                    return (
                      <span key={key} className="pp-chip">
                        {clampText(p.name, 24)}
                        <button className="pp-chip-x" onClick={() => removeFromPlan(key)} aria-label="Remove">
                          ×
                        </button>
                      </span>
                    );
                  })
                )}
              </div>
            </div>

            <div className="pp-right-body">
              {/* Shortlist */}
              <div className="pp-list">
                {loading ? (
                  <div className="pp-empty">
                    <div className="pp-empty-title">Generating your shortlist…</div>
                    <div className="pp-empty-sub">Finding real places + checking hours.</div>
                  </div>
                ) : !hasGenerated ? (
                  <div className="pp-empty">
                    <div className="pp-empty-title">Ready when you are</div>
                    <div className="pp-empty-sub">Hit Generate to get 5 real options for the next few hours.</div>
                  </div>
                ) : options.filter((o) => !String(o.openStatus || "").toLowerCase().includes("closed")).length === 0 ? (
                  <div className="pp-empty">
                    <div className="pp-empty-title">Nothing open right now</div>
                    <div className="pp-empty-sub">Try another vibe or check again in a bit.</div>
                  </div>
                ) : (
                  options
                    .filter((o) => !String(o.openStatus || "").toLowerCase().includes("closed"))
                    .map((o) => {
                      const isActive = o.id === activeId;
                      const isPicked = picked.some((p) => optKey(p) === optKey(o));
                      const key = `${optKey(o)}-${o.id}`;

                      return (
                        <div
                          key={key}
                          className={`pp-option ${isActive ? "active" : ""}`}
                          onClick={() => setActiveId(o.id)}
                          role="button"
                          tabIndex={0}
                        >
                          <div className="pp-option-name">{o.name}</div>
                          <div className="pp-option-meta">
                            {o.category.charAt(0).toUpperCase() + o.category.slice(1)} • ⭐ {o.rating.toFixed(1)} •{" "}
                            {o.openStatus}
                          </div>

                          <div className="pp-option-why">{o.why}</div>

                          <div className="pp-tags">
                            {(o.watchouts ?? []).slice(0, 2).map((w, idx) => (
                              <span key={`${key}-w-${idx}`} className="pp-tag pp-tag-warn">
                                ⚠ {w}
                              </span>
                            ))}
                          </div>

                          <div className="pp-actions" onClick={(e) => e.stopPropagation()}>
                            <button className={`pp-btn ${isPicked ? "" : "pp-btn-primary"}`} onClick={() => addToPlan(o)}>
                              {isPicked ? "Remove" : "Add to plan"}
                            </button>
                            <button className="pp-btn" onClick={() => swapOption(o.id)}>
                              Swap
                            </button>
                          </div>
                        </div>
                      );
                    })
                )}
              </div>

              {/* Details */}
              <aside className="pp-details" aria-label="Place details">
                {activeOption ? (
                  <>
                    {Array.isArray(activeOption.photoUrls) && activeOption.photoUrls.length > 0 ? (
                      <div className="pp-photo">
                        <div className="pp-photo-strip" aria-label="Place photos">
                          {activeOption.photoUrls.slice(0, 8).map((url, idx) => (
                            <img
                              key={`${activeOption.id}-ph-${idx}`}
                              className="pp-photo-img"
                              src={url}
                              alt={`${activeOption.name} photo ${idx + 1}`}
                              loading="lazy"
                            />
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="pp-photo-empty">Photos not available</div>
                    )}

                    <div className="pp-linkbtns">
                      <a className="pp-linkbtn" href={placeGoogleUrl} target="_blank" rel="noreferrer">
                        View on Google <span className="pp-linkicon">↗</span>
                      </a>
                    </div>
                  </>
                ) : (
                  <div style={{ padding: 16 }}>
                    <div className="pp-details-title">Pick a card</div>
                    <div style={{ color: "#64748b", fontSize: 13, marginTop: 8 }}>
                      Click any option on the left to see details.
                    </div>
                  </div>
                )}
              </aside>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
      

 