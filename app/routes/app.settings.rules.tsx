import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseJsonArray, parseJsonObject } from "../lib/parse-json";
import { findOrCreateShop } from "../lib/shop.server";

const DEFAULT_REASONS = [
  "It's too loose",
  "It's too tight",
  "I didn't like the Product",
  "Wrong Product Received.",
  "Wrong Color Received",
  "Product is Damaged",
  "Received a Defective Product",
  "Missing Parts or Accessories",
  "Product Not as Described",
  "Product Doesn't Meet Expectations",
  "Ordered the Wrong Item",
  "Other",
];

type ReturnOffer = {
  id?: string;
  reasonCode?: string;
  tag?: string;
  offerType: "discount_pct" | "discount_flat";
  offerValue: number;
  message: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);
  const s = shop.settings;
  const reasons = parseJsonArray<string>(s?.returnReasonsJson ?? null, DEFAULT_REASONS);
  const regions = parseJsonArray<{ country?: string; province?: string }>(s?.restrictedRegionsJson ?? null, []);
  const offers = parseJsonArray<ReturnOffer>(s?.returnOffersJson ?? null, []);
  const reasonsByCategoryRaw = parseJsonObject<Record<string, string[]>>(s?.returnReasonsByCategoryJson ?? null, {});
  const reasonsByCategory = Object.entries(reasonsByCategoryRaw).filter(([k]) => k && typeof k === "string").map(([category, r]) => ({ category, reasons: Array.isArray(r) ? r : [] }));

  return {
    returnWindowDays: s?.returnWindowDays ?? 30,
    minimumReturnPrice: s?.minimumReturnPrice != null ? String(s.minimumReturnPrice) : "0",
    returnReasons: reasons,
    returnReasonsByCategory: reasonsByCategory,
    restrictedRegions: regions,
    returnOffers: offers,
    returnOffersEnabled: s?.returnOffersEnabled ?? false,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const returnWindowDays = Math.min(365, Math.max(1, parseInt(String(formData.get("returnWindowDays") ?? "30"), 10) || 30));
  const minPriceVal = parseFloat(String(formData.get("minimumReturnPrice") ?? "0"));
  const minimumReturnPrice = Math.max(0, Number.isFinite(minPriceVal) ? minPriceVal : 0);
  const returnReasonsJson = formData.get("returnReasonsJson") as string | null;
  const returnReasonsByCategoryJson = formData.get("returnReasonsByCategoryJson") as string | null;
  const restrictedRegionsJson = formData.get("restrictedRegionsJson") as string | null;
  const returnOffersJson = formData.get("returnOffersJson") as string | null;
  const returnOffersEnabled = formData.get("returnOffersEnabled") === "on";

  const shop = await findOrCreateShop(session.shop);

  let returnReasonsStr: string | undefined;
  let returnReasonsByCategoryStr: string | undefined;
  let restrictedRegionsStr: string | undefined;
  let returnOffersStr: string | undefined;
  try {
    if (returnReasonsJson != null) {
      const arr = JSON.parse(returnReasonsJson) as unknown;
      returnReasonsStr = Array.isArray(arr) ? JSON.stringify(arr) : undefined;
    }
  } catch {
    /* keep existing */
  }
  try {
    if (returnReasonsByCategoryJson != null && returnReasonsByCategoryJson.trim()) {
      const obj = JSON.parse(returnReasonsByCategoryJson) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        returnReasonsByCategoryStr = JSON.stringify(obj);
      }
    }
  } catch {
    /* keep existing */
  }
  try {
    if (restrictedRegionsJson != null) {
      const arr = JSON.parse(restrictedRegionsJson) as unknown;
      restrictedRegionsStr = Array.isArray(arr) ? JSON.stringify(arr) : undefined;
    }
  } catch {
    /* keep existing */
  }
  try {
    if (returnOffersJson != null) {
      const arr = JSON.parse(returnOffersJson) as unknown;
      returnOffersStr = Array.isArray(arr) ? JSON.stringify(arr) : undefined;
    }
  } catch {
    /* keep existing */
  }

  await prisma.shopSettings.upsert({
    where: { shopId: shop.id },
    create: {
      shopId: shop.id,
      returnWindowDays,
      minimumReturnPrice,
      returnReasonsJson: returnReasonsStr,
      returnReasonsByCategoryJson: returnReasonsByCategoryStr,
      restrictedRegionsJson: restrictedRegionsStr,
      returnOffersJson: returnOffersStr,
      returnOffersEnabled,
    },
    update: {
      returnWindowDays,
      minimumReturnPrice,
      returnOffersEnabled,
      ...(returnReasonsStr !== undefined && { returnReasonsJson: returnReasonsStr }),
      ...(returnReasonsByCategoryStr !== undefined && { returnReasonsByCategoryJson: returnReasonsByCategoryStr }),
      ...(restrictedRegionsStr !== undefined && { restrictedRegionsJson: restrictedRegionsStr }),
      ...(returnOffersStr !== undefined && { returnOffersJson: returnOffersStr }),
    },
  });
  return { success: true };
};

