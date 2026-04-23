import { useState, useEffect, useCallback } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { login } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};

/* ── Data ── */

const features = [
  {
    icon: "check",
    title: "Automated Approvals",
    desc: "Rule-based return policies that auto-approve or flag returns instantly.",
  },
  {
    icon: "globe",
    title: "Branded Portal",
    desc: "A white-label return portal your customers will love to use.",
  },
  {
    icon: "chart",
    title: "Real-time Analytics",
    desc: "Granular insights on return rates, reasons, and revenue impact.",
  },
  {
    icon: "users",
    title: "Multi-channel Support",
    desc: "Manage returns from Shopify, marketplaces, and your own channels.",
  },
  {
    icon: "sync",
    title: "Fynd Integration",
    desc: "Native sync with Fynd OMS for forward and reverse logistics.",
  },
  {
    icon: "shield",
    title: "Secure & Compliant",
    desc: "Encrypted credentials, JWT auth, and role-based access controls.",
  },
];

/**
 * Feature facts shown in the hero "stats" row. These are **factual
 * product attributes** (feature counts, supported integrations) rather
 * than marketing metrics — Shopify App Store policy prohibits
 * unsubstantiated performance claims like "50% faster" or "3x
 * satisfaction" without verifiable data.
 *
 * Previous values (removed in the April 2026 compliance pass): 50%
 * Faster processing, 3x Customer satisfaction, 99.9% Uptime SLA,
 * 0 Manual interventions. None of these were defensible on review.
 */
const stats = [
  { value: "15", label: "Languages supported" },
  { value: "3", label: "Resolution types" },
  { value: "25+", label: "Portal settings" },
  { value: "REST", label: "Public API" },
];

const steps = [
  {
    step: "01",
    title: "Customer initiates",
    desc: "Customers submit returns through your branded portal — no emails, no tickets.",
  },
  {
    step: "02",
    title: "Rules auto-process",
    desc: "Your return policies auto-approve, flag, or reject based on configurable rules.",
  },
  {
    step: "03",
    title: "Resolve & recover",
    desc: "Process refunds, exchanges, or store credit — track everything in real time.",
  },
];

/* ── Icons ── */

function FeatureIcon({ name }: { name: string }) {
  const props = {
    width: 28,
    height: 28,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "check":
      return (
        <svg {...props}>
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
        </svg>
      );
    case "globe":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
        </svg>
      );
    case "chart":
      return (
        <svg {...props}>
          <path d="M12 20V10M18 20V4M6 20v-4" />
        </svg>
      );
    case "users":
      return (
        <svg {...props}>
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
        </svg>
      );
    case "sync":
      return (
        <svg {...props}>
          <path d="M23 4v6h-6M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
        </svg>
      );
    case "shield":
      return (
        <svg {...props}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    default:
      return null;
  }
}

/* ── Fynd Logo SVG (official wordmark, works on any bg via currentColor) ── */

function FyndLogo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size * 2.8}
      height={size}
      viewBox="0 0 280 100"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M0 20h50v12H14v16h30v12H14v40H0V20z" />
      <path d="M60 44l16 56h2l16-56h14L86 108c-4 12-10 16-22 16h-6v-12h4c6 0 10-2 12-8l2-6-22-54h14z" />
      <path d="M128 44h14v8h1c4-6 10-10 20-10 14 0 22 10 22 26v32h-14V70c0-10-4-16-14-16s-15 8-15 18v28h-14V44z" />
      <path d="M226 44h14v8h1c4-6 12-10 20-10 18 0 28 14 28 34s-10 34-28 34c-8 0-16-4-20-10h-1v30h-14V44zm32 4c-12 0-19 10-19 22s7 22 19 22 19-10 19-22-7-22-19-22z" />
    </svg>
  );
}

/* ── Theme Toggle ── */

type Theme = "light" | "dark" | "system";

function ThemeToggle({
  theme,
  setTheme,
}: {
  theme: Theme;
  setTheme: (t: Theme) => void;
}) {
  const options: { value: Theme; label: string }[] = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "System" },
  ];

  return (
    <div className="theme-toggle">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => setTheme(o.value)}
          className={`theme-toggle-btn ${theme === o.value ? "active" : ""}`}
          aria-label={`Switch to ${o.label} theme`}
          title={o.label}
        >
          {o.value === "light" && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          )}
          {o.value === "dark" && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
            </svg>
          )}
          {o.value === "system" && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          )}
        </button>
      ))}
    </div>
  );
}

