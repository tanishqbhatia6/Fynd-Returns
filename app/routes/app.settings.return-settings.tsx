import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseJsonArray } from "../lib/parse-json";
import { parseReturnIdConfig, previewReturnRequestId, DEFAULT_RETURN_ID_CONFIG } from "../lib/return-request-id";
import type { ReturnIdConfig, ReturnIdBodyMode } from "../lib/return-request-id";
import { findOrCreateShop } from "../lib/shop.server";
import { fetchAllLocations } from "../lib/shopify-admin.server";
import type { ShopLocation } from "../lib/shopify-admin.server";
import { inferPresetFromStatuses, getStatusesForPreset, PRESET_LABELS } from "../lib/refund-gate-presets";
import type { RefundGatePreset } from "../lib/refund-gate-presets";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);
  const s = shop.settings;
  const tags = parseJsonArray<string>(s?.restrictedProductTagsJson ?? null, []);
  let shopLocations: ShopLocation[] = [];
  try {
    shopLocations = await fetchAllLocations(admin);
  } catch { /* non-fatal */ }

  const refundLocationMode = s?.refundLocationMode ?? "auto";
  const refundLocationId = s?.refundLocationId ?? null;
  const refundPaymentMethod = s?.refundPaymentMethod ?? "original";
  const refundStoreCreditPct = s?.refundStoreCreditPct ?? 100;

  const discountCodeRefundEnabled = s?.discountCodeRefundEnabled ?? false;
  const discountCodePrefix = s?.discountCodePrefix ?? "RETURN";
  const discountCodeExpiryDays = s?.discountCodeExpiryDays ?? 90;

  return {
    noReturnPeriodEnabled: s?.noReturnPeriodEnabled ?? false,
    noReturnPeriodStart: s?.noReturnPeriodStart ? new Date(s.noReturnPeriodStart).toISOString().slice(0, 10) : "",
    noReturnPeriodEnd: s?.noReturnPeriodEnd ? new Date(s.noReturnPeriodEnd).toISOString().slice(0, 10) : "",
    restrictedProductTags: tags,
    photoRequired: s?.photoRequired ?? false,
    returnFeeAmount: s?.returnFeeAmount != null ? String(s.returnFeeAmount) : "0",
    returnFeeCurrency: s?.returnFeeCurrency ?? "USD",
    autoApproveEnabled: s?.autoApproveEnabled ?? false,
    autoRefundEnabled: s?.autoRefundEnabled ?? false,
    refundLocationMode,
    refundLocationId,
    refundPaymentMethod,
    refundStoreCreditPct,
    shopLocations,
    discountCodeRefundEnabled,
    discountCodePrefix,
    discountCodeExpiryDays,
    portalExchangeEnabled: s?.portalExchangeEnabled ?? false,
    portalAllowedFulfillmentStatuses: (() => {
      try { return s?.portalAllowedFulfillmentStatuses ? JSON.parse(s.portalAllowedFulfillmentStatuses) as string[] : ["FULFILLED", "PARTIALLY_FULFILLED"]; }
      catch { return ["FULFILLED", "PARTIALLY_FULFILLED"]; }
    })(),
    fyndConsolidateReturns: s?.fyndConsolidateReturns ?? false,
    fyndConsolidateWindowHours: s?.fyndConsolidateWindowHours ?? 4,
    allowedFyndStatusesForRefund: (() => {
      try { return s?.allowedFyndStatusesForRefund ? JSON.parse(s.allowedFyndStatusesForRefund) as string[] : []; }
      catch { return []; }
    })(),
    refundGatePreset: (() => {
      // If preset is explicitly set, use it
      if (s?.refundGatePreset) return s.refundGatePreset;
      // Migration: infer preset from existing statuses for shops that had the old raw config
      try {
        const statuses = s?.allowedFyndStatusesForRefund ? JSON.parse(s.allowedFyndStatusesForRefund) as string[] : [];
        return inferPresetFromStatuses(statuses);
      } catch { return "none"; }
    })() as string,
    allowedFyndStatusesForReturn: (() => {
      try { return s?.allowedFyndStatusesForReturn ? JSON.parse(s.allowedFyndStatusesForReturn) as string[] : []; }
      catch { return []; }
    })(),
    returnIdConfig: parseReturnIdConfig(s?.returnIdConfigJson as string | null),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const noReturnPeriodEnabled = formData.get("noReturnPeriodEnabled") === "on";
  const noReturnPeriodStart = formData.get("noReturnPeriodStart") as string | null;
  const noReturnPeriodEnd = formData.get("noReturnPeriodEnd") as string | null;
  const restrictedProductTagsJson = formData.get("restrictedProductTagsJson") as string | null;
  const photoRequired = (formData.get("photoRequired") as string) === "on";
  const returnFeeAmount = Math.max(0, parseFloat(String(formData.get("returnFeeAmount") ?? "0")) || 0);
  const returnFeeCurrency = String(formData.get("returnFeeCurrency") ?? "USD").trim() || "USD";
  const autoApproveEnabled = formData.get("autoApproveEnabled") === "on";
  const autoRefundEnabled = formData.get("autoRefundEnabled") === "on";
  const refundLocationMode = (formData.get("refundLocationMode") as string) ?? "auto";
  const refundLocationId = (formData.get("refundLocationId") as string | null) || null;
  const refundPaymentMethod = (formData.get("refundPaymentMethod") as string) ?? "original";
  const refundStoreCreditPct = Math.min(100, Math.max(0, parseInt(String(formData.get("refundStoreCreditPct") ?? "100"), 10) || 100));
  const discountCodeRefundEnabled = formData.get("discountCodeRefundEnabled") === "on";
  const discountCodePrefix = (formData.get("discountCodePrefix") as string | null)?.trim() || "RETURN";
  const discountCodeExpiryDays = Math.max(1, parseInt(String(formData.get("discountCodeExpiryDays") ?? "90"), 10) || 90);
  const portalExchangeEnabled = formData.get("portalExchangeEnabled") === "on";
  const portalAllowedFulfillmentStatusesRaw = formData.getAll("portalAllowedFulfillmentStatuses") as string[];
  const portalAllowedFulfillmentStatuses = portalAllowedFulfillmentStatusesRaw.length > 0
    ? JSON.stringify(portalAllowedFulfillmentStatusesRaw)
    : JSON.stringify(["FULFILLED", "PARTIALLY_FULFILLED"]);
  const fyndConsolidateReturns = formData.get("fyndConsolidateReturns") === "on";
  const fyndConsolidateWindowHours = [1, 4, 8, 24].includes(parseInt(String(formData.get("fyndConsolidateWindowHours") ?? "4"), 10))
    ? parseInt(String(formData.get("fyndConsolidateWindowHours")), 10)
    : 4;
  // Refund gate preset + compute allowed statuses
  const refundGatePreset = (formData.get("refundGatePreset") as string | null) ?? "none";
  let allowedFyndStatusesForRefund: string | null;
  if (refundGatePreset === "none") {
    allowedFyndStatusesForRefund = null; // gate disabled
  } else if (refundGatePreset === "custom") {
    // Custom mode — use the raw multi-select values
    const raw = formData.getAll("allowedFyndStatusesForRefund") as string[];
    allowedFyndStatusesForRefund = raw.length > 0
      ? JSON.stringify(raw.map((s) => s.trim().toLowerCase()).filter(Boolean))
      : null;
  } else {
    // Preset — compute from mapping
    const statuses = getStatusesForPreset(refundGatePreset as RefundGatePreset);
    allowedFyndStatusesForRefund = statuses ? JSON.stringify(statuses) : null;
  }
  const allowedFyndStatusesForReturnRaw = formData.getAll("allowedFyndStatusesForReturn") as string[];
  const allowedFyndStatusesForReturn = allowedFyndStatusesForReturnRaw.length > 0
    ? JSON.stringify(allowedFyndStatusesForReturnRaw.map((s) => s.trim().toLowerCase()).filter(Boolean))
    : null; // null = feature disabled, all forward statuses allowed

  // Return ID config
  const returnIdConfigJson = (formData.get("returnIdConfigJson") as string | null) || null;

  const shop = await findOrCreateShop(session.shop);

  let tagsStr: string | undefined;
  try {
    if (restrictedProductTagsJson != null) {
      const arr = JSON.parse(restrictedProductTagsJson) as unknown;
      tagsStr = Array.isArray(arr) ? JSON.stringify(arr) : undefined;
    }
  } catch {
    /* keep existing */
  }

  const noStart = noReturnPeriodEnabled && noReturnPeriodStart && noReturnPeriodStart.trim() ? new Date(noReturnPeriodStart) : null;
  const noEnd = noReturnPeriodEnabled && noReturnPeriodEnd && noReturnPeriodEnd.trim() ? new Date(noReturnPeriodEnd) : null;

  if (noStart && noEnd && noStart > noEnd) {
    return { success: false, error: "No-return period end date must be after the start date." };
  }

  try {
    await prisma.shopSettings.upsert({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        noReturnPeriodEnabled,
        noReturnPeriodStart: noStart,
        noReturnPeriodEnd: noEnd,
        restrictedProductTagsJson: tagsStr,
        photoRequired,
        returnFeeAmount,
        returnFeeCurrency,
        autoApproveEnabled,
        autoRefundEnabled,
        refundLocationMode,
        refundLocationId,
        refundPaymentMethod,
        refundStoreCreditPct,
        discountCodeRefundEnabled,
        discountCodePrefix,
        discountCodeExpiryDays,
        portalExchangeEnabled,
        portalAllowedFulfillmentStatuses,
        fyndConsolidateReturns,
        fyndConsolidateWindowHours,
        allowedFyndStatusesForRefund,
        refundGatePreset,
        allowedFyndStatusesForReturn,
        returnIdConfigJson,
      },
      update: {
        noReturnPeriodEnabled,
        noReturnPeriodStart: noStart,
        noReturnPeriodEnd: noEnd,
        restrictedProductTagsJson: tagsStr ?? undefined,
        photoRequired,
        returnFeeAmount,
        returnFeeCurrency,
        autoApproveEnabled,
        autoRefundEnabled,
        refundLocationMode,
        refundLocationId,
        refundPaymentMethod,
        refundStoreCreditPct,
        discountCodeRefundEnabled,
        discountCodePrefix,
        discountCodeExpiryDays,
        portalExchangeEnabled,
        portalAllowedFulfillmentStatuses,
        fyndConsolidateReturns,
        fyndConsolidateWindowHours,
        allowedFyndStatusesForRefund,
        refundGatePreset,
        allowedFyndStatusesForReturn,
        returnIdConfigJson,
      },
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Failed to save settings." };
  }
};

export default function ReturnSettings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean }>();
  const [tags, setTags] = React.useState<string[]>(data.restrictedProductTags);
  const [tagInput, setTagInput] = React.useState("");
  const [locationMode, setLocationMode] = React.useState<"auto" | "manual">(data.refundLocationMode === "manual" ? "manual" : "auto");
  const [selectedLocId, setSelectedLocId] = React.useState(data.refundLocationId ?? "");
  const [paymentMethod, setPaymentMethod] = React.useState<"original" | "store_credit" | "both" | "discount_code">(
    (["original", "store_credit", "both", "discount_code"].includes(data.refundPaymentMethod) ? data.refundPaymentMethod : "original") as "original" | "store_credit" | "both" | "discount_code"
  );
  const [storeCreditPct, setStoreCreditPct] = React.useState(data.refundStoreCreditPct ?? 100);
  const [photoRequired, setPhotoRequired] = React.useState(data.photoRequired);
  const [autoApproveEnabled, setAutoApproveEnabled] = React.useState(data.autoApproveEnabled);
  const [autoRefundEnabled, setAutoRefundEnabled] = React.useState(data.autoRefundEnabled);
  const [dcEnabled, setDcEnabled] = React.useState(data.discountCodeRefundEnabled);
  const [dcPrefix, setDcPrefix] = React.useState(data.discountCodePrefix);
  const [dcExpiryDays, setDcExpiryDays] = React.useState(data.discountCodeExpiryDays);
  const [noReturnEnabled, setNoReturnEnabled] = React.useState(data.noReturnPeriodEnabled);
  const [portalExchangeEnabled, setPortalExchangeEnabled] = React.useState(data.portalExchangeEnabled);
  const [allowedFulfillStatuses, setAllowedFulfillStatuses] = React.useState<string[]>(data.portalAllowedFulfillmentStatuses);
  const [fyndConsolidateReturns, setFyndConsolidateReturns] = React.useState(data.fyndConsolidateReturns);
  const [fyndConsolidateWindowHours, setFyndConsolidateWindowHours] = React.useState(data.fyndConsolidateWindowHours);
  const [allowedFyndStatuses, setAllowedFyndStatuses] = React.useState<string[]>(data.allowedFyndStatusesForRefund);
  const [fyndStatusGateEnabled, setFyndStatusGateEnabled] = React.useState(data.refundGatePreset !== "none" && data.refundGatePreset !== null);
  const [refundGatePreset, setRefundGatePreset] = React.useState<RefundGatePreset>((data.refundGatePreset ?? "none") as RefundGatePreset);
  const [allowedFyndReturnStatuses, setAllowedFyndReturnStatuses] = React.useState<string[]>(data.allowedFyndStatusesForReturn);
  const [fyndReturnGateEnabled, setFyndReturnGateEnabled] = React.useState(data.allowedFyndStatusesForReturn.length > 0);

  // Return ID config
  const [ridPrefix, setRidPrefix] = React.useState(data.returnIdConfig.prefix);
  const [ridSeparator, setRidSeparator] = React.useState(data.returnIdConfig.separator);
  const [ridBodyMode, setRidBodyMode] = React.useState<ReturnIdBodyMode>(data.returnIdConfig.bodyMode);
  const [ridHashLength, setRidHashLength] = React.useState(data.returnIdConfig.hashLength);
  const [ridSeqPadding, setRidSeqPadding] = React.useState(data.returnIdConfig.sequentialPadding);
  const [ridSuffix, setRidSuffix] = React.useState(data.returnIdConfig.suffix);

  const ridPreview = React.useMemo(() => previewReturnRequestId({
    prefix: ridPrefix, separator: ridSeparator, bodyMode: ridBodyMode,
    hashLength: ridHashLength, sequentialPadding: ridSeqPadding, suffix: ridSuffix,
  }), [ridPrefix, ridSeparator, ridBodyMode, ridHashLength, ridSeqPadding, ridSuffix]);

  React.useEffect(() => {
    setTags(data.restrictedProductTags);
    setLocationMode(data.refundLocationMode === "manual" ? "manual" : "auto");
    setSelectedLocId(data.refundLocationId ?? "");
    setPaymentMethod((["original", "store_credit", "both", "discount_code"].includes(data.refundPaymentMethod) ? data.refundPaymentMethod : "original") as "original" | "store_credit" | "both" | "discount_code");
    setStoreCreditPct(data.refundStoreCreditPct ?? 100);
    setPhotoRequired(data.photoRequired);
    setAutoApproveEnabled(data.autoApproveEnabled);
    setAutoRefundEnabled(data.autoRefundEnabled);
    setDcEnabled(data.discountCodeRefundEnabled);
    setDcPrefix(data.discountCodePrefix);
    setDcExpiryDays(data.discountCodeExpiryDays);
    setNoReturnEnabled(data.noReturnPeriodEnabled);
    setPortalExchangeEnabled(data.portalExchangeEnabled);
    setAllowedFulfillStatuses(data.portalAllowedFulfillmentStatuses);
    setFyndConsolidateReturns(data.fyndConsolidateReturns);
    setFyndConsolidateWindowHours(data.fyndConsolidateWindowHours);
    setAllowedFyndStatuses(data.allowedFyndStatusesForRefund);
    setRefundGatePreset((data.refundGatePreset ?? "none") as RefundGatePreset);
    setFyndStatusGateEnabled(data.refundGatePreset !== "none" && data.refundGatePreset !== null);
    setAllowedFyndReturnStatuses(data.allowedFyndStatusesForReturn);
    setFyndReturnGateEnabled(data.allowedFyndStatusesForReturn.length > 0);
    setRidPrefix(data.returnIdConfig.prefix);
    setRidSeparator(data.returnIdConfig.separator);
    setRidBodyMode(data.returnIdConfig.bodyMode);
    setRidHashLength(data.returnIdConfig.hashLength);
    setRidSeqPadding(data.returnIdConfig.sequentialPadding);
    setRidSuffix(data.returnIdConfig.suffix);
  }, [data.restrictedProductTags, data.refundLocationMode, data.refundLocationId, data.refundPaymentMethod, data.refundStoreCreditPct, data.photoRequired, data.autoApproveEnabled, data.autoRefundEnabled, data.discountCodeRefundEnabled, data.discountCodePrefix, data.discountCodeExpiryDays, data.noReturnPeriodEnabled, data.portalExchangeEnabled, data.portalAllowedFulfillmentStatuses, data.fyndConsolidateReturns, data.fyndConsolidateWindowHours, data.allowedFyndStatusesForRefund, data.refundGatePreset, data.allowedFyndStatusesForReturn, data.returnIdConfig]);

  const addTag = () => {
    const v = tagInput.trim();
    if (v && !tags.includes(v)) {
      setTags([...tags, v]);
      setTagInput("");
    }
  };

  const removeTag = (t: string) => setTags(tags.filter((x) => x !== t));

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    fd.set("restrictedProductTagsJson", JSON.stringify(tags));
    fd.set("photoRequired", photoRequired ? "on" : "off");
    fd.set("autoApproveEnabled", autoApproveEnabled ? "on" : "off");
    fd.set("autoRefundEnabled", autoRefundEnabled ? "on" : "off");
    fd.set("refundLocationMode", locationMode);
    fd.set("refundLocationId", selectedLocId);
    fd.set("refundPaymentMethod", paymentMethod);
    fd.set("refundStoreCreditPct", String(storeCreditPct));
    fd.set("discountCodeRefundEnabled", dcEnabled ? "on" : "off");
    fd.set("discountCodePrefix", dcPrefix);
    fd.set("discountCodeExpiryDays", String(dcExpiryDays));
    fd.set("portalExchangeEnabled", portalExchangeEnabled ? "on" : "off");
    fd.delete("portalAllowedFulfillmentStatuses");
    allowedFulfillStatuses.forEach((s) => fd.append("portalAllowedFulfillmentStatuses", s));
    fd.set("fyndConsolidateReturns", fyndConsolidateReturns ? "on" : "off");
    fd.set("fyndConsolidateWindowHours", String(fyndConsolidateWindowHours));
    fd.set("refundGatePreset", fyndStatusGateEnabled ? refundGatePreset : "none");
    fd.delete("allowedFyndStatusesForRefund");
    if (fyndStatusGateEnabled && refundGatePreset === "custom") {
      allowedFyndStatuses.forEach((s) => fd.append("allowedFyndStatusesForRefund", s));
    }
    fd.delete("allowedFyndStatusesForReturn");
    if (fyndReturnGateEnabled) {
      allowedFyndReturnStatuses.forEach((s) => fd.append("allowedFyndStatusesForReturn", s));
    }
    fd.set("returnIdConfigJson", JSON.stringify({
      prefix: ridPrefix, separator: ridSeparator, bodyMode: ridBodyMode,
      hashLength: ridHashLength, sequentialPadding: ridSeqPadding, suffix: ridSuffix,
    }));
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <s-page fullWidth heading="Return Settings">
      <div className="app-content">
      {fetcher.data?.success === true && (
          <div className="app-alert app-alert-success">Settings saved successfully.</div>
      )}
      {fetcher.data && fetcher.data.success === false && (
          <div className="app-alert app-alert-error">{(fetcher.data as { error?: string }).error || "Failed to save settings."}</div>
      )}

      <fetcher.Form method="post" onSubmit={handleSubmit}>
        <div className="layout-form" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {/* No Return Period */}
          <s-section>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>No Return Period</div>
              <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>
                During a specified promotional or sale event, returns for items purchased within that period will not be processed. Note the date range.
              </p>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <input type="checkbox" name="noReturnPeriodEnabled" checked={noReturnEnabled} onChange={(e) => setNoReturnEnabled(e.target.checked)} />
                <span>Enable no-return period</span>
              </label>
              {noReturnEnabled ? (
                <div style={{ padding: 16, background: "#f6f6f7", borderRadius: 8 }}>
                  <p style={{ fontSize: 13, marginBottom: 8 }}>Set the date range during which returns will not be accepted.</p>
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                    <div>
                      <label style={{ fontSize: 12, color: "#6d7175" }}>Start</label>
                      <input
                        type="date"
                        name="noReturnPeriodStart"
                        defaultValue={data.noReturnPeriodStart}
                        style={{ display: "block", padding: 8, borderRadius: 6, border: "1px solid #e1e3e5", marginTop: 4 }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#6d7175" }}>End</label>
                      <input
                        type="date"
                        name="noReturnPeriodEnd"
                        defaultValue={data.noReturnPeriodEnd}
                        style={{ display: "block", padding: 8, borderRadius: 6, border: "1px solid #e1e3e5", marginTop: 4 }}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <p style={{ fontSize: 13, color: "#6d7175" }}>Enable the toggle above to configure a no-return date range.</p>
              )}
            </div>
          </s-section>

          {/* Restrict with product tags */}
          <s-section>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Restrict with product tags</div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>
              Returns will not be accepted for products marked with specific tags.
            </p>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                type="text"
                placeholder="Search tags"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTag())}
                style={{ flex: 1, padding: 10, borderRadius: 6, border: "1px solid #e1e3e5" }}
              />
              <s-button type="button" variant="secondary" onClick={addTag}>Add</s-button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {tags.map((t) => (
                <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", background: "#f6f6f7", borderRadius: 8, fontSize: 13 }}>
                  {t}
                  <button type="button" onClick={() => removeTag(t)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "#6d7175", fontSize: 16 }} aria-label={`Remove ${t}`}>×</button>
                </span>
              ))}
            </div>
          </s-section>

          {/* Return ID Format */}
          <s-section>
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "#F0FDF4", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Return ID Format</div>
                  <div style={{ fontSize: 12, color: "#6d7175" }}>Configure how return request IDs are generated</div>
                </div>
              </div>

              {/* Live Preview */}
              <div style={{ margin: "12px 0", padding: "12px 16px", background: "#F0FDF4", borderRadius: 8, border: "1px solid #BBF7D0", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, color: "#6d7175" }}>Preview:</span>
                <span style={{ fontWeight: 700, fontSize: 15, fontFamily: "'SF Mono', Menlo, Consolas, monospace", color: "#059669", letterSpacing: "0.03em" }}>{ridPreview}</span>
              </div>

              <div style={{ padding: 16, background: "#f6f6f7", borderRadius: 8, display: "flex", flexDirection: "column", gap: 14 }}>
                {/* Prefix */}
                <div style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 120 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#6d7175", display: "block", marginBottom: 4 }}>Prefix</label>
                    <input
                      type="text" value={ridPrefix} maxLength={20}
                      onChange={(e) => setRidPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))}
                      style={{ padding: "7px 10px", borderRadius: 6, border: "1px solid #e1e3e5", width: "100%", fontSize: 13, fontFamily: "monospace" }}
                      placeholder="RPM"
                    />
                  </div>
                  <div style={{ minWidth: 100 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#6d7175", display: "block", marginBottom: 4 }}>Separator</label>
                    <select
                      value={ridSeparator}
                      onChange={(e) => setRidSeparator(e.target.value)}
                      style={{ padding: "7px 10px", borderRadius: 6, border: "1px solid #e1e3e5", width: "100%", fontSize: 13, background: "white" }}
                    >
                      <option value="-">Dash ( - )</option>
                      <option value="_">Underscore ( _ )</option>
                      <option value="/">Slash ( / )</option>
                      <option value="">None</option>
                    </select>
                  </div>
                  <div style={{ flex: 1, minWidth: 120 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#6d7175", display: "block", marginBottom: 4 }}>Suffix (optional)</label>
                    <input
                      type="text" value={ridSuffix} maxLength={10}
                      onChange={(e) => setRidSuffix(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))}
                      style={{ padding: "7px 10px", borderRadius: 6, border: "1px solid #e1e3e5", width: "100%", fontSize: 13, fontFamily: "monospace" }}
                      placeholder="e.g. -US"
                    />
                  </div>
                </div>

                {/* ID Format */}
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#6d7175", display: "block", marginBottom: 6 }}>ID Format</label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {([
                      { value: "hash" as const, label: "Hash from ID", desc: "Random alphanumeric (e.g. A1B2C3D4)" },
                      { value: "sequential" as const, label: "Sequential", desc: "Auto-incrementing counter (e.g. 000042)" },
                      { value: "date_hash" as const, label: "Date + Hash", desc: "Date prefix + hash (e.g. 260312-A1B2)" },
                      { value: "date_sequential" as const, label: "Date + Sequential", desc: "Date prefix + counter (e.g. 260312-042)" },
                    ] as const).map((opt) => (
                      <label key={opt.value} style={{
                        display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px", borderRadius: 8,
                        border: `2px solid ${ridBodyMode === opt.value ? "#059669" : "#e1e3e5"}`,
                        background: ridBodyMode === opt.value ? "#F0FDF4" : "white",
                        cursor: "pointer", transition: "all 0.15s",
                      }}>
                        <input
                          type="radio" name="ridBodyMode" value={opt.value}
                          checked={ridBodyMode === opt.value}
                          onChange={() => setRidBodyMode(opt.value)}
                          style={{ marginTop: 2 }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{opt.label}</div>
                          <div style={{ fontSize: 11, color: "#6d7175" }}>{opt.desc}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Conditional: Hash Length or Sequential Padding */}
                {(ridBodyMode === "hash" || ridBodyMode === "date_hash") && (
                  <div style={{ maxWidth: 200 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#6d7175", display: "block", marginBottom: 4 }}>Hash Length</label>
                    <select
                      value={ridHashLength}
                      onChange={(e) => setRidHashLength(Number(e.target.value))}
                      style={{ padding: "7px 10px", borderRadius: 6, border: "1px solid #e1e3e5", width: "100%", fontSize: 13, background: "white" }}
                    >
                      <option value="6">6 characters</option>
                      <option value="8">8 characters (default)</option>
                      <option value="10">10 characters</option>
                    </select>
                  </div>
                )}
                {(ridBodyMode === "sequential" || ridBodyMode === "date_sequential") && (
                  <div style={{ maxWidth: 200 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#6d7175", display: "block", marginBottom: 4 }}>Counter Padding</label>
                    <select
                      value={ridSeqPadding}
                      onChange={(e) => setRidSeqPadding(Number(e.target.value))}
                      style={{ padding: "7px 10px", borderRadius: 6, border: "1px solid #e1e3e5", width: "100%", fontSize: 13, background: "white" }}
                    >
                      {[4, 5, 6, 7, 8].map((n) => (
                        <option key={n} value={n}>{n} digits{n === 6 ? " (default)" : ""}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div style={{ fontSize: 11, color: "#9CA3AF", lineHeight: 1.5 }}>
                  Changes only affect new returns. Existing return IDs are preserved.
                </div>
              </div>
            </div>
          </s-section>

          {/* Photo Required */}
          <s-section>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: photoRequired ? "#EFF6FF" : "#F3F4F6", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={photoRequired ? "#3B82F6" : "#9CA3AF"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: "stroke 0.15s" }}><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                </div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Photo Required</div>
              </div>
              <label style={{ position: "relative", display: "inline-block", width: 44, height: 24, flexShrink: 0, cursor: "pointer" }}>
                <input type="checkbox" checked={photoRequired} onChange={(e) => setPhotoRequired(e.target.checked)}
                  style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
                <span style={{ position: "absolute", inset: 0, borderRadius: 12, transition: "all 0.15s", background: photoRequired ? "#3B82F6" : "#cbd5e1" }}>
                  <span style={{ position: "absolute", left: photoRequired ? 22 : 2, top: 2, width: 20, height: 20, borderRadius: 10, background: "#fff", transition: "all 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,.15)" }} />
                </span>
              </label>
            </div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 10 }}>
              Require customers to upload item photos for better assistance with return inquiries or concerns.
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: photoRequired ? "#22C55E" : "#D1D5DB", transition: "background 0.15s" }} />
              <span style={{ fontSize: 12, fontWeight: 500, color: photoRequired ? "#15803D" : "#6B7280", transition: "color 0.15s" }}>
                {photoRequired ? "Enabled" : "Disabled"}
              </span>
            </div>
            <input type="hidden" name="photoRequired" value={photoRequired ? "on" : "off"} />
          </s-section>

          {/* Return Fee */}
          <s-section>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Return Fee</div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>
              Configure a return fee that is subtracted from the refund amount automatically during the return process.
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <select name="returnFeeCurrency" defaultValue={data.returnFeeCurrency} style={{ padding: 10, borderRadius: 6, border: "1px solid #e1e3e5" }}>
                <option value="AED">AED – UAE Dirham</option>
                <option value="AFN">AFN – Afghan Afghani</option>
                <option value="ALL">ALL – Albanian Lek</option>
                <option value="AMD">AMD – Armenian Dram</option>
                <option value="ANG">ANG – Netherlands Antillean Guilder</option>
                <option value="AOA">AOA – Angolan Kwanza</option>
                <option value="ARS">ARS – Argentine Peso</option>
                <option value="AUD">AUD – Australian Dollar</option>
                <option value="AWG">AWG – Aruban Florin</option>
                <option value="AZN">AZN – Azerbaijani Manat</option>
                <option value="BAM">BAM – Bosnia-Herzegovina Convertible Mark</option>
                <option value="BBD">BBD – Barbadian Dollar</option>
                <option value="BDT">BDT – Bangladeshi Taka</option>
                <option value="BGN">BGN – Bulgarian Lev</option>
                <option value="BHD">BHD – Bahraini Dinar</option>
                <option value="BIF">BIF – Burundian Franc</option>
                <option value="BMD">BMD – Bermudan Dollar</option>
                <option value="BND">BND – Brunei Dollar</option>
                <option value="BOB">BOB – Bolivian Boliviano</option>
                <option value="BRL">BRL – Brazilian Real</option>
                <option value="BSD">BSD – Bahamian Dollar</option>
                <option value="BTN">BTN – Bhutanese Ngultrum</option>
                <option value="BWP">BWP – Botswanan Pula</option>
                <option value="BYN">BYN – Belarusian Ruble</option>
                <option value="BZD">BZD – Belize Dollar</option>
                <option value="CAD">CAD – Canadian Dollar</option>
                <option value="CDF">CDF – Congolese Franc</option>
                <option value="CHF">CHF – Swiss Franc</option>
                <option value="CLP">CLP – Chilean Peso</option>
                <option value="CNY">CNY – Chinese Yuan</option>
                <option value="COP">COP – Colombian Peso</option>
                <option value="CRC">CRC – Costa Rican Colón</option>
                <option value="CVE">CVE – Cape Verdean Escudo</option>
                <option value="CZK">CZK – Czech Koruna</option>
                <option value="DJF">DJF – Djiboutian Franc</option>
                <option value="DKK">DKK – Danish Krone</option>
                <option value="DOP">DOP – Dominican Peso</option>
                <option value="DZD">DZD – Algerian Dinar</option>
                <option value="EGP">EGP – Egyptian Pound</option>
                <option value="ERN">ERN – Eritrean Nakfa</option>
                <option value="ETB">ETB – Ethiopian Birr</option>
                <option value="EUR">EUR – Euro</option>
                <option value="FJD">FJD – Fijian Dollar</option>
                <option value="FKP">FKP – Falkland Islands Pound</option>
                <option value="GBP">GBP – British Pound</option>
                <option value="GEL">GEL – Georgian Lari</option>
                <option value="GHS">GHS – Ghanaian Cedi</option>
                <option value="GIP">GIP – Gibraltar Pound</option>
                <option value="GMD">GMD – Gambian Dalasi</option>
                <option value="GNF">GNF – Guinean Franc</option>
                <option value="GTQ">GTQ – Guatemalan Quetzal</option>
                <option value="GYD">GYD – Guyanaese Dollar</option>
                <option value="HKD">HKD – Hong Kong Dollar</option>
                <option value="HNL">HNL – Honduran Lempira</option>
                <option value="HRK">HRK – Croatian Kuna</option>
                <option value="HTG">HTG – Haitian Gourde</option>
                <option value="HUF">HUF – Hungarian Forint</option>
                <option value="IDR">IDR – Indonesian Rupiah</option>
                <option value="ILS">ILS – Israeli New Shekel</option>
                <option value="INR">INR – Indian Rupee</option>
                <option value="IQD">IQD – Iraqi Dinar</option>
                <option value="IRR">IRR – Iranian Rial</option>
                <option value="ISK">ISK – Icelandic Króna</option>
                <option value="JMD">JMD – Jamaican Dollar</option>
                <option value="JOD">JOD – Jordanian Dinar</option>
                <option value="JPY">JPY – Japanese Yen</option>
                <option value="KES">KES – Kenyan Shilling</option>
                <option value="KGS">KGS – Kyrgystani Som</option>
                <option value="KHR">KHR – Cambodian Riel</option>
                <option value="KMF">KMF – Comorian Franc</option>
                <option value="KRW">KRW – South Korean Won</option>
                <option value="KWD">KWD – Kuwaiti Dinar</option>
                <option value="KYD">KYD – Cayman Islands Dollar</option>
                <option value="KZT">KZT – Kazakhstani Tenge</option>
                <option value="LAK">LAK – Laotian Kip</option>
                <option value="LBP">LBP – Lebanese Pound</option>
                <option value="LKR">LKR – Sri Lankan Rupee</option>
                <option value="LRD">LRD – Liberian Dollar</option>
                <option value="LSL">LSL – Lesotho Loti</option>
                <option value="LYD">LYD – Libyan Dinar</option>
                <option value="MAD">MAD – Moroccan Dirham</option>
                <option value="MDL">MDL – Moldovan Leu</option>
                <option value="MGA">MGA – Malagasy Ariary</option>
                <option value="MKD">MKD – Macedonian Denar</option>
                <option value="MMK">MMK – Myanmar Kyat</option>
                <option value="MNT">MNT – Mongolian Tugrik</option>
                <option value="MOP">MOP – Macanese Pataca</option>
                <option value="MRU">MRU – Mauritanian Ouguiya</option>
                <option value="MUR">MUR – Mauritian Rupee</option>
                <option value="MVR">MVR – Maldivian Rufiyaa</option>
                <option value="MWK">MWK – Malawian Kwacha</option>
                <option value="MXN">MXN – Mexican Peso</option>
                <option value="MYR">MYR – Malaysian Ringgit</option>
                <option value="MZN">MZN – Mozambican Metical</option>
                <option value="NAD">NAD – Namibian Dollar</option>
                <option value="NGN">NGN – Nigerian Naira</option>
                <option value="NIO">NIO – Nicaraguan Córdoba</option>
                <option value="NOK">NOK – Norwegian Krone</option>
                <option value="NPR">NPR – Nepalese Rupee</option>
                <option value="NZD">NZD – New Zealand Dollar</option>
                <option value="OMR">OMR – Omani Rial</option>
                <option value="PAB">PAB – Panamanian Balboa</option>
                <option value="PEN">PEN – Peruvian Sol</option>
                <option value="PGK">PGK – Papua New Guinean Kina</option>
                <option value="PHP">PHP – Philippine Peso</option>
                <option value="PKR">PKR – Pakistani Rupee</option>
                <option value="PLN">PLN – Polish Zloty</option>
                <option value="PYG">PYG – Paraguayan Guarani</option>
                <option value="QAR">QAR – Qatari Rial</option>
                <option value="RON">RON – Romanian Leu</option>
                <option value="RSD">RSD – Serbian Dinar</option>
                <option value="RUB">RUB – Russian Ruble</option>
                <option value="RWF">RWF – Rwandan Franc</option>
                <option value="SAR">SAR – Saudi Riyal</option>
                <option value="SBD">SBD – Solomon Islands Dollar</option>
                <option value="SCR">SCR – Seychellois Rupee</option>
                <option value="SDG">SDG – Sudanese Pound</option>
                <option value="SEK">SEK – Swedish Krona</option>
                <option value="SGD">SGD – Singapore Dollar</option>
                <option value="SHP">SHP – St. Helena Pound</option>
                <option value="SLL">SLL – Sierra Leonean Leone</option>
                <option value="SOS">SOS – Somali Shilling</option>
                <option value="SRD">SRD – Surinamese Dollar</option>
                <option value="STN">STN – São Tomé &amp; Príncipe Dobra</option>
                <option value="SVC">SVC – Salvadoran Colón</option>
                <option value="SYP">SYP – Syrian Pound</option>
                <option value="SZL">SZL – Swazi Lilangeni</option>
                <option value="THB">THB – Thai Baht</option>
                <option value="TJS">TJS – Tajikistani Somoni</option>
                <option value="TMT">TMT – Turkmenistani Manat</option>
                <option value="TND">TND – Tunisian Dinar</option>
                <option value="TOP">TOP – Tongan Paʻanga</option>
                <option value="TRY">TRY – Turkish Lira</option>
                <option value="TTD">TTD – Trinidad &amp; Tobago Dollar</option>
                <option value="TWD">TWD – New Taiwan Dollar</option>
                <option value="TZS">TZS – Tanzanian Shilling</option>
                <option value="UAH">UAH – Ukrainian Hryvnia</option>
                <option value="UGX">UGX – Ugandan Shilling</option>
                <option value="USD">USD – US Dollar</option>
                <option value="UYU">UYU – Uruguayan Peso</option>
                <option value="UZS">UZS – Uzbekistani Som</option>
                <option value="VES">VES – Venezuelan Bolívar</option>
                <option value="VND">VND – Vietnamese Dong</option>
                <option value="VUV">VUV – Vanuatu Vatu</option>
                <option value="WST">WST – Samoan Tala</option>
                <option value="XAF">XAF – Central African CFA Franc</option>
                <option value="XCD">XCD – East Caribbean Dollar</option>
                <option value="XOF">XOF – West African CFA Franc</option>
                <option value="XPF">XPF – CFP Franc</option>
                <option value="YER">YER – Yemeni Rial</option>
                <option value="ZAR">ZAR – South African Rand</option>
                <option value="ZMW">ZMW – Zambian Kwacha</option>
                <option value="ZWL">ZWL – Zimbabwean Dollar</option>
              </select>
              <input
                type="number"
                name="returnFeeAmount"
                defaultValue={data.returnFeeAmount}
                min={0}
                step="0.01"
                style={{ width: 120, padding: 10, borderRadius: 6, border: "1px solid #e1e3e5" }}
              />
            </div>
          </s-section>

          {/* Auto Approval */}
          <s-section>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: autoApproveEnabled ? "#F0FDF4" : "#F3F4F6", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={autoApproveEnabled ? "#22C55E" : "#9CA3AF"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: "stroke 0.15s" }}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
                </div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Auto Approval</div>
              </div>
              <label style={{ position: "relative", display: "inline-block", width: 44, height: 24, flexShrink: 0, cursor: "pointer" }}>
                <input type="checkbox" checked={autoApproveEnabled} onChange={(e) => setAutoApproveEnabled(e.target.checked)}
                  style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
                <span style={{ position: "absolute", inset: 0, borderRadius: 12, transition: "all 0.15s", background: autoApproveEnabled ? "#3B82F6" : "#cbd5e1" }}>
                  <span style={{ position: "absolute", left: autoApproveEnabled ? 22 : 2, top: 2, width: 20, height: 20, borderRadius: 10, background: "#fff", transition: "all 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,.15)" }} />
                </span>
              </label>
            </div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 10 }}>
              You have the flexibility to either manually approve return requests or opt for an automatic approval process.
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: autoApproveEnabled ? "#22C55E" : "#D1D5DB", transition: "background 0.15s" }} />
              <span style={{ fontSize: 12, fontWeight: 500, color: autoApproveEnabled ? "#15803D" : "#6B7280", transition: "color 0.15s" }}>
                {autoApproveEnabled ? "Enabled" : "Disabled"}
              </span>
            </div>
            <input type="hidden" name="autoApproveEnabled" value={autoApproveEnabled ? "on" : "off"} />
          </s-section>

          {/* Auto Refund */}
          <s-section>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: autoRefundEnabled ? "#FFFBEB" : "#F3F4F6", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={autoRefundEnabled ? "#F59E0B" : "#9CA3AF"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: "stroke 0.15s" }}><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                </div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Auto Refund on Credit Note</div>
              </div>
              <label style={{ position: "relative", display: "inline-block", width: 44, height: 24, flexShrink: 0, cursor: "pointer" }}>
                <input type="checkbox" checked={autoRefundEnabled} onChange={(e) => setAutoRefundEnabled(e.target.checked)}
                  style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
                <span style={{ position: "absolute", inset: 0, borderRadius: 12, transition: "all 0.15s", background: autoRefundEnabled ? "#3B82F6" : "#cbd5e1" }}>
                  <span style={{ position: "absolute", left: autoRefundEnabled ? 22 : 2, top: 2, width: 20, height: 20, borderRadius: 10, background: "#fff", transition: "all 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,.15)" }} />
                </span>
              </label>
            </div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 10 }}>
              When Fynd generates a credit note, automatically trigger a Shopify refund.
              If disabled, refunds must be processed manually from the return detail page.
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: autoRefundEnabled ? "#22C55E" : "#D1D5DB", transition: "background 0.15s" }} />
              <span style={{ fontSize: 12, fontWeight: 500, color: autoRefundEnabled ? "#15803D" : "#6B7280", transition: "color 0.15s" }}>
                {autoRefundEnabled ? "Enabled" : "Disabled"}
              </span>
            </div>
            <input type="hidden" name="autoRefundEnabled" value={autoRefundEnabled ? "on" : "off"} />
          </s-section>

          {/* Refund Payment Method */}
          <s-section>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Shopify Refund Payment Method</div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 16 }}>
              Control how refunds are issued in Shopify. This applies to all refund paths — manual refunds, auto-refund on credit note, and webhook-triggered refunds.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: paymentMethod === "both" ? 16 : 0 }}>
              <label style={{
                display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: 14,
                background: paymentMethod === "original" ? "#EFF6FF" : "#F9FAFB",
                borderRadius: 10, border: paymentMethod === "original" ? "2px solid #3B82F6" : "1px solid #E5E7EB",
                transition: "all 0.15s",
              }}>
                <input type="radio" checked={paymentMethod === "original"} onChange={() => setPaymentMethod("original")} style={{ marginTop: 3 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                    Original payment method
                  </div>
                  <div style={{ fontSize: 12, color: "#6B7280", marginTop: 4, lineHeight: 1.5 }}>
                    Refund is returned to the customer's original payment method (credit card, UPI, etc.). This is the standard Shopify refund behavior.
                  </div>
                </div>
              </label>
              <label style={{
                display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: 14,
                background: paymentMethod === "store_credit" ? "#F0FDF4" : "#F9FAFB",
                borderRadius: 10, border: paymentMethod === "store_credit" ? "2px solid #22C55E" : "1px solid #E5E7EB",
                transition: "all 0.15s",
              }}>
                <input type="radio" checked={paymentMethod === "store_credit"} onChange={() => setPaymentMethod("store_credit")} style={{ marginTop: 3 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 0 1 0 4H8"/><path d="M12 18V6"/></svg>
                    Store credit
                  </div>
                  <div style={{ fontSize: 12, color: "#6B7280", marginTop: 4, lineHeight: 1.5 }}>
                    Full refund amount is issued as store credit to the customer's account. Requires new customer accounts to be enabled in your Shopify store.
                  </div>
                </div>
              </label>
              <label style={{
                display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: 14,
                background: paymentMethod === "both" ? "#FFFBEB" : "#F9FAFB",
                borderRadius: 10, border: paymentMethod === "both" ? "2px solid #F59E0B" : "1px solid #E5E7EB",
                transition: "all 0.15s",
              }}>
                <input type="radio" checked={paymentMethod === "both"} onChange={() => setPaymentMethod("both")} style={{ marginTop: 3 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/></svg>
                    Split — original payment + store credit
                  </div>
                  <div style={{ fontSize: 12, color: "#6B7280", marginTop: 4, lineHeight: 1.5 }}>
                    Split the refund between the original payment method and store credit. Configure the percentage allocated to store credit below.
                  </div>
                </div>
              </label>
              <label style={{
                display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: 14,
                background: paymentMethod === "discount_code" ? "#F5F3FF" : "#F9FAFB",
                borderRadius: 10, border: paymentMethod === "discount_code" ? "2px solid #8B5CF6" : "1px solid #E5E7EB",
                transition: "all 0.15s",
              }}>
                <input type="radio" checked={paymentMethod === "discount_code"} onChange={() => { setPaymentMethod("discount_code"); setDcEnabled(true); }} style={{ marginTop: 3 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                    Discount code
                  </div>
                  <div style={{ fontSize: 12, color: "#6B7280", marginTop: 4, lineHeight: 1.5 }}>
                    Generate a single-use Shopify discount code for the refund amount. The customer can apply it at checkout on their next order.
                  </div>
                </div>
              </label>
            </div>
            {paymentMethod === "both" && (
              <div style={{ padding: 16, background: "#FFFBEB", borderRadius: 10, border: "1px solid #FDE68A" }}>
                <label style={{ fontWeight: 600, fontSize: 13, display: "block", marginBottom: 10 }}>
                  Store credit percentage
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <input
                    type="range"
                    min={5}
                    max={95}
                    step={5}
                    value={storeCreditPct}
                    onChange={(e) => setStoreCreditPct(parseInt(e.target.value, 10))}
                    style={{ flex: 1, accentColor: "#F59E0B" }}
                  />
                  <div style={{ minWidth: 54, textAlign: "center", fontWeight: 700, fontSize: 15, fontVariantNumeric: "tabular-nums" }}>
                    {storeCreditPct}%
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, padding: "10px 14px", background: "#FEF3C7", borderRadius: 8 }}>
                  <div>
                    <div style={{ fontSize: 11, color: "#92400E", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.5px" }}>Store credit</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#92400E", fontVariantNumeric: "tabular-nums" }}>{storeCreditPct}%</div>
                  </div>
                  <div style={{ width: 1, background: "#F59E0B", opacity: 0.3 }} />
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 11, color: "#92400E", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.5px" }}>Original payment</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#92400E", fontVariantNumeric: "tabular-nums" }}>{100 - storeCreditPct}%</div>
                  </div>
                </div>
              </div>
            )}
            {paymentMethod === "store_credit" && (
              <div style={{ marginTop: 12, padding: 12, background: "#F0FDF4", borderRadius: 8, fontSize: 12, color: "#166534", display: "flex", alignItems: "flex-start", gap: 8 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <span>Store credit requires new customer accounts to be enabled in Shopify Settings. The order must also be associated with a customer.</span>
              </div>
            )}
            {(paymentMethod === "discount_code" || dcEnabled) && (
              <div style={{ marginTop: 16, padding: 16, background: "#F5F3FF", borderRadius: 10, border: "1px solid #DDD6FE" }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12, display: "flex", alignItems: "center", gap: 8, color: "#5B21B6" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                  Discount Code Settings
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                  <div>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>Enable discount code refund</div>
                    <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>Show as a refund method option in the refund modal</div>
                  </div>
                  <label style={{ position: "relative", display: "inline-block", width: 44, height: 24, flexShrink: 0, cursor: "pointer" }}>
                    <input type="checkbox" checked={dcEnabled} onChange={(e) => setDcEnabled(e.target.checked)}
                      style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
                    <span style={{ position: "absolute", inset: 0, borderRadius: 12, transition: "all 0.15s", background: dcEnabled ? "#8B5CF6" : "#cbd5e1" }}>
                      <span style={{ position: "absolute", left: dcEnabled ? 22 : 2, top: 2, width: 20, height: 20, borderRadius: 10, background: "#fff", transition: "all 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,.15)" }} />
                    </span>
                  </label>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "#374151", marginBottom: 4 }}>Code prefix</label>
                    <input
                      type="text"
                      value={dcPrefix}
                      onChange={(e) => setDcPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))}
                      placeholder="RETURN"
                      maxLength={20}
                      style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 13, boxSizing: "border-box", fontFamily: "monospace" }}
                    />
                    <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 4 }}>e.g. {dcPrefix}-RPM-A1B2C3D4</div>
                  </div>
                  <div style={{ minWidth: 120 }}>
                    <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "#374151", marginBottom: 4 }}>Expiry (days)</label>
                    <input
                      type="number"
                      value={dcExpiryDays}
                      onChange={(e) => setDcExpiryDays(Math.max(1, parseInt(e.target.value, 10) || 90))}
                      min={1}
                      max={365}
                      style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 13, boxSizing: "border-box" }}
                    />
                  </div>
                </div>
                <input type="hidden" name="discountCodeRefundEnabled" value={dcEnabled ? "on" : "off"} />
                <input type="hidden" name="discountCodePrefix" value={dcPrefix} />
                <input type="hidden" name="discountCodeExpiryDays" value={String(dcExpiryDays)} />
              </div>
            )}
          </s-section>

          {/* Refund Location */}
          <s-section>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Refund Restock Location</div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>
              When processing a refund, Shopify requires a location to restock returned inventory.
              Choose whether to automatically use the order's fulfillment location or manually select it each time.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", padding: 12, background: locationMode === "auto" ? "#EFF6FF" : "#F9FAFB", borderRadius: 8, border: locationMode === "auto" ? "2px solid #3B82F6" : "1px solid #E5E7EB", transition: "all 0.15s" }}>
                <input type="radio" name="refundLocationMode" value="auto" checked={locationMode === "auto"} onChange={() => setLocationMode("auto")} style={{ marginTop: 2 }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Automatic — use fulfillment location</div>
                  <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>
                    Inventory will be restocked at the location the order was originally fulfilled from.
                    If unavailable, falls back to the default location below.
                  </div>
                </div>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", padding: 12, background: locationMode === "manual" ? "#EFF6FF" : "#F9FAFB", borderRadius: 8, border: locationMode === "manual" ? "2px solid #3B82F6" : "1px solid #E5E7EB", transition: "all 0.15s" }}>
                <input type="radio" name="refundLocationMode" value="manual" checked={locationMode === "manual"} onChange={() => setLocationMode("manual")} style={{ marginTop: 2 }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Manual — choose location during refund</div>
                  <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>
                    Admin will select the restock location from a dropdown each time a refund is processed.
                    The fulfillment location is pre-selected but can be changed.
                  </div>
                </div>
              </label>
            </div>
            {data.shopLocations.length > 0 && (
              <div>
                <label style={{ display: "block", fontWeight: 500, fontSize: 13, marginBottom: 6 }}>
                  {locationMode === "auto" ? "Default fallback location" : "Default pre-selected location"}
                </label>
                <p style={{ fontSize: 12, color: "#6d7175", marginBottom: 8 }}>
                  {locationMode === "auto"
                    ? "Used when the fulfillment location cannot be determined (e.g. unfulfilled orders)."
                    : "This location will be pre-selected in the refund modal, but admin can change it."}
                </p>
                <select name="refundLocationId" value={selectedLocId} onChange={(e) => setSelectedLocId(e.target.value)} style={{ width: "100%", maxWidth: 400, padding: 10, borderRadius: 6, border: "1px solid #e1e3e5", fontSize: 13 }}>
                  <option value="">None — auto-detect from Shopify</option>
                  {data.shopLocations.filter((l: ShopLocation) => l.isActive).map((loc: ShopLocation) => (
                    <option key={loc.id} value={loc.id}>{loc.name}</option>
                  ))}
                </select>
              </div>
            )}
            {data.shopLocations.length === 0 && (
              <div style={{ padding: 12, background: "#FEF3C7", borderRadius: 8, fontSize: 13, color: "#92400E" }}>
                No locations found. Make sure your Shopify store has at least one active location.
              </div>
            )}
          </s-section>

          {/* Portal Exchange */}
          <s-section>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: portalExchangeEnabled ? "#EFF6FF" : "#F3F4F6", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={portalExchangeEnabled ? "#3B82F6" : "#9CA3AF"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: "stroke 0.15s" }}><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
                </div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Portal Exchange</div>
              </div>
              <label style={{ position: "relative", display: "inline-block", width: 44, height: 24, flexShrink: 0, cursor: "pointer" }}>
                <input type="checkbox" checked={portalExchangeEnabled} onChange={(e) => setPortalExchangeEnabled(e.target.checked)}
                  style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
                <span style={{ position: "absolute", inset: 0, borderRadius: 12, transition: "all 0.15s", background: portalExchangeEnabled ? "#3B82F6" : "#cbd5e1" }}>
                  <span style={{ position: "absolute", left: portalExchangeEnabled ? 22 : 2, top: 2, width: 20, height: 20, borderRadius: 10, background: "#fff", transition: "all 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,.15)" }} />
                </span>
              </label>
            </div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 10 }}>
              Allow customers to request an exchange (instead of a refund) directly from the customer portal. Customers will see a "Refund / Exchange" choice and can describe the variant they want.
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: portalExchangeEnabled ? "#22C55E" : "#D1D5DB", transition: "background 0.15s" }} />
              <span style={{ fontSize: 12, fontWeight: 500, color: portalExchangeEnabled ? "#15803D" : "#6B7280", transition: "color 0.15s" }}>
                {portalExchangeEnabled ? "Enabled" : "Disabled"}
              </span>
            </div>
          </s-section>

          {/* Allowed Fulfillment Statuses */}
          <s-section>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Allowed Fulfillment Statuses for Return Eligibility</div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>
              Only orders with these Shopify fulfillment statuses will be eligible for returns on the customer portal.
              For Fynd-managed orders, the system also checks Fynd delivery status automatically.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(["FULFILLED", "PARTIALLY_FULFILLED", "UNFULFILLED", "IN_PROGRESS", "ON_HOLD", "SCHEDULED"] as const).map((status) => {
                const recommended = status === "FULFILLED" || status === "PARTIALLY_FULFILLED";
                const checked = allowedFulfillStatuses.includes(status);
                return (
                  <label key={status} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "10px 12px", background: checked ? "#EFF6FF" : "#F9FAFB", borderRadius: 8, border: checked ? "1.5px solid #BFDBFE" : "1px solid #E5E7EB", transition: "all 0.15s" }}>
                    <input type="checkbox" checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) setAllowedFulfillStatuses([...allowedFulfillStatuses, status]);
                        else setAllowedFulfillStatuses(allowedFulfillStatuses.filter((s) => s !== status));
                      }}
                      style={{ width: 16, height: 16, flexShrink: 0 }}
                    />
                    <div style={{ flex: 1 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, fontFamily: "monospace" }}>{status}</span>
                      {recommended && <span style={{ marginLeft: 8, fontSize: 11, background: "#DCFCE7", color: "#15803D", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>Recommended</span>}
                    </div>
                  </label>
                );
              })}
            </div>
            <p style={{ fontSize: 12, color: "#6d7175", marginTop: 10 }}>
              For Fynd orders, return is also allowed when Fynd status is <code>delivery_done</code> or <code>handed_over_to_customer</code>, regardless of Shopify status.
            </p>
          </s-section>

          {/* Fynd Status Gate for Return Initiation */}
          <s-section>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: fyndReturnGateEnabled ? "#EFF6FF" : "#F3F4F6", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={fyndReturnGateEnabled ? "#3B82F6" : "#9CA3AF"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: "stroke 0.15s" }}><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 110 8h-1"/></svg>
                </div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Fynd Status Gate for Return Initiation</div>
              </div>
              <label style={{ position: "relative", display: "inline-block", width: 44, height: 24, flexShrink: 0, cursor: "pointer" }}>
                <input type="checkbox" checked={fyndReturnGateEnabled} onChange={(e) => {
                  setFyndReturnGateEnabled(e.target.checked);
                  if (!e.target.checked) setAllowedFyndReturnStatuses([]);
                }}
                  style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
                <span style={{ position: "absolute", inset: 0, borderRadius: 12, transition: "all 0.15s", background: fyndReturnGateEnabled ? "#3B82F6" : "#cbd5e1" }}>
                  <span style={{ position: "absolute", left: fyndReturnGateEnabled ? 22 : 2, top: 2, width: 20, height: 20, borderRadius: 10, background: "#fff", transition: "all 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,.15)" }} />
                </span>
              </label>
            </div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>
              When enabled, customers can only initiate a return from the portal when the Fynd shipment status matches one of the selected statuses below. This applies to Fynd-integrated orders only — non-Fynd orders use the standard fulfillment status gate.
            </p>
            {!fyndReturnGateEnabled && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: "#D1D5DB", transition: "background 0.15s" }} />
                <span style={{ fontSize: 12, fontWeight: 500, color: "#6B7280" }}>Disabled — returns allowed based on Shopify fulfillment status only</span>
              </div>
            )}
            {fyndReturnGateEnabled && (
              <div style={{ padding: 14, background: "#EFF6FF", borderRadius: 10, border: "1px solid #BFDBFE", marginBottom: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Select allowed Fynd statuses for return initiation</div>
                <p style={{ fontSize: 12, color: "#1E40AF", marginBottom: 12 }}>
                  Customers can only create a return when the Fynd shipment status matches one of the checked statuses. Select at least one status.
                </p>

                {/* Forward Journey */}
                <div style={{ fontWeight: 600, fontSize: 12, color: "#64748B", marginBottom: 6, marginTop: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Forward Journey</div>
                {(["bag_confirmed", "bag_invoiced", "ready_for_dp_assignment", "dp_assigned", "bag_packed", "handed_over_to_dg", "bag_picked", "out_for_delivery"] as const).map((status) => {
                  const FYND_STATUS_LABELS: Record<string, string> = {
                    bag_confirmed: "Bag Confirmed",
                    bag_invoiced: "Bag Invoiced",
                    ready_for_dp_assignment: "Ready for Courier Assignment",
                    dp_assigned: "Courier Assigned",
                    bag_packed: "Bag Packed",
                    handed_over_to_dg: "Handed Over to Delivery Partner",
                    bag_picked: "Bag Picked Up",
                    out_for_delivery: "Out for Delivery",
                  };
                  const checked = allowedFyndReturnStatuses.includes(status);
                  return (
                    <label key={status} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "8px 12px", marginBottom: 4, background: checked ? "#EFF6FF" : "#F8FAFC", borderRadius: 8, border: checked ? "1.5px solid #93C5FD" : "1px solid #E2E8F0", transition: "all 0.15s" }}>
                      <input type="checkbox" checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) setAllowedFyndReturnStatuses([...allowedFyndReturnStatuses, status]);
                          else setAllowedFyndReturnStatuses(allowedFyndReturnStatuses.filter((s) => s !== status));
                        }}
                        style={{ width: 16, height: 16, flexShrink: 0 }}
                      />
                      <div style={{ flex: 1 }}>
                        <span style={{ fontWeight: 600, fontSize: 13, fontFamily: "monospace" }}>{status}</span>
                        <span style={{ marginLeft: 8, fontSize: 12, color: "#64748B" }}>{FYND_STATUS_LABELS[status] ?? ""}</span>
                      </div>
                    </label>
                  );
                })}

                {/* Delivery & Handover */}
                <div style={{ fontWeight: 600, fontSize: 12, color: "#64748B", marginBottom: 6, marginTop: 14, textTransform: "uppercase", letterSpacing: 0.5 }}>Delivery &amp; Handover</div>
                {(["delivery_done", "handed_over_to_customer", "bag_delivered"] as const).map((status) => {
                  const DELIVERY_LABELS: Record<string, string> = {
                    delivery_done: "Delivered",
                    handed_over_to_customer: "Handed Over to Customer",
                    bag_delivered: "Bag Delivered",
                  };
                  const checked = allowedFyndReturnStatuses.includes(status);
                  return (
                    <label key={status} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "8px 12px", marginBottom: 4, background: checked ? "#EFF6FF" : "#F8FAFC", borderRadius: 8, border: checked ? "1.5px solid #93C5FD" : "1px solid #E2E8F0", transition: "all 0.15s" }}>
                      <input type="checkbox" checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) setAllowedFyndReturnStatuses([...allowedFyndReturnStatuses, status]);
                          else setAllowedFyndReturnStatuses(allowedFyndReturnStatuses.filter((s) => s !== status));
                        }}
                        style={{ width: 16, height: 16, flexShrink: 0 }}
                      />
                      <div style={{ flex: 1 }}>
                        <span style={{ fontWeight: 600, fontSize: 13, fontFamily: "monospace" }}>{status}</span>
                        <span style={{ marginLeft: 8, fontSize: 12, color: "#64748B" }}>{DELIVERY_LABELS[status] ?? ""}</span>
                        <span style={{ marginLeft: 8, fontSize: 11, background: "#DCFCE7", color: "#15803D", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>Recommended</span>
                      </div>
                    </label>
                  );
                })}

                {allowedFyndReturnStatuses.length === 0 && (
                  <div style={{ marginTop: 12, padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, fontSize: 13, color: "#991B1B", fontWeight: 500 }}>
                    No statuses selected. When the gate is enabled, at least one Fynd status must be selected — otherwise all returns for Fynd orders will be blocked.
                  </div>
                )}
                <p style={{ fontSize: 12, color: "#64748B", marginTop: 12, lineHeight: 1.5 }}>
                  These statuses correspond to Fynd forward-journey shipment states. When a customer looks up their order on the portal, return eligibility is checked against the current Fynd shipment status. Non-Fynd orders bypass this gate entirely.
                </p>
              </div>
            )}
            {fyndReturnGateEnabled && allowedFyndReturnStatuses.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: "#3B82F6" }} />
                <span style={{ fontSize: 12, fontWeight: 500, color: "#1D4ED8" }}>
                  Enabled — {allowedFyndReturnStatuses.length} status{allowedFyndReturnStatuses.length !== 1 ? "es" : ""} allowed for return initiation
                </span>
              </div>
            )}
          </s-section>

          {/* Fynd Status Gate for Refunds */}
          <s-section>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: fyndStatusGateEnabled ? "#FFF7ED" : "#F3F4F6", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={fyndStatusGateEnabled ? "#F97316" : "#9CA3AF"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: "stroke 0.15s" }}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                </div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Fynd Status Gate for Refunds</div>
              </div>
              <label style={{ position: "relative", display: "inline-block", width: 44, height: 24, flexShrink: 0, cursor: "pointer" }}>
                <input type="checkbox" checked={fyndStatusGateEnabled} onChange={(e) => {
                  setFyndStatusGateEnabled(e.target.checked);
                  if (!e.target.checked) {
                    setRefundGatePreset("none");
                    setAllowedFyndStatuses([]);
                  } else if (refundGatePreset === "none") {
                    setRefundGatePreset("after_delivery");
                    const presetStatuses = getStatusesForPreset("after_delivery");
                    if (presetStatuses) setAllowedFyndStatuses(presetStatuses);
                  }
                }}
                  style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
                <span style={{ position: "absolute", inset: 0, borderRadius: 12, transition: "all 0.15s", background: fyndStatusGateEnabled ? "#F97316" : "#cbd5e1" }}>
                  <span style={{ position: "absolute", left: fyndStatusGateEnabled ? 22 : 2, top: 2, width: 20, height: 20, borderRadius: 10, background: "#fff", transition: "all 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,.15)" }} />
                </span>
              </label>
            </div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>
              Control when refunds can be processed for Fynd-integrated orders based on the return bag's journey status. Non-Fynd returns are unaffected.
            </p>
            {!fyndStatusGateEnabled && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: "#D1D5DB", transition: "background 0.15s" }} />
                <span style={{ fontSize: 12, fontWeight: 500, color: "#6B7280" }}>Disabled — refunds allowed regardless of Fynd status</span>
              </div>
            )}
            {fyndStatusGateEnabled && (
              <div style={{ padding: 14, background: "#FFF7ED", borderRadius: 10, border: "1px solid #FED7AA", marginBottom: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>When should refunds be allowed?</div>
                <p style={{ fontSize: 12, color: "#92400E", marginBottom: 12 }}>
                  Choose a refund policy based on the return bag's journey. Refunds will be blocked until the selected milestone is reached.
                </p>

                {/* Preset Radio Group */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                  {(["after_pickup", "after_delivery", "after_qc", "custom"] as const).map((preset) => {
                    const info = PRESET_LABELS[preset];
                    const isSelected = refundGatePreset === preset;
                    const isRecommended = preset === "after_delivery";
                    return (
                      <label key={preset} style={{
                        display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer",
                        padding: "10px 14px", borderRadius: 10,
                        border: isSelected ? "2px solid #F97316" : "1.5px solid #E7E5E4",
                        background: isSelected ? "#FFF7ED" : "#FAFAF9",
                        transition: "all 0.15s",
                      }}>
                        <input
                          type="radio" name="refundGatePresetRadio" value={preset}
                          checked={isSelected}
                          onChange={() => {
                            setRefundGatePreset(preset);
                            if (preset !== "custom") {
                              const presetStatuses = getStatusesForPreset(preset);
                              if (presetStatuses) setAllowedFyndStatuses(presetStatuses);
                            }
                          }}
                          style={{ marginTop: 2, flexShrink: 0 }}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontWeight: 600, fontSize: 13 }}>{info.label}</span>
                            {isRecommended && <span style={{ fontSize: 10, background: "#DCFCE7", color: "#15803D", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>Recommended</span>}
                            {preset === "custom" && <span style={{ fontSize: 10, background: "#F3F4F6", color: "#6B7280", padding: "1px 6px", borderRadius: 4, fontWeight: 500 }}>Advanced</span>}
                          </div>
                          <div style={{ fontSize: 12, color: "#78716C", marginTop: 2 }}>{info.description}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>

                {/* Preset summary — show which statuses are included (non-custom) */}
                {refundGatePreset !== "custom" && (() => {
                  const presetStatuses = getStatusesForPreset(refundGatePreset);
                  if (!presetStatuses) return null;
                  return (
                    <details style={{ marginBottom: 8 }}>
                      <summary style={{ fontSize: 12, color: "#78716C", cursor: "pointer", userSelect: "none" }}>
                        {presetStatuses.length} Fynd statuses included — click to view
                      </summary>
                      <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {presetStatuses.map((s) => (
                          <span key={s} style={{ fontSize: 11, fontFamily: "monospace", padding: "2px 6px", background: "#FEF3C7", borderRadius: 4, color: "#92400E" }}>{s}</span>
                        ))}
                      </div>
                    </details>
                  );
                })()}

                {/* Custom mode — show raw multi-select checkboxes */}
                {refundGatePreset === "custom" && (
                  <div style={{ padding: 12, background: "#FAFAF9", borderRadius: 8, border: "1px solid #E7E5E4" }}>
                    <div style={{ fontWeight: 600, fontSize: 12, color: "#78716C", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Select Fynd statuses manually</div>

                    {/* Delivery & Handover */}
                    <div style={{ fontWeight: 600, fontSize: 11, color: "#78716C", marginBottom: 4, marginTop: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Delivery &amp; Handover</div>
                    {(["delivery_done", "handed_over_to_customer"] as const).map((status) => {
                      const checked = allowedFyndStatuses.includes(status);
                      return (
                        <label key={status} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "6px 10px", marginBottom: 3, background: checked ? "#FFF7ED" : "white", borderRadius: 6, border: checked ? "1.5px solid #FDBA74" : "1px solid #E7E5E4", transition: "all 0.15s" }}>
                          <input type="checkbox" checked={checked}
                            onChange={(e) => {
                              if (e.target.checked) setAllowedFyndStatuses([...allowedFyndStatuses, status]);
                              else setAllowedFyndStatuses(allowedFyndStatuses.filter((s) => s !== status));
                            }}
                            style={{ width: 14, height: 14, flexShrink: 0 }}
                          />
                          <span style={{ fontWeight: 600, fontSize: 12, fontFamily: "monospace" }}>{status}</span>
                        </label>
                      );
                    })}

                    {/* Return Flow */}
                    <div style={{ fontWeight: 600, fontSize: 11, color: "#78716C", marginBottom: 4, marginTop: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Return Flow</div>
                    {(["return_bag_picked", "return_bag_in_transit", "return_bag_out_for_delivery", "out_for_delivery_to_store", "return_bag_delivered", "return_delivered", "return_accepted", "return_completed", "return_request_cancelled", "return_cancelled_at_dp", "return_dp_not_assigned", "return_pre_qc", "return_request_rejected", "return_instore_requested"] as const).map((status) => {
                      const checked = allowedFyndStatuses.includes(status);
                      return (
                        <label key={status} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "6px 10px", marginBottom: 3, background: checked ? "#FFF7ED" : "white", borderRadius: 6, border: checked ? "1.5px solid #FDBA74" : "1px solid #E7E5E4", transition: "all 0.15s" }}>
                          <input type="checkbox" checked={checked}
                            onChange={(e) => {
                              if (e.target.checked) setAllowedFyndStatuses([...allowedFyndStatuses, status]);
                              else setAllowedFyndStatuses(allowedFyndStatuses.filter((s) => s !== status));
                            }}
                            style={{ width: 14, height: 14, flexShrink: 0 }}
                          />
                          <span style={{ fontWeight: 600, fontSize: 12, fontFamily: "monospace" }}>{status}</span>
                        </label>
                      );
                    })}

                    {/* Refund Flow */}
                    <div style={{ fontWeight: 600, fontSize: 11, color: "#78716C", marginBottom: 4, marginTop: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Refund Flow</div>
                    {(["refund_initiated", "refund_on_hold", "refund_acknowledged", "refund_pending", "refund_pending_for_approval", "beneficiary_awaited", "manual_refund", "credit_note_generated"] as const).map((status) => {
                      const checked = allowedFyndStatuses.includes(status);
                      return (
                        <label key={status} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "6px 10px", marginBottom: 3, background: checked ? "#FFF7ED" : "white", borderRadius: 6, border: checked ? "1.5px solid #FDBA74" : "1px solid #E7E5E4", transition: "all 0.15s" }}>
                          <input type="checkbox" checked={checked}
                            onChange={(e) => {
                              if (e.target.checked) setAllowedFyndStatuses([...allowedFyndStatuses, status]);
                              else setAllowedFyndStatuses(allowedFyndStatuses.filter((s) => s !== status));
                            }}
                            style={{ width: 14, height: 14, flexShrink: 0 }}
                          />
                          <span style={{ fontWeight: 600, fontSize: 12, fontFamily: "monospace" }}>{status}</span>
                        </label>
                      );
                    })}

                    {allowedFyndStatuses.length === 0 && (
                      <div style={{ marginTop: 8, padding: "8px 12px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 6, fontSize: 12, color: "#991B1B", fontWeight: 500 }}>
                        No statuses selected — all refunds for Fynd orders will be blocked.
                      </div>
                    )}
                  </div>
                )}

                <p style={{ fontSize: 12, color: "#78716C", marginTop: 10, lineHeight: 1.5 }}>
                  Non-Fynd returns (manual or Shopify-only orders) bypass this gate entirely.
                </p>
              </div>
            )}
            {fyndStatusGateEnabled && refundGatePreset !== "none" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: "#F97316" }} />
                <span style={{ fontSize: 12, fontWeight: 500, color: "#C2410C" }}>
                  Enabled — {PRESET_LABELS[refundGatePreset]?.label ?? refundGatePreset}
                </span>
              </div>
            )}
          </s-section>

          {/* Fynd Return Consolidation */}
          <s-section>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: fyndConsolidateReturns ? "#F0FDF4" : "#F3F4F6", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={fyndConsolidateReturns ? "#22C55E" : "#9CA3AF"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: "stroke 0.15s" }}><rect x="2" y="3" width="6" height="4" rx="1"/><rect x="16" y="3" width="6" height="4" rx="1"/><rect x="9" y="17" width="6" height="4" rx="1"/><path d="M5 7v4a1 1 0 001 1h4"/><path d="M19 7v4a1 1 0 01-1 1h-4"/><path d="M12 12v5"/></svg>
                </div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Fynd Return Consolidation</div>
              </div>
              <label style={{ position: "relative", display: "inline-block", width: 44, height: 24, flexShrink: 0, cursor: "pointer" }}>
                <input type="checkbox" checked={fyndConsolidateReturns} onChange={(e) => setFyndConsolidateReturns(e.target.checked)}
                  style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
                <span style={{ position: "absolute", inset: 0, borderRadius: 12, transition: "all 0.15s", background: fyndConsolidateReturns ? "#3B82F6" : "#cbd5e1" }}>
                  <span style={{ position: "absolute", left: fyndConsolidateReturns ? 22 : 2, top: 2, width: 20, height: 20, borderRadius: 10, background: "#fff", transition: "all 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,.15)" }} />
                </span>
              </label>
            </div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 10 }}>
              When enabled, multiple return requests for the same Fynd order are batched into a single Fynd return shipment instead of creating separate pickups. This reduces logistics cost and courier visits.
            </p>
            {fyndConsolidateReturns && (
              <div style={{ padding: 14, background: "#F0FDF4", borderRadius: 10, border: "1px solid #BBF7D0", marginBottom: 10 }}>
                <label style={{ fontWeight: 600, fontSize: 13, display: "block", marginBottom: 10 }}>Batch window</label>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {([1, 4, 8, 24] as const).map((h) => (
                    <label key={h} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "8px 12px", background: fyndConsolidateWindowHours === h ? "#DCFCE7" : "#fff", borderRadius: 8, border: fyndConsolidateWindowHours === h ? "1.5px solid #22C55E" : "1px solid #E5E7EB", transition: "all 0.15s" }}>
                      <input type="radio" name="fyndConsolidateWindowHours" value={h} checked={fyndConsolidateWindowHours === h} onChange={() => setFyndConsolidateWindowHours(h)} />
                      <span style={{ fontWeight: fyndConsolidateWindowHours === h ? 600 : 400, fontSize: 13 }}>
                        {h === 1 ? "1 hour" : `${h} hours`}
                        {h === 4 && <span style={{ marginLeft: 8, fontSize: 11, background: "#DCFCE7", color: "#15803D", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>Recommended</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: fyndConsolidateReturns ? "#22C55E" : "#D1D5DB", transition: "background 0.15s" }} />
              <span style={{ fontSize: 12, fontWeight: 500, color: fyndConsolidateReturns ? "#15803D" : "#6B7280", transition: "color 0.15s" }}>
                {fyndConsolidateReturns ? `Enabled — ${fyndConsolidateWindowHours}h batch window` : "Disabled — each return syncs to Fynd immediately"}
              </span>
            </div>
          </s-section>
        </div>

        <div className="app-actions">
          <s-button type="submit" loading={fetcher.state !== "idle"}>Save</s-button>
          <Link to="/app/settings">
            <s-button variant="secondary" type="button">Discard</s-button>
          </Link>
        </div>
      </fetcher.Form>
      </div>
    </s-page>
  );
}