type CategoryReasons = { category: string; reasons: string[] };

export default function ReturnRules() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean }>();
  const [reasons, setReasons] = React.useState<string[]>(data.returnReasons);
  const [reasonInput, setReasonInput] = React.useState("");
  const [reasonsByCategory, setReasonsByCategory] = React.useState<CategoryReasons[]>(data.returnReasonsByCategory);
  const [categoryReasonInputs, setCategoryReasonInputs] = React.useState<Record<number, string>>({});
  const [regions, setRegions] = React.useState<Array<{ country?: string; province?: string }>>(data.restrictedRegions);
  const [regionInput, setRegionInput] = React.useState("");

  const [offers, setOffers] = React.useState<ReturnOffer[]>(data.returnOffers);
  const [offersEnabled, setOffersEnabled] = React.useState(data.returnOffersEnabled);
  const [showOfferForm, setShowOfferForm] = React.useState(false);
  const [newOfferReason, setNewOfferReason] = React.useState("");
  const [newOfferTag, setNewOfferTag] = React.useState("");
  const [newOfferType, setNewOfferType] = React.useState<"discount_pct" | "discount_flat">("discount_pct");
  const [newOfferValue, setNewOfferValue] = React.useState("");
  const [newOfferMessage, setNewOfferMessage] = React.useState("");

  React.useEffect(() => {
    setReasons(data.returnReasons);
    setReasonsByCategory(data.returnReasonsByCategory);
    setRegions(data.restrictedRegions);
    setOffers(data.returnOffers);
    setOffersEnabled(data.returnOffersEnabled);
  }, [data.returnReasons, data.returnReasonsByCategory, data.restrictedRegions, data.returnOffers, data.returnOffersEnabled]);

  const addOffer = () => {
    const val = parseFloat(newOfferValue);
    if (!Number.isFinite(val) || val <= 0) return;
    if (!newOfferMessage.trim()) return;
    const offer: ReturnOffer = {
      id: Date.now().toString(36),
      offerType: newOfferType,
      offerValue: val,
      message: newOfferMessage.trim(),
      ...(newOfferReason ? { reasonCode: newOfferReason } : {}),
      ...(newOfferTag.trim() ? { tag: newOfferTag.trim() } : {}),
    };
    setOffers([...offers, offer]);
    setNewOfferReason("");
    setNewOfferTag("");
    setNewOfferValue("");
    setNewOfferMessage("");
    setShowOfferForm(false);
  };

  const removeOffer = (idx: number) => {
    setOffers(offers.filter((_, i) => i !== idx));
  };

  const addReason = () => {
    const v = reasonInput.trim();
    if (v && !reasons.includes(v)) {
      setReasons([...reasons, v]);
      setReasonInput("");
    }
  };

  const removeReason = (r: string) => {
    setReasons(reasons.filter((x) => x !== r));
  };

  const addRegion = () => {
    const v = regionInput.trim();
    if (v) {
      setRegions([...regions, { country: v }]);
      setRegionInput("");
    }
  };

  const removeRegion = (idx: number) => {
    setRegions(regions.filter((_, i) => i !== idx));
  };

  const addCategory = () => {
    setReasonsByCategory([...reasonsByCategory, { category: "", reasons: [] }]);
  };
  const removeCategory = (idx: number) => {
    setReasonsByCategory(reasonsByCategory.filter((_, i) => i !== idx));
  };
  const setCategoryName = (idx: number, category: string) => {
    setReasonsByCategory(reasonsByCategory.map((c, i) => i === idx ? { ...c, category } : c));
  };
  const setCategoryReasons = (idx: number, reasons: string[]) => {
    setReasonsByCategory(reasonsByCategory.map((c, i) => i === idx ? { ...c, reasons } : c));
  };
  const addReasonToCategory = (idx: number, reason: string) => {
    const r = reason.trim();
    if (!r) return;
    const cat = reasonsByCategory[idx];
    if (cat.reasons.includes(r)) return;
    setCategoryReasons(idx, [...cat.reasons, r]);
    setCategoryReasonInputs((prev) => ({ ...prev, [idx]: "" }));
  };
  const removeReasonFromCategory = (idx: number, reason: string) => {
    setCategoryReasons(idx, reasonsByCategory[idx].reasons.filter((x) => x !== reason));
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    fd.set("returnReasonsJson", JSON.stringify(reasons));
    const byCategoryObj: Record<string, string[]> = {};
    reasonsByCategory.forEach(({ category, reasons: r }) => {
      const name = category.trim();
      if (name) byCategoryObj[name] = r;
    });
    fd.set("returnReasonsByCategoryJson", JSON.stringify(byCategoryObj));
    fd.set("restrictedRegionsJson", JSON.stringify(regions));
    fd.set("returnOffersJson", JSON.stringify(offers));
    if (offersEnabled) fd.set("returnOffersEnabled", "on");
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <s-page heading="Return Rules">
      <div className="app-content">
      {fetcher.data && "success" in fetcher.data && (
        <div className="app-alert app-alert-success">Settings saved successfully.</div>
      )}

      <fetcher.Form method="post" onSubmit={handleSubmit}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32, maxWidth: 900 }}>
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Return Offers</h3>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 16 }}>
              Offer discounts during returns to encourage customers to keep the product, reducing return costs.
            </p>
          </div>
          <s-section heading="Return Offers">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={offersEnabled} onChange={(e) => setOffersEnabled(e.target.checked)} style={{ width: 18, height: 18 }} />
                Enable return offers
              </label>
            </div>
            {offersEnabled && (
              <>
                {offers.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
                    {offers.map((o, idx) => (
                      <div key={o.id ?? idx} style={{ padding: 14, background: "#f9fafb", borderRadius: 10, border: "1px solid #e1e3e5" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                              {o.offerType === "discount_pct" ? `${o.offerValue}% off` : `$${o.offerValue} off`}
                            </div>
                            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>
                              {o.reasonCode && <span>Reason: <strong>{o.reasonCode}</strong></span>}
                              {o.reasonCode && o.tag && <span> &middot; </span>}
                              {o.tag && <span>Tag: <strong>{o.tag}</strong></span>}
                              {!o.reasonCode && !o.tag && <span style={{ fontStyle: "italic" }}>All returns</span>}
                            </div>
                            <div style={{ fontSize: 12, color: "#374151" }}>{o.message}</div>
                          </div>
                          <button type="button" onClick={() => removeOffer(idx)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #FECACA", background: "#fff", color: "#DC2626", fontSize: 12, fontWeight: 500, cursor: "pointer" }}>
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {showOfferForm ? (
                  <div style={{ padding: 16, background: "#f9fafb", borderRadius: 10, border: "1px solid #e1e3e5", marginBottom: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>New Offer</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                      <div>
                        <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Return reason (optional)</label>
                        <select value={newOfferReason} onChange={(e) => setNewOfferReason(e.target.value)} style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e1e3e5", fontSize: 13, background: "#fff" }}>
                          <option value="">Any reason</option>
                          {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Product tag (optional)</label>
                        <input type="text" placeholder="e.g. clearance" value={newOfferTag} onChange={(e) => setNewOfferTag(e.target.value)} style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e1e3e5", fontSize: 13, boxSizing: "border-box" }} />
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                      <div>
                        <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Offer type</label>
                        <select value={newOfferType} onChange={(e) => setNewOfferType(e.target.value as "discount_pct" | "discount_flat")} style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e1e3e5", fontSize: 13, background: "#fff" }}>
                          <option value="discount_pct">Percentage off (%)</option>
                          <option value="discount_flat">Flat amount off ($)</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Value</label>
                        <input type="number" placeholder={newOfferType === "discount_pct" ? "e.g. 15" : "e.g. 10"} value={newOfferValue} onChange={(e) => setNewOfferValue(e.target.value)} min={0} step="0.01" style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e1e3e5", fontSize: 13, boxSizing: "border-box" }} />
                      </div>
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Message shown to customer</label>
                      <input type="text" placeholder="Keep your item and get 15% off your next order!" value={newOfferMessage} onChange={(e) => setNewOfferMessage(e.target.value)} style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e1e3e5", fontSize: 13, boxSizing: "border-box" }} />
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <s-button type="button" variant="primary" onClick={addOffer}>Add Offer</s-button>
                      <s-button type="button" variant="secondary" onClick={() => setShowOfferForm(false)}>Cancel</s-button>
                    </div>
                  </div>
                ) : (
                  <s-button variant="secondary" type="button" onClick={() => setShowOfferForm(true)}>Add New Offer</s-button>
                )}
              </>
            )}
          </s-section>

          <div>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Return Price Rules</h3>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 16 }}>
              Products below this price are not eligible for returns.
            </p>
          </div>
          <s-section heading="Minimum Price">
            <input
              type="number"
              name="minimumReturnPrice"
              defaultValue={data.minimumReturnPrice}
              min={0}
              step="0.01"
              style={{ width: 120, padding: "9px 12px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "var(--rpm-border, 1px solid #e1e3e5)", fontSize: 14, background: "var(--rpm-surface, #fff)", color: "var(--rpm-text, #0f172a)", boxSizing: "border-box" }}
            />
          </s-section>

          <div>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Reasons</h3>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 16 }}>
              View and update allowed reasons for return
            </p>
          </div>
          <s-section heading="Search Reasons">
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                type="text"
                placeholder="Search or add reason"
                value={reasonInput}
                onChange={(e) => setReasonInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addReason())}
                style={{ flex: 1, padding: "9px 12px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "var(--rpm-border, 1px solid #e1e3e5)", fontSize: 14, background: "var(--rpm-surface, #fff)", color: "var(--rpm-text, #0f172a)" }}
              />
              <s-button type="button" variant="secondary" onClick={addReason}>Add</s-button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {reasons.map((r) => (
                <span
                  key={r}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 12px",
                    background: "#f6f6f7",
                    borderRadius: 8,
                    fontSize: 13,
                  }}
                >
                  {r}
                  <button
                    type="button"
                    onClick={() => removeReason(r)}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "#6d7175", fontSize: 16, lineHeight: 1 }}
                    aria-label={`Remove ${r}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </s-section>

          <div>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Return reasons by category</h3>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 16 }}>
              Show different reasons per product type. Category names must match your Shopify product types.
            </p>
          </div>
          <s-section heading="Category-specific reasons">
            {reasonsByCategory.map((cat, idx) => (
              <div key={idx} style={{ marginBottom: 20, padding: 16, background: "#f9fafb", borderRadius: 10, border: "1px solid #e1e3e5" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                  <input
                    type="text"
                    placeholder="Category / Product type (e.g. Apparel)"
                    value={cat.category}
                    onChange={(e) => setCategoryName(idx, e.target.value)}
                    style={{ flex: 1, maxWidth: 240, padding: "9px 12px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "var(--rpm-border, 1px solid #e1e3e5)", fontSize: 14, background: "var(--rpm-surface, #fff)", color: "var(--rpm-text, #0f172a)" }}
                  />
                  <button type="button" onClick={() => removeCategory(idx)} style={{ padding: "8px 12px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "1px solid #FECACA", background: "var(--rpm-surface, #fff)", color: "#DC2626", fontSize: 13, fontWeight: 500, cursor: "pointer", transition: "var(--rpm-transition, all 0.15s)" }}>Remove</button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  {cat.reasons.map((r) => (
                    <span key={r} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", background: "#fff", borderRadius: 8, fontSize: 13, border: "1px solid #e1e3e5" }}>
                      {r}
                      <button type="button" onClick={() => removeReasonFromCategory(idx, r)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "#6d7175", fontSize: 16 }} aria-label={`Remove ${r}`}>×</button>
                    </span>
                  ))}
                  <input
                    type="text"
                    placeholder="Add reason"
                    value={categoryReasonInputs[idx] ?? ""}
                    onChange={(e) => setCategoryReasonInputs((prev) => ({ ...prev, [idx]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addReasonToCategory(idx, (e.target as HTMLInputElement).value); } }}
                    style={{ width: 120, padding: "6px 10px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "var(--rpm-border, 1px solid #e1e3e5)", fontSize: 13, background: "var(--rpm-surface, #fff)", color: "var(--rpm-text, #0f172a)" }}
                  />
                  <button type="button" onClick={() => addReasonToCategory(idx, categoryReasonInputs[idx] ?? "")} style={{ padding: "6px 12px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "var(--rpm-border, 1px solid #e1e3e5)", background: "var(--rpm-surface, #fff)", fontSize: 13, fontWeight: 500, cursor: "pointer", color: "var(--rpm-text-secondary, #374151)", transition: "var(--rpm-transition, all 0.15s)" }}>Add</button>
                </div>
              </div>
            ))}
            <button type="button" onClick={addCategory} style={{ padding: "10px 16px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "1px dashed var(--rpm-border-color, #e1e3e5)", background: "var(--rpm-surface, #fff)", color: "var(--rpm-text-muted, #6d7175)", fontSize: 14, cursor: "pointer", transition: "var(--rpm-transition, all 0.15s)", width: "100%" }}>+ Add category</button>
          </s-section>

          <div>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Restricted regions</h3>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 16 }}>
              Orders from these countries or provinces are not eligible for returns.
            </p>
          </div>
          <s-section heading="Search country">
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                type="text"
                placeholder="Search country"
                value={regionInput}
                onChange={(e) => setRegionInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addRegion())}
                style={{ flex: 1, padding: "9px 12px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "var(--rpm-border, 1px solid #e1e3e5)", fontSize: 14, background: "var(--rpm-surface, #fff)", color: "var(--rpm-text, #0f172a)" }}
              />
              <s-button type="button" variant="secondary" onClick={addRegion}>Add</s-button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {regions.map((r, i) => (
                <span
                  key={i}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 12px",
                    background: "#f6f6f7",
                    borderRadius: 8,
                    fontSize: 13,
                  }}
                >
                  {r.country || r.province || "—"}
                  <button
                    type="button"
                    onClick={() => removeRegion(i)}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "#6d7175", fontSize: 16, lineHeight: 1 }}
                    aria-label="Remove"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </s-section>

          <div>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Return Days</h3>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 16 }}>
              Number of days after purchase within which customers can initiate a return.
            </p>
          </div>
          <s-section heading="Return Policy Duration">
            <input
              type="number"
              name="returnWindowDays"
              defaultValue={data.returnWindowDays}
              min={1}
              max={365}
              style={{ width: 120, padding: "9px 12px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "var(--rpm-border, 1px solid #e1e3e5)", fontSize: 14, background: "var(--rpm-surface, #fff)", color: "var(--rpm-text, #0f172a)", boxSizing: "border-box" }}
            />
            <span style={{ marginLeft: 8, fontSize: 14, color: "#6d7175" }}>days</span>
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
