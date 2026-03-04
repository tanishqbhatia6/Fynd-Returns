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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);
  const s = shop.settings;
  const reasons = parseJsonArray<string>(s?.returnReasonsJson ?? null, DEFAULT_REASONS);
  const regions = parseJsonArray<{ country?: string; province?: string }>(s?.restrictedRegionsJson ?? null, []);
  const offers = parseJsonArray<{ id?: string; reason?: string; tag?: string; discount?: string }>(s?.returnOffersJson ?? null, []);
  const reasonsByCategoryRaw = parseJsonObject<Record<string, string[]>>(s?.returnReasonsByCategoryJson ?? null, {});
  const reasonsByCategory = Object.entries(reasonsByCategoryRaw).filter(([k]) => k && typeof k === "string").map(([category, r]) => ({ category, reasons: Array.isArray(r) ? r : [] }));

  return {
    returnWindowDays: s?.returnWindowDays ?? 30,
    minimumReturnPrice: s?.minimumReturnPrice != null ? String(s.minimumReturnPrice) : "0",
    returnReasons: reasons,
    returnReasonsByCategory: reasonsByCategory,
    restrictedRegions: regions,
    returnOffers: offers,
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
    },
    update: {
      returnWindowDays,
      minimumReturnPrice,
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

  React.useEffect(() => {
    setReasons(data.returnReasons);
    setReasonsByCategory(data.returnReasonsByCategory);
    setRegions(data.restrictedRegions);
  }, [data.returnReasons, data.returnReasonsByCategory, data.restrictedRegions]);

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
    fd.set("returnOffersJson", JSON.stringify(data.returnOffers));
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
              Offer discounts during Return to reduce RTO by encouraging customers to keep the product. This lowers Return costs and boosts future purchases.
            </p>
          </div>
          <s-section heading="Return Offers">
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>
              Configure and manage Return offers based on specific reasons and order tags conditions
            </p>
            <s-button variant="secondary" type="button">Add New Offer</s-button>
          </s-section>

          <div>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Return Price Rules</h3>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 16 }}>
              To initiate a Return, product price must be greater than minimum price.
            </p>
          </div>
          <s-section heading="Minimum Price">
            <input
              type="number"
              name="minimumReturnPrice"
              defaultValue={data.minimumReturnPrice}
              min={0}
              step="0.01"
              style={{ width: 120, padding: 10, borderRadius: 6, border: "1px solid #e1e3e5" }}
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
                style={{ flex: 1, padding: 10, borderRadius: 6, border: "1px solid #e1e3e5" }}
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
              Optionally show different reasons per product type (e.g. Apparel vs Electronics). Category name should match your Shopify product type. If no category matches, the default reasons above are used.
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
                    style={{ flex: 1, maxWidth: 240, padding: 10, borderRadius: 6, border: "1px solid #e1e3e5", fontSize: 14 }}
                  />
                  <button type="button" onClick={() => removeCategory(idx)} style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid #d72c0d", background: "#fff", color: "#d72c0d", fontSize: 13, cursor: "pointer" }}>Remove category</button>
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
                    style={{ width: 120, padding: "6px 10px", borderRadius: 6, border: "1px solid #e1e3e5", fontSize: 13 }}
                  />
                  <button type="button" onClick={() => addReasonToCategory(idx, categoryReasonInputs[idx] ?? "")} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #e1e3e5", background: "#fff", fontSize: 13, cursor: "pointer" }}>Add</button>
                </div>
              </div>
            ))}
            <button type="button" onClick={addCategory} style={{ padding: "10px 16px", borderRadius: 8, border: "1px dashed #e1e3e5", background: "#fff", color: "#6d7175", fontSize: 14, cursor: "pointer" }}>+ Add category</button>
          </s-section>

          <div>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Return restrict countries and provinces</h3>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 16 }}>
              Orders not returnable from selected countries and provinces
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
                style={{ flex: 1, padding: 10, borderRadius: 6, border: "1px solid #e1e3e5" }}
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
              Establish the return window as the designated time frame during which customers can initiate a return.
            </p>
          </div>
          <s-section heading="Return Policy Duration">
            <input
              type="number"
              name="returnWindowDays"
              defaultValue={data.returnWindowDays}
              min={1}
              max={365}
              style={{ width: 120, padding: 10, borderRadius: 6, border: "1px solid #e1e3e5" }}
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