/* ── Page ── */

export default function Index() {
  const [theme, setTheme] = useState<Theme>("system");
  const [resolvedDark, setResolvedDark] = useState(true);

  const applyTheme = useCallback((t: Theme) => {
    if (typeof window === "undefined") return;
    let isDark: boolean;
    if (t === "system") {
      isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    } else {
      isDark = t === "dark";
    }
    setResolvedDark(isDark);
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    try { localStorage.setItem("rp-theme", t); } catch {}
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("rp-theme") as Theme | null;
    const initial = saved && ["light", "dark", "system"].includes(saved) ? saved : "system";
    setTheme(initial);
    applyTheme(initial);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if ((localStorage.getItem("rp-theme") || "system") === "system") {
        setResolvedDark(mq.matches);
        document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [applyTheme]);

  const handleTheme = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
  };

  return (
    <div className="landing-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');

        *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

        /* ── Theme Variables ── */
        :root, [data-theme="dark"] {
          --bg:              #09090b;
          --bg-elevated:     #18181b;
          --text-primary:    #fafafa;
          --text-secondary:  #a1a1aa;
          --text-tertiary:   #71717a;
          --text-quaternary: #52525b;
          --text-muted:      #3f3f46;
          --border:          rgba(255,255,255,0.06);
          --border-hover:    rgba(255,255,255,0.12);
          --card-bg:         rgba(255,255,255,0.03);
          --card-bg-hover:   rgba(255,255,255,0.06);
          --nav-bg:          rgba(9,9,11,0.8);
          --accent:          #4E52F2;
          --accent-light:    #818cf8;
          --accent-bg:       rgba(78,82,242,0.1);
          --accent-border:   rgba(78,82,242,0.2);
          --accent-glow:     rgba(78,82,242,0.3);
          --cta-bg:          #fafafa;
          --cta-text:        #09090b;
          --cta-shadow:      rgba(255,255,255,0.1);
          --orb-1:           rgba(78,82,242,0.15);
          --orb-2:           rgba(80,192,254,0.1);
          --icon-bg:         rgba(78,82,242,0.1);
          --chroma-base:     #fafafa;
          --logo-filter:     brightness(0) invert(1);
          --toggle-bg:       rgba(255,255,255,0.06);
          --toggle-active:   rgba(255,255,255,0.12);
        }

        [data-theme="light"] {
          --bg:              #ffffff;
          --bg-elevated:     #f4f4f5;
          --text-primary:    #09090b;
          --text-secondary:  #52525b;
          --text-tertiary:   #71717a;
          --text-quaternary: #a1a1aa;
          --text-muted:      #d4d4d8;
          --border:          rgba(0,0,0,0.07);
          --border-hover:    rgba(0,0,0,0.14);
          --card-bg:         rgba(0,0,0,0.02);
          --card-bg-hover:   rgba(0,0,0,0.04);
          --nav-bg:          rgba(255,255,255,0.85);
          --accent:          #4E52F2;
          --accent-light:    #6366f1;
          --accent-bg:       rgba(78,82,242,0.08);
          --accent-border:   rgba(78,82,242,0.15);
          --accent-glow:     rgba(78,82,242,0.2);
          --cta-bg:          #09090b;
          --cta-text:        #fafafa;
          --cta-shadow:      rgba(0,0,0,0.15);
          --orb-1:           rgba(78,82,242,0.08);
          --orb-2:           rgba(80,192,254,0.06);
          --icon-bg:         rgba(78,82,242,0.08);
          --chroma-base:     #09090b;
          --logo-filter:     none;
          --toggle-bg:       rgba(0,0,0,0.04);
          --toggle-active:   rgba(0,0,0,0.08);
        }

        /* ── Animations ── */
        @keyframes chromaSweep {
          0%   { background-position: 100% 50%; filter: blur(1px); }
          100% { background-position: 0% 50%;   filter: blur(0); }
        }
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(24px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulseGlow {
          0%, 100% { opacity: 0.4; }
          50%      { opacity: 0.7; }
        }

        /* ── Base ── */
        .landing-root {
          min-height: 100vh;
          background: var(--bg);
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          color: var(--text-primary);
          overflow-x: hidden;
          transition: background 0.3s ease, color 0.3s ease;
        }

        /* ── Chroma text ── */
        .chroma-text {
          background-image: linear-gradient(90deg,
            var(--chroma-base) 0%, var(--chroma-base) 33.33%,
            #4E52F2 40%, #DD9DFF 45%, #E3A4A8 50%,
            #50C0FE 55%, #1E31FC 60%,
            transparent 66.67%, transparent
          );
          background-size: 300% 100%;
          background-clip: text;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: chromaSweep 2s ease-in-out forwards;
        }

        /* ── Fade-in classes ── */
        .fade-in    { animation: fadeInUp 0.8s ease-out forwards; }
        .fade-in-d1 { animation: fadeInUp 0.8s ease-out 0.15s forwards; opacity: 0; }
        .fade-in-d2 { animation: fadeInUp 0.8s ease-out 0.3s forwards;  opacity: 0; }
        .fade-in-d3 { animation: fadeInUp 0.8s ease-out 0.45s forwards; opacity: 0; }
        .fade-in-d4 { animation: fadeInUp 0.8s ease-out 0.6s forwards;  opacity: 0; }

        /* ── Nav ── */
        .landing-nav {
          position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
          backdrop-filter: blur(16px) saturate(180%);
          -webkit-backdrop-filter: blur(16px) saturate(180%);
          background: var(--nav-bg);
          border-bottom: 1px solid var(--border);
          transition: background 0.3s ease;
        }
        .nav-inner {
          max-width: 1200px; margin: 0 auto; padding: 0 40px;
          height: 64px; display: flex; align-items: center; justify-content: space-between;
        }
        .nav-left { display: flex; align-items: center; gap: 32px; }
        .nav-brand { display: flex; align-items: center; gap: 10px; text-decoration: none; color: var(--text-primary); }
        .nav-brand-icon {
          width: 28px; height: 28px; border-radius: 7px;
          background: linear-gradient(135deg, #4E52F2, #50C0FE);
          flex-shrink: 0;
        }
        .nav-brand span { font-size: 18px; font-weight: 800; letter-spacing: -0.04em; }
        .nav-links { display: flex; gap: 28px; margin-left: 16px; }
        .nav-link {
          color: var(--text-secondary); text-decoration: none;
          font-size: 14px; font-weight: 500; letter-spacing: -0.01em;
          transition: color 0.2s ease;
        }
        .nav-link:hover { color: var(--text-primary); }
        .nav-right { display: flex; align-items: center; gap: 16px; }

        /* ── Theme Toggle ── */
        .theme-toggle {
          display: flex; border-radius: 8px; padding: 3px;
          background: var(--toggle-bg); gap: 2px;
          transition: background 0.3s ease;
        }
        .theme-toggle-btn {
          display: flex; align-items: center; justify-content: center;
          width: 30px; height: 28px; border: none; border-radius: 6px;
          background: transparent; color: var(--text-tertiary);
          cursor: pointer; transition: all 0.2s ease;
        }
        .theme-toggle-btn:hover { color: var(--text-primary); }
        .theme-toggle-btn.active {
          background: var(--toggle-active); color: var(--text-primary);
        }

        /* ── CTA Buttons ── */
        .cta-primary {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 14px 32px; border-radius: 10px; border: none; cursor: pointer;
          background: var(--cta-bg); color: var(--cta-text);
          font-size: 15px; font-weight: 600; letter-spacing: -0.01em;
          text-decoration: none; transition: all 0.3s ease;
          font-family: inherit;
        }
        .cta-primary:hover {
          opacity: 0.88; transform: translateY(-1px);
          box-shadow: 0 8px 32px var(--cta-shadow);
        }
        .cta-primary.sm { padding: 9px 22px; font-size: 13px; }

        .cta-secondary {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 14px 32px; border-radius: 10px; cursor: pointer;
          background: transparent; color: var(--text-secondary);
          font-size: 15px; font-weight: 500; letter-spacing: -0.01em;
          text-decoration: none; transition: all 0.3s ease;
          border: 1px solid var(--border-hover); font-family: inherit;
        }
        .cta-secondary:hover {
          color: var(--text-primary);
          border-color: var(--accent-glow);
          background: var(--card-bg);
        }

        /* ── Section Label ── */
        .section-label {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 6px 14px; border-radius: 100px;
          background: var(--accent-bg); border: 1px solid var(--accent-border);
          font-size: 13px; font-weight: 500; color: var(--accent-light);
          letter-spacing: 0.02em; margin-bottom: 20px;
        }
        .section-label .dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: #4ade80; display: inline-block;
        }

        /* ── Background Orbs ── */
        .gradient-orb {
          position: absolute; border-radius: 50%; filter: blur(80px);
          animation: pulseGlow 6s ease-in-out infinite; pointer-events: none;
        }

        /* ── Hero ── */
        .hero-section {
          position: relative; min-height: 100vh;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          padding: 140px 40px 100px; text-align: center; overflow: hidden;
        }
        .hero-heading {
          font-size: 4.25rem; font-weight: 800;
          line-height: 1.08; letter-spacing: -0.04em; margin-bottom: 24px;
        }
        .hero-sub {
          font-size: 18px; line-height: 1.6; color: var(--text-secondary);
          max-width: 560px; margin: 0 auto 40px; letter-spacing: -0.01em;
        }

        /* ── Stats ── */
        .stats-row {
          display: flex; justify-content: center; margin-top: 80px;
          border-top: 1px solid var(--border); padding-top: 40px;
        }
        .stat-item { text-align: center; padding: 0 32px; }
        .stat-value {
          font-size: 32px; font-weight: 800; letter-spacing: -0.03em;
          background: linear-gradient(135deg, var(--text-primary), var(--text-secondary));
          background-clip: text; -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }
        .stat-label { font-size: 13px; color: var(--text-tertiary); margin-top: 6px; font-weight: 500; }

        /* ── Section Shared ── */
        .section { padding: 100px 40px; max-width: 1200px; margin: 0 auto; }
        .section-header { text-align: center; margin-bottom: 64px; }
        .section-title {
          font-size: 2.75rem; font-weight: 800;
          letter-spacing: -0.03em; line-height: 1.12; margin-bottom: 16px;
        }
        .section-desc {
          font-size: 17px; color: var(--text-tertiary);
          max-width: 520px; margin: 0 auto; line-height: 1.6;
        }
        .gradient-text {
          background: linear-gradient(135deg, #4E52F2, #50C0FE);
          background-clip: text; -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }

        /* ── Feature Cards ── */
        .features-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
        .feature-card {
          background: var(--card-bg); border: 1px solid var(--border);
          border-radius: 16px; padding: 32px 28px;
          transition: all 0.4s ease; position: relative; overflow: hidden;
        }
        .feature-card::before {
          content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
          background: linear-gradient(90deg, transparent, var(--accent-glow), transparent);
          opacity: 0; transition: opacity 0.4s ease;
        }
        .feature-card:hover {
          background: var(--card-bg-hover); border-color: var(--accent-glow);
          transform: translateY(-4px);
          box-shadow: 0 4px 6px rgba(78,82,242,0.02), 0 12px 24px rgba(78,82,242,0.04), 0 24px 48px rgba(0,0,0,0.08);
        }
        .feature-card:hover::before { opacity: 1; }
        .feature-icon {
          width: 48px; height: 48px; border-radius: 12px;
          background: var(--icon-bg); display: flex; align-items: center; justify-content: center;
          color: var(--accent-light); margin-bottom: 20px;
        }
        .feature-title { font-size: 17px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 8px; }
        .feature-desc { font-size: 14px; color: var(--text-tertiary); line-height: 1.6; }

        /* ── Steps ── */
        .step-card {
          position: relative; padding: 36px 28px; border-radius: 16px;
          background: var(--card-bg); border: 1px solid var(--border);
        }
        .step-number {
          font-size: 48px; font-weight: 900; letter-spacing: -0.04em; line-height: 1; margin-bottom: 16px;
          background: linear-gradient(135deg, var(--accent-glow), rgba(80,192,254,0.15));
          background-clip: text; -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }
        .step-title { font-size: 18px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 10px; }
        .step-desc { font-size: 14px; color: var(--text-tertiary); line-height: 1.6; }

        /* ── CTA Section ── */
        .cta-section { padding: 100px 40px; text-align: center; position: relative; overflow: hidden; }
        .cta-heading {
          font-size: 3rem; font-weight: 800; letter-spacing: -0.04em;
          line-height: 1.1; margin-bottom: 18px;
        }
        .cta-desc {
          font-size: 17px; color: var(--text-tertiary);
          max-width: 480px; margin: 0 auto 36px; line-height: 1.6;
        }
        .cta-row { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; }

        /* ── Powered by Fynd ── */
        .powered-by {
          display: flex; align-items: center; justify-content: center; gap: 12px;
          padding: 48px 40px 0; color: var(--text-tertiary); font-size: 14px;
        }
        .powered-by .fynd-logo { color: var(--text-secondary); transition: color 0.2s ease; }
        .powered-by a:hover .fynd-logo { color: var(--text-primary); }

        /* ── Footer ── */
        .landing-footer {
          border-top: 1px solid var(--border); padding: 60px 40px 40px;
          max-width: 1200px; margin: 0 auto;
        }
        .footer-grid {
          display: grid; grid-template-columns: 2fr 1fr 1fr 1fr;
          gap: 64px; margin-bottom: 48px;
        }
        .footer-desc { font-size: 14px; color: var(--text-quaternary); line-height: 1.7; max-width: 280px; }
        .footer-col-title {
          font-size: 13px; font-weight: 600; color: var(--text-secondary);
          margin-bottom: 16px; letter-spacing: 0.04em; text-transform: uppercase;
        }
        .footer-links { display: flex; flex-direction: column; gap: 12px; }
        .footer-link {
          color: var(--text-tertiary); text-decoration: none;
          font-size: 14px; transition: color 0.2s ease;
        }
        .footer-link:hover { color: var(--text-secondary); }
        .footer-bottom {
          border-top: 1px solid var(--border); padding-top: 24px;
          display: flex; justify-content: space-between; align-items: center;
          flex-wrap: wrap; gap: 16px;
        }
        .footer-copy { font-size: 13px; color: var(--text-muted); }

        /* ── Responsive ── */
        @media (max-width: 768px) {
          .hero-heading { font-size: 2.5rem !important; }
          .features-grid { grid-template-columns: 1fr !important; }
          .stats-row { flex-direction: column !important; gap: 32px !important; }
          .stat-item { border-right: none !important; }
          .nav-inner { padding: 0 20px !important; }
          .nav-links { display: none !important; }
          .hero-section { padding: 120px 20px 80px !important; }
          .section { padding-left: 20px !important; padding-right: 20px !important; }
          .cta-section { padding-left: 20px !important; padding-right: 20px !important; }
          .cta-row { flex-direction: column !important; align-items: center !important; }
          .footer-grid { grid-template-columns: 1fr !important; gap: 40px !important; }
          .section-title { font-size: 2rem !important; }
          .cta-heading { font-size: 2.25rem !important; }
          .landing-footer { padding-left: 20px !important; padding-right: 20px !important; }
        }
      `}</style>

      {/* ── Navigation ── */}
      <nav className="landing-nav">
        <div className="nav-inner">
          <div className="nav-left">
            <a href="/" className="nav-brand">
              <div className="nav-brand-icon" />
              <span>ReturnPro</span>
            </a>
            <div className="nav-links">
              <a href="#features" className="nav-link">Features</a>
              <a href="#how-it-works" className="nav-link">How it works</a>
              <a href="https://www.fynd.com" target="_blank" rel="noopener noreferrer" className="nav-link">
                Fynd Platform
              </a>
            </div>
          </div>
          <div className="nav-right">
            <ThemeToggle theme={theme} setTheme={handleTheme} />
            <a href="https://apps.shopify.com" target="_blank" rel="noopener noreferrer" className="cta-primary sm">
              Install on Shopify
            </a>
          </div>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="hero-section">
        <div className="gradient-orb" style={{ width: 600, height: 600, top: "-10%", left: "20%", background: `radial-gradient(circle, var(--orb-1), transparent 70%)` }} />
        <div className="gradient-orb" style={{ width: 500, height: 500, bottom: "5%", right: "15%", background: `radial-gradient(circle, var(--orb-2), transparent 70%)`, animationDelay: "3s" }} />

        <div style={{ position: "relative", zIndex: 1, maxWidth: 800 }}>
          <div className="fade-in">
            <span className="section-label">
              <span className="dot" />
              Powered by Fynd
            </span>
          </div>

          <h1 className="hero-heading chroma-text fade-in-d1">
            Returns management, reimagined
          </h1>

          <p className="hero-sub fade-in-d2">
            Automate returns, delight customers, and recover revenue — all from
            a single platform built for Shopify brands that scale.
          </p>

          <div className="cta-row fade-in-d3">
            <a href="https://apps.shopify.com" target="_blank" rel="noopener noreferrer" className="cta-primary">
              Get started free
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </a>
            <a href="#features" className="cta-secondary">
              See how it works
            </a>
          </div>

          <div className="stats-row fade-in-d4">
            {stats.map((s, i) => (
              <div key={i} className="stat-item" style={{ borderRight: i < stats.length - 1 ? "1px solid var(--border)" : "none" }}>
                <div className="stat-value">{s.value}</div>
                <div className="stat-label">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" className="section">
        <div className="section-header">
          <span className="section-label">Features</span>
          <h2 className="section-title">
            Everything you need to manage{" "}
            <span className="gradient-text">returns at scale</span>
          </h2>
          <p className="section-desc">
            From automated approvals to real-time analytics, every tool
            your operations team needs in one place.
          </p>
        </div>
        <div className="features-grid">
          {features.map((f, i) => (
            <div key={i} className="feature-card">
              <div className="feature-icon">
                <FeatureIcon name={f.icon} />
              </div>
              <h3 className="feature-title">{f.title}</h3>
              <p className="feature-desc">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How It Works ── */}
      <section id="how-it-works" className="section">
        <div className="section-header">
          <span className="section-label">How it works</span>
          <h2 className="section-title">Three steps to effortless returns</h2>
        </div>
        <div className="features-grid">
          {steps.map((s, i) => (
            <div key={i} className="step-card">
              <div className="step-number">{s.step}</div>
              <h3 className="step-title">{s.title}</h3>
              <p className="step-desc">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="cta-section">
        <div className="gradient-orb" style={{ width: 800, height: 400, top: "50%", left: "50%", transform: "translate(-50%, -50%)", background: `radial-gradient(ellipse, var(--orb-1), transparent 70%)` }} />
        <div style={{ position: "relative", zIndex: 1 }}>
          <h2 className="cta-heading">
            Ready to transform your<br />returns experience?
          </h2>
          <p className="cta-desc">
            Join brands that trust ReturnPro to automate returns, reduce costs,
            and keep customers coming back.
          </p>
          <div className="cta-row">
            <a href="https://apps.shopify.com" target="_blank" rel="noopener noreferrer" className="cta-primary">
              Install free on Shopify
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </a>
            <a href="https://www.fynd.com" target="_blank" rel="noopener noreferrer" className="cta-secondary">
              Learn about Fynd
            </a>
          </div>
        </div>
      </section>

      {/* ── Powered by Fynd ── */}
      <div className="powered-by">
        <span>Powered by</span>
        <a href="https://www.fynd.com" target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex" }}>
          <span className="fynd-logo"><FyndLogo size={18} /></span>
        </a>
      </div>

      {/* ── Footer ── */}
      <footer className="landing-footer">
        <div className="footer-grid">
          <div>
            <a href="/" className="nav-brand" style={{ marginBottom: 16, display: "inline-flex" }}>
              <div className="nav-brand-icon" style={{ width: 24, height: 24, borderRadius: 6 }} />
              <span style={{ fontSize: 16 }}>ReturnPro</span>
            </a>
            <p className="footer-desc">
              Enterprise-grade returns management for Shopify stores, powered by Fynd.
            </p>
          </div>
          <div>
            <h4 className="footer-col-title">Product</h4>
            <div className="footer-links">
              <a href="#features" className="footer-link">Features</a>
              <a href="#how-it-works" className="footer-link">How it works</a>
              <a href="https://apps.shopify.com" target="_blank" rel="noopener noreferrer" className="footer-link">Shopify App Store</a>
            </div>
          </div>
          <div>
            <h4 className="footer-col-title">Platform</h4>
            <div className="footer-links">
              <a href="https://www.fynd.com" target="_blank" rel="noopener noreferrer" className="footer-link">Fynd Commerce</a>
              <a href="https://platform.fynd.com" target="_blank" rel="noopener noreferrer" className="footer-link">Fynd Platform</a>
              <a href="https://www.fynd.com/careers" target="_blank" rel="noopener noreferrer" className="footer-link">Careers</a>
            </div>
          </div>
          <div>
            <h4 className="footer-col-title">Legal</h4>
            <div className="footer-links">
              <a href="/privacy" className="footer-link">Privacy Policy</a>
              <a href="/terms" className="footer-link">Terms of Service</a>
              <a href="https://www.linkedin.com/company/gofynd" target="_blank" rel="noopener noreferrer" className="footer-link">LinkedIn</a>
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <span className="footer-copy">
            &copy; {new Date().getFullYear()} ReturnPro by Shopsense Retail Technologies
          </span>
          <span className="footer-copy">Invented in India</span>
        </div>
      </footer>
    </div>
  );
}
