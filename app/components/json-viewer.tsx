import React, { useState, useCallback } from "react";

/* ─── JSON Tree Node (recursive) ─── */

const toggleBtnStyle: React.CSSProperties = {
  background: "none", border: "none", cursor: "pointer", color: "#9CA3AF",
  fontSize: 11, padding: 0, fontFamily: "inherit",
};

export function JsonNode({ k, value, depth }: { k?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 1);

  const renderValue = () => {
    if (value === null) return <span style={{ color: "#A78BFA" }}>null</span>;
    if (typeof value === "boolean") return <span style={{ color: "#F59E0B" }}>{String(value)}</span>;
    if (typeof value === "number") return <span style={{ color: "#10B981" }}>{value}</span>;
    if (typeof value === "string") {
      const display = value.length > 120 ? value.slice(0, 120) + "..." : value;
      return <span style={{ color: "#F87171" }}>&quot;{display}&quot;</span>;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return <span style={{ color: "#6B7280" }}>[]</span>;
      return (
        <>
          <button onClick={() => setOpen(!open)} style={toggleBtnStyle}>
            {open ? "\u25BE" : "\u25B8"} [{value.length}]
          </button>
          {open && (
            <div style={{ paddingLeft: 14, borderLeft: "1px solid #334155", marginLeft: 2, marginTop: 2 }}>
              {value.map((item, i) => <JsonNode key={i} k={String(i)} value={item} depth={depth + 1} />)}
            </div>
          )}
        </>
      );
    }

    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return <span style={{ color: "#6B7280" }}>{"{}"}</span>;
      return (
        <>
          <button onClick={() => setOpen(!open)} style={toggleBtnStyle}>
            {open ? "\u25BE" : "\u25B8"} {"{"}
            {entries.length}
            {"}"}
          </button>
          {open && (
            <div style={{ paddingLeft: 14, borderLeft: "1px solid #334155", marginLeft: 2, marginTop: 2 }}>
              {entries.map(([ek, ev]) => <JsonNode key={ek} k={ek} value={ev} depth={depth + 1} />)}
            </div>
          )}
        </>
      );
    }

    return <span style={{ color: "#9CA3AF" }}>{String(value)}</span>;
  };

  return (
    <div style={{ lineHeight: 1.7, fontSize: 11.5, fontFamily: "'SF Mono', Menlo, Consolas, monospace" }}>
      {k !== undefined && <span style={{ color: "#93C5FD" }}>{k}</span>}
      {k !== undefined && <span style={{ color: "#6B7280" }}>: </span>}
      {renderValue()}
    </div>
  );
}

/* ─── Payload Viewer (tree / pretty / raw + search + copy) ─── */

export function PayloadViewer({ rawPayload, title }: { rawPayload: string | null; title?: string }) {
  const [mode, setMode] = useState<"tree" | "formatted" | "raw">("tree");
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState("");

  // Hooks must run on every render — call before any conditional return.
  const handleCopy = useCallback(() => {
    if (!rawPayload) return;
    navigator.clipboard.writeText(rawPayload).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [rawPayload]);

  if (!rawPayload) return <div style={{ padding: 10, color: "#6B7280", fontSize: 12 }}>No payload</div>;

  let parsed: unknown = null;
  let isValid = false;
  try { parsed = JSON.parse(rawPayload); isValid = true; } catch { /* truncated */ }

  const formatted = isValid ? JSON.stringify(parsed, null, 2) : rawPayload;
  const displayText = search
    ? formatted.split("\n").filter((l) => l.toLowerCase().includes(search.toLowerCase())).join("\n")
    : formatted;

  return (
    <div style={{
      background: "#0F172A", borderRadius: 8, overflow: "hidden",
      border: "1px solid #1E293B",
    }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", gap: 6, alignItems: "center", padding: "6px 10px",
        background: "#1E293B", borderBottom: "1px solid #334155", flexWrap: "wrap",
      }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "#64748B", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
          {title || "Payload"}
        </span>
        <div style={{ flex: 1 }} />
        <input
          type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
          style={{
            padding: "3px 8px", fontSize: 11, borderRadius: 4,
            border: "1px solid #475569", background: "#0F172A", color: "#E2E8F0", width: 140,
          }}
        />
        <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: "1px solid #475569" }}>
          {(["tree", "formatted", "raw"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} style={{
              padding: "3px 8px", fontSize: 10, fontWeight: 600, border: "none", cursor: "pointer",
              background: mode === m ? "#3B82F6" : "transparent",
              color: mode === m ? "white" : "#64748B",
            }}>
              {m === "tree" ? "Tree" : m === "formatted" ? "Pretty" : "Raw"}
            </button>
          ))}
        </div>
        <button onClick={handleCopy} style={{
          padding: "3px 8px", fontSize: 10, fontWeight: 600, borderRadius: 4,
          border: "1px solid #475569", background: copied ? "#059669" : "transparent",
          color: copied ? "white" : "#64748B", cursor: "pointer",
        }}>
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      {/* Content */}
      <div style={{ padding: "8px 10px", maxHeight: 400, overflow: "auto", color: "#E2E8F0" }}>
        {mode === "tree" && isValid ? (
          <JsonNode value={parsed} depth={0} />
        ) : mode === "formatted" && isValid ? (
          <pre style={{ margin: 0, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "'SF Mono', Menlo, Consolas, monospace" }}>
            {displayText}
          </pre>
        ) : (
          <pre style={{ margin: 0, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "'SF Mono', Menlo, Consolas, monospace", color: "#94A3B8" }}>
            {displayText}
            {!isValid && (
              <div style={{ marginTop: 8, padding: "4px 8px", background: "#7C2D12", borderRadius: 4, color: "#FED7AA", fontSize: 10 }}>
                Payload was truncated — showing raw text. New webhooks will capture the full payload.
              </div>
            )}
          </pre>
        )}
      </div>
    </div>
  );
}
