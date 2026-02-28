"use client";

import { supabase } from "@/lib/supabaseClient";

import React from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();

  return (
    <main style={{ position: "relative", height: "100dvh", width: "100%", overflow: "hidden", background: "linear-gradient(135deg, #edfdf6 0%, #fafafa 45%, #f0efff 100%)", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300&family=DM+Serif+Display:ital@0;1&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }

        .root {
          position: relative; height: 100dvh; display: flex; flex-direction: column;
          max-width: 1400px; margin: 0 auto;
          padding: clamp(12px, 2vh, 22px) clamp(20px, 3vw, 48px) clamp(8px, 1.5vh, 16px);
        }
        .hdr { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; margin-bottom: clamp(10px, 2vh, 20px); }
        .brand { display: flex; align-items: center; gap: 10px; }
        .logo-wrap { position: relative; width: clamp(32px, 3vw, 42px); height: clamp(32px, 3vw, 42px); flex-shrink: 0; }
        .logo-bg { position: absolute; inset: 0; border-radius: clamp(8px, 1vw, 12px); background: linear-gradient(145deg, #059669, #10b981); box-shadow: 0 6px 20px rgba(16,185,129,0.38); }
        .logo-ring { position: absolute; inset: 25%; border-radius: 50%; border: 1.5px solid rgba(255,255,255,0.6); }
        .logo-dot { position: absolute; inset: 38%; border-radius: 50%; background: rgba(255,255,255,0.75); }
        .brand-name { font-family: 'DM Serif Display', serif; font-size: clamp(18px, 1.8vw, 26px); color: #0f172a; letter-spacing: -0.3px; }
        .hdr-sign { font-size: clamp(12px, 1.1vw, 15px); font-weight: 600; color: #fff; background: #059669; border: none; cursor: pointer; padding: clamp(7px, 0.8vh, 10px) clamp(16px, 1.5vw, 24px); border-radius: 100px; box-shadow: 0 4px 14px rgba(16,185,129,0.35); transition: all .15s; }
        .hdr-sign:hover { background: #047857; transform: translateY(-1px); }

        .grid-wrap { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(10px, 1.5vw, 18px); flex: 1; min-height: 0; }
        .left { display: flex; flex-direction: column; gap: clamp(10px, 1.5vh, 16px); min-height: 0; }
        .card { border-radius: clamp(18px, 2vw, 28px); border: 1px solid rgba(0,0,0,0.07); background: rgba(255,255,255,0.82); box-shadow: 0 20px 60px rgba(0,0,0,0.09), 0 1px 0 rgba(255,255,255,0.9) inset; backdrop-filter: blur(20px); }

        .hero-card { flex: 1.1; display: flex; flex-direction: column; justify-content: center; padding: clamp(20px, 3vh, 36px) clamp(22px, 2.5vw, 40px); }
        .hero-h1 { font-family: 'DM Serif Display', serif; font-size: clamp(2rem, 3.2vw, 3.6rem); line-height: 1.06; color: #0f172a; letter-spacing: -0.5px; margin-bottom: clamp(10px, 1.5vh, 16px); }
        .hero-h1 em { font-style: italic; color: #059669; }
        .hero-sub { font-size: clamp(13px, 1.1vw, 16px); line-height: 1.6; color: #64748b; max-width: 46ch; margin-bottom: clamp(16px, 2.5vh, 28px); }
        .cta-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .cta-primary { font-size: clamp(13px, 1.1vw, 15px); font-weight: 600; color: #fff; background: linear-gradient(135deg, #059669, #0d9488); border: none; cursor: pointer; padding: clamp(10px, 1.3vh, 14px) clamp(20px, 2vw, 30px); border-radius: 100px; box-shadow: 0 8px 24px rgba(16,185,129,0.38); transition: all .18s; }
        .cta-primary:hover { transform: translateY(-1px); box-shadow: 0 12px 28px rgba(16,185,129,0.45); }
        .cta-secondary { font-size: clamp(12px, 1vw, 14px); font-weight: 500; color: #475569; background: rgba(0,0,0,0.04); border: 1px solid rgba(0,0,0,0.09); cursor: pointer; padding: clamp(10px, 1.3vh, 14px) clamp(16px, 1.6vw, 22px); border-radius: 100px; transition: all .15s; }
        .cta-secondary:hover { background: rgba(0,0,0,0.07); }

        .features-card { flex: 1; padding: clamp(16px, 2.5vh, 26px) clamp(18px, 2vw, 30px); display: flex; flex-direction: column; }
        .card-label { display: flex; align-items: center; justify-content: space-between; margin-bottom: clamp(10px, 1.5vh, 16px); }
        .card-label-text { font-size: clamp(10px, 0.85vw, 12.5px); font-weight: 700; color: #94a3b8; letter-spacing: 0.7px; text-transform: uppercase; }
        .pill { display: inline-flex; align-items: center; font-size: clamp(10px, 0.8vw, 12px); font-weight: 600; color: #059669; background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.22); border-radius: 100px; padding: 3px 11px; }
        .features-list { display: flex; flex-direction: column; gap: clamp(7px, 1vh, 11px); flex: 1; }
        .feat-row { display: flex; align-items: center; gap: 12px; padding: clamp(9px, 1.2vh, 14px) clamp(12px, 1.2vw, 18px); border-radius: 14px; background: rgba(248,250,252,0.8); border: 1px solid rgba(0,0,0,0.05); transition: background .15s; }
        .feat-row:hover { background: rgba(240,253,250,0.9); border-color: rgba(16,185,129,0.2); }
        .feat-icon { width: clamp(28px, 2.5vw, 36px); height: clamp(28px, 2.5vw, 36px); border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: clamp(14px, 1.3vw, 18px); }
        .feat-icon.green { background: rgba(16,185,129,0.12); }
        .feat-icon.violet { background: rgba(99,102,241,0.12); }
        .feat-icon.amber { background: rgba(245,158,11,0.12); }
        .feat-title { font-size: clamp(12px, 1vw, 15px); font-weight: 600; color: #1e293b; }
        .feat-desc { font-size: clamp(11px, 0.85vw, 13px); color: #94a3b8; margin-top: 2px; }

        .preview-card { padding: clamp(18px, 2.5vh, 28px) clamp(20px, 2vw, 32px); display: flex; flex-direction: column; min-height: 0; }
        .preview-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: clamp(12px, 2vh, 20px); flex-wrap: wrap; gap: 8px; }
        .preview-title { font-size: clamp(14px, 1.2vw, 17px); font-weight: 700; color: #0f172a; }
        .preview-subtitle { font-size: clamp(11px, 0.85vw, 13px); color: #94a3b8; margin-top: 2px; }
        .vibe-pills { display: flex; gap: 6px; flex-wrap: wrap; }
        .vibe-pill { font-size: clamp(10px, 0.8vw, 12px); font-weight: 500; padding: 3px 10px; border-radius: 100px; border: 1px solid; }
        .vibe-pill.cozy { color: #d97706; background: rgba(245,158,11,0.09); border-color: rgba(245,158,11,0.28); }
        .vibe-pill.solo { color: #6366f1; background: rgba(99,102,241,0.09); border-color: rgba(99,102,241,0.28); }
        .vibe-pill.budget { color: #10b981; background: rgba(16,185,129,0.09); border-color: rgba(16,185,129,0.28); }
        .vibe-pill.night { color: #64748b; background: rgba(100,116,139,0.09); border-color: rgba(100,116,139,0.22); }

        .options-list { display: flex; flex-direction: column; gap: clamp(8px, 1.2vh, 13px); flex: 1; }
        .option-card { padding: clamp(11px, 1.5vh, 16px) clamp(14px, 1.3vw, 20px); border-radius: 16px; border: 1.5px solid rgba(0,0,0,0.07); background: #fff; display: flex; align-items: flex-start; gap: 12px; }
        .option-card:first-child { border-color: rgba(16,185,129,0.3); background: rgba(240,253,250,0.5); }
        .option-badge { width: clamp(24px, 2.2vw, 30px); height: clamp(24px, 2.2vw, 30px); border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: clamp(13px, 1.1vw, 16px); flex-shrink: 0; margin-top: 1px; }
        .option-badge.green { background: rgba(16,185,129,0.12); }
        .option-badge.violet { background: rgba(99,102,241,0.12); }
        .option-badge.amber { background: rgba(245,158,11,0.12); }
        .option-title { font-size: clamp(12px, 1vw, 15px); font-weight: 600; color: #0f172a; }
        .option-desc { font-size: clamp(11px, 0.85vw, 13px); color: #64748b; margin-top: 2px; line-height: 1.4; }
        .option-tag { display: inline-flex; align-items: center; gap: 4px; font-size: clamp(10px, 0.75vw, 12px); font-weight: 500; border-radius: 100px; padding: 2px 9px; margin-top: 6px; }
        .option-tag.warn { color: #b45309; background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.28); }
        .option-tag.maybe { color: #6366f1; background: rgba(99,102,241,0.1); border: 1px solid rgba(99,102,241,0.28); }
        .option-tag.bad { color: #dc2626; background: rgba(220,38,38,0.07); border: 1px solid rgba(220,38,38,0.22); }

        .what-strip { margin-top: clamp(10px, 1.5vh, 16px); padding: clamp(11px, 1.5vh, 16px) clamp(14px, 1.3vw, 20px); border-radius: 16px; background: linear-gradient(90deg, rgba(16,185,129,0.08), rgba(99,102,241,0.08)); border: 1px solid rgba(16,185,129,0.15); display: flex; align-items: center; gap: 10px; }
        .what-strip-icon { font-size: clamp(16px, 1.5vw, 20px); flex-shrink: 0; }
        .what-strip-text { font-size: clamp(11px, 0.9vw, 13.5px); color: #334155; line-height: 1.45; }
        .what-strip-text strong { font-weight: 600; color: #0f172a; }

        .foot { text-align: center; font-size: clamp(10px, 0.8vw, 12px); color: #94a3b8; padding-top: clamp(6px, 1vh, 12px); flex-shrink: 0; }

        .bg-deco { pointer-events: none; position: absolute; inset: 0; overflow: hidden; }
        .blob { position: absolute; border-radius: 50%; filter: blur(80px); }
        .bg-icon { position: absolute; pointer-events: none; opacity: 0.2; }

        @keyframes float { 0%,100% { opacity: 0.18; transform: translateY(0px) rotate(var(--r,0deg)); } 50% { opacity: 0.26; transform: translateY(-6px) rotate(var(--r,0deg)); } }
        .bg-icon { animation: float 5s ease-in-out infinite; }
        .bg-icon:nth-child(6) { animation-delay: 0.7s; animation-duration: 6s; }
        .bg-icon:nth-child(7) { animation-delay: 1.4s; animation-duration: 4.5s; }
        .bg-icon:nth-child(8) { animation-delay: 2.1s; animation-duration: 5.5s; }
        .bg-icon:nth-child(9) { animation-delay: 2.8s; animation-duration: 6.5s; }
        .bg-icon:nth-child(10) { animation-delay: 3.5s; animation-duration: 4.8s; }
        .bg-icon:nth-child(11) { animation-delay: 4.2s; animation-duration: 5.2s; }
        .bg-icon:nth-child(12) { animation-delay: 0.3s; animation-duration: 7s; }

        @media (max-width: 860px) {
          .grid-wrap { grid-template-columns: 1fr; }
          .preview-card { display: none; }
        }
      `}</style>

      {/* Background */}
      <div className="bg-deco" aria-hidden="true">
        <div className="blob" style={{ width: "50vw", height: "40vh", top: "-8vh", left: "-8vw", background: "rgba(16,185,129,0.14)" }} />
        <div className="blob" style={{ width: "40vw", height: "35vh", top: "-5vh", right: "-8vw", background: "rgba(99,102,241,0.12)" }} />
        <div className="blob" style={{ width: "55vw", height: "35vh", bottom: "-12vh", left: "25%", background: "rgba(236,72,153,0.07)" }} />
        <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(0,0,0,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.04) 1px, transparent 1px)", backgroundSize: "56px 56px", opacity: 0.7 }} />

        {/* Sun - top left */}
        <div className="bg-icon" style={{ left: "4%", top: "12%", width: 64, height: 64, ["--r" as string]: "-8deg" }}>
          <svg viewBox="0 0 64 64" fill="none" width="64" height="64">
            <circle cx="32" cy="32" r="10" stroke="#059669" strokeWidth="2.5"/>
            <line x1="32" y1="6" x2="32" y2="14" stroke="#059669" strokeWidth="2.5" strokeLinecap="round"/>
            <line x1="32" y1="50" x2="32" y2="58" stroke="#059669" strokeWidth="2.5" strokeLinecap="round"/>
            <line x1="6" y1="32" x2="14" y2="32" stroke="#059669" strokeWidth="2.5" strokeLinecap="round"/>
            <line x1="50" y1="32" x2="58" y2="32" stroke="#059669" strokeWidth="2.5" strokeLinecap="round"/>
            <line x1="13" y1="13" x2="19" y2="19" stroke="#059669" strokeWidth="2.5" strokeLinecap="round"/>
            <line x1="45" y1="45" x2="51" y2="51" stroke="#059669" strokeWidth="2.5" strokeLinecap="round"/>
            <line x1="51" y1="13" x2="45" y2="19" stroke="#059669" strokeWidth="2.5" strokeLinecap="round"/>
            <line x1="19" y1="45" x2="13" y2="51" stroke="#059669" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
        </div>

        {/* Noodle bowl - top center-left */}
        <div className="bg-icon" style={{ left: "4%", top: "50%", width: 60, height: 60, ["--r" as string]: "5deg" }}>
          <svg viewBox="0 0 64 64" fill="none" width="60" height="60">
            <path d="M18 38h28c-1 10-7 16-14 16s-13-6-14-16Z" stroke="#6366f1" strokeWidth="2.5" strokeLinejoin="round"/>
            <path d="M16 38h32" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round"/>
            <path d="M22 28c5 0 5 7 10 7s5-7 10-7" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round"/>
            <path d="M38 18l9 9" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round"/>
            <path d="M35 20l9 9" stroke="#6366f1" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </div>

        {/* Umbrella + rain - top right */}
        <div className="bg-icon" style={{ right: "3", top: "2%", width: 64, height: 64, ["--r" as string]: "-9deg" }}>
          <svg viewBox="0 0 64 64" fill="none" width="64" height="64">
            <path d="M12 30c4-10 12-16 20-16s16 6 20 16" stroke="#d97706" strokeWidth="2.5" strokeLinecap="round"/>
            <path d="M32 30v18c0 4-3 6-6 6" stroke="#d97706" strokeWidth="2.5" strokeLinecap="round"/>
            <path d="M18 36l-3 6M26 36l-3 6M34 36l-3 6M42 36l-3 6" stroke="#d97706" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
        </div>

        {/* Museum - top right */}
        <div className="bg-icon" style={{ right: "5%", top: "30%", width: 60, height: 60, ["--r" as string]: "7deg" }}>
          <svg viewBox="0 0 64 64" fill="none" width="60" height="60">
            <path d="M12 26L32 14l20 12" stroke="#6366f1" strokeWidth="2.5" strokeLinejoin="round"/>
            <path d="M18 28v20M28 28v20M36 28v20M46 28v20" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round"/>
            <path d="M14 50h36" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
        </div>

        {/* Leaf - left mid */}
        <div className="bg-icon" style={{ left: "6%", top: "70%", width: 56, height: 56, ["--r" as string]: "12deg" }}>
          <svg viewBox="0 0 64 64" fill="none" width="56" height="56">
            <path d="M46 16c-16 2-28 14-30 30 16-2 28-14 30-30Z" stroke="#10b981" strokeWidth="2.5" strokeLinejoin="round"/>
            <path d="M22 44c8-8 16-12 24-14" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
        </div>

        {/* Fancy clothes - bottom left */}
        <div className="bg-icon" style={{ left: "13%", bottom: "10%", width: 60, height: 60, ["--r" as string]: "-12deg" }}>
          <svg viewBox="0 0 64 64" fill="none" width="60" height="60">
            <path d="M32 16a5 5 0 0 1 5 5" stroke="#ec4899" strokeWidth="2.5" strokeLinecap="round"/>
            <path d="M32 16a5 5 0 0 0-5 5L12 32h40L37 21" stroke="#ec4899" strokeWidth="2.5" strokeLinejoin="round"/>
            <rect x="12" y="32" width="40" height="18" rx="3" stroke="#ec4899" strokeWidth="2.5"/>
          </svg>
        </div>

        {/* Party / star - bottom right */}
        <div className="bg-icon" style={{ right: "4%", bottom: "8%", width: 58, height: 58, ["--r" as string]: "10deg" }}>
          <svg viewBox="0 0 64 64" fill="none" width="58" height="58">
            <path d="M32 10l4 12h13l-10 8 4 12-11-8-11 8 4-12-10-8h13Z" stroke="#f59e0b" strokeWidth="2.5" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>

      <div className="root">
        {/* Header */}
        <header className="hdr">
          <div className="brand">
            <div className="logo-wrap">
              <div className="logo-bg" />
              <div className="logo-ring" />
              <div className="logo-dot" />
            </div>
            <span className="brand-name">PocketPlans</span>
          </div>
        </header>

        {/* Two-column grid */}
        <div className="grid-wrap">
          <div className="left">
            {/* Hero card */}
            <div className="card hero-card">
              <h1 className="hero-h1">
                You pick the <em>vibe</em>.<br />
                I'll do the thinking.
              </h1>
              <p className="hero-sub">
                No endless scrolling. No "closed at 5pm" surprises. Tell me your mood
                and I'll hand you clear, ranked options — with the gotchas already flagged.
              </p>
              <div className="cta-row">
                <button
                  className="cta-primary rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium shadow-md transition"
                  onClick={async () => {
                    await supabase.auth.signInWithOAuth({
                      provider: "google",
                      options: {
                        redirectTo: `${window.location.origin}/auth/callback`,
                      },
                    });
                  }}
                >
                  Sign in with Google
                </button>
                <button className="cta-secondary" onClick={() => router.push("/plan")}>Continue as Guest</button>
              </div>
            </div>

            {/* Features card */}
            <div className="card features-card">
              <div className="card-label">
                <span className="card-label-text">Why it works</span>
                <span className="pill">Decision-ready</span>
              </div>
              <div className="features-list">
                <div className="feat-row">
                  <div className="feat-icon green">🌤️</div>
                  <div>
                    <div className="feat-title">Context-aware</div>
                    <div className="feat-desc">Checks time, weather &amp; open hours automatically</div>
                  </div>
                </div>
                <div className="feat-row">
                  <div className="feat-icon violet">⚡</div>
                  <div>
                    <div className="feat-title">Curated suggestions</div>
                    <div className="feat-desc">Handpicked options — no decision fatigue</div>
                  </div>
                </div>
                <div className="feat-row">
                  <div className="feat-icon amber">✅</div>
                  <div>
                    <div className="feat-title">Pros &amp; cons flagged</div>
                    <div className="feat-desc">Honest callouts so you're never caught off-guard</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Preview card */}
          <div className="card preview-card">
            <div className="preview-header">
              <div>
                <div className="preview-title">See it in action</div>
                <div className="preview-subtitle">Here's what a typical plan looks like</div>
              </div>
              <div className="vibe-pills">
                <span className="vibe-pill cozy">Cozy</span>
                <span className="vibe-pill solo">Solo</span>
                <span className="vibe-pill budget">$</span>
                <span className="vibe-pill night">Tonight</span>
              </div>
            </div>

            <div className="options-list">
              {/* ✅ Best match */}
              <div className="option-card">
                <div className="option-badge green">✅</div>
                <div>
                  <div className="option-title">Warm drink + quiet corner</div>
                  <div className="option-desc">Closest spot, cheapest pick. Great for unwinding solo.</div>
                  <span className="option-tag warn">⚠ Busy 6–7pm</span>
                </div>
              </div>
              {/* 🤔 Maybe */}
              <div className="option-card">
                <div className="option-badge violet">🤔</div>
                <div>
                  <div className="option-title">Mini museum wander</div>
                  <div className="option-desc">Calm, indoor-friendly, genuinely interesting. Open till 9.</div>
                  <span className="option-tag maybe">~ 12 min walk</span>
                </div>
              </div>
              {/* ✕ Caution */}
              <div className="option-card">
                <div className="option-badge amber">⚠️</div>
                <div>
                  <div className="option-title">Comfort meal + short stroll</div>
                  <div className="option-desc">Easiest plan. Filling meal then a gentle loop through the park.</div>
                  <span className="option-tag bad">✕ Limited menu tonight</span>
                </div>
              </div>
            </div>

            <div className="what-strip">
              <span className="what-strip-icon">💡</span>
              <div className="what-strip-text">
                <strong>PocketPlans</strong> matches options to your exact moment — and surfaces the things you'd normally find out too late.
              </div>
            </div>
          </div>
        </div>

        <footer className="foot">© {new Date().getFullYear()} PocketPlans · Made for decisive moments</footer>
      </div>
    </main>
  );
}