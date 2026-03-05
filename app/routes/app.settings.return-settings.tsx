import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseJsonArray } from "../lib/parse-json";
import { findOrCreateShop } from "../lib/shop.server";
import { fetchAllLocations } from "../lib/shopify-admin.server";
import type { ShopLocation } from "../lib/shopify-admin.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);
  const s = shop.settings;
  const tags = parseJsonArray<string>(s?.restrictedProductTagsJson ?? null, []);
  const refundPrepaid = parseJsonArray<string>(s?.refundMethodPrepaidJson ?? null, ["bank_details"]);
  const refundCOD = parseJsonArray<string>(s?.refundMethodCODJson ?? null, []);

  let shopLocations: ShopLocation[] = [];
  try {
    shopLocations = await fetchAllLocations(admin);
  } catch { /* non-fatal */ }

  const refundLocationMode = (s as { refundLocationMode?: string } | null | undefined)?.refundLocationMode ?? "auto";
  const refundLocationId = (s as { refundLocationId?: string | null } | null | undefined)?.refundLocationId ?? null;

  return {
    noReturnPeriodEnabled: s?.noReturnPeriodEnabled ?? false,
    noReturnPeriodStart: s?.noReturnPeriodStart ? new Date(s.noReturnPeriodStart).toISOString().slice(0, 10) : "",
    noReturnPeriodEnd: s?.noReturnPeriodEnd ? new Date(s.noReturnPeriodEnd).toISOString().slice(0, 10) : "",
    restrictedProductTags: tags,
    photoRequired: s?.photoRequired ?? false,
    returnFeeAmount: s?.returnFeeAmount != null ? String(s.returnFeeAmount) : "0",
    returnFeeCurrency: s?.returnFeeCurrency ?? "USD",
    refundMethodPrepaid: refundPrepaid,
    refundMethodCOD: refundCOD,
    autoApproveEnabled: s?.autoApproveEnabled ?? false,
    autoRefundEnabled: s?.autoRefundEnabled ?? false,
    refundLocationMode,
    refundLocationId,
    shopLocations,
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
  const refundMethodPrepaidJson = formData.get("refundMethodPrepaidJson") as string | null;
  const refundMethodCODJson = formData.get("refundMethodCODJson") as string | null;
  const autoApproveEnabled = formData.get("autoApproveEnabled") === "on";
  const autoRefundEnabled = formData.get("autoRefundEnabled") === "on";
  const refundLocationMode = (formData.get("refundLocationMode") as string) ?? "auto";
  const refundLocationId = (formData.get("refundLocationId") as string | null) || null;

  const shop = await findOrCreateShop(session.shop);

  let tagsStr: string | undefined;
  let prepaidStr: string | undefined;
  let codStr: string | undefined;
  try {
    if (restrictedProductTagsJson != null) {
      const arr = JSON.parse(restrictedProductTagsJson) as unknown;
      tagsStr = Array.isArray(arr) ? JSON.stringify(arr) : undefined;
    }
  } catch {
    /* keep existing */
  }
  try {
    if (refundMethodPrepaidJson != null) {
      const arr = JSON.parse(refundMethodPrepaidJson) as unknown;
      prepaidStr = Array.isArray(arr) ? JSON.stringify(arr) : undefined;
    }
  } catch {
    /* keep existing */
  }
  try {
    if (refundMethodCODJson != null) {
      const arr = JSON.parse(refundMethodCODJson) as unknown;
      codStr = Array.isArray(arr) ? JSON.stringify(arr) : undefined;
    }
  } catch {
    /* keep existing */
  }

  const noStart = noReturnPeriodEnabled && noReturnPeriodStart && noReturnPeriodStart.trim() ? new Date(noReturnPeriodStart) : null;
  const noEnd = noReturnPeriodEnabled && noReturnPeriodEnd && noReturnPeriodEnd.trim() ? new Date(noReturnPeriodEnd) : null;

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
      refundMethodPrepaidJson: prepaidStr,
      refundMethodCODJson: codStr,
      autoApproveEnabled,
      autoRefundEnabled,
      refundLocationMode,
      refundLocationId,
    },
    update: {
      noReturnPeriodEnabled,
      noReturnPeriodStart: noStart,
      noReturnPeriodEnd: noEnd,
      restrictedProductTagsJson: tagsStr ?? undefined,
      photoRequired,
      returnFeeAmount,
      returnFeeCurrency,
      refundMethodPrepaidJson: prepaidStr ?? undefined,
      refundMethodCODJson: codStr ?? undefined,
      autoApproveEnabled,
      autoRefundEnabled,
      refundLocationMode,
      refundLocationId,
    },
  });
  return { success: true };
};

export default function ReturnSettings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean }>();
  const [tags, setTags] = React.useState<string[]>(data.restrictedProductTags);
  const [tagInput, setTagInput] = React.useState("");
  const [prepaid, setPrepaid] = React.useState<string[]>(data.refundMethodPrepaid);
  const [cod, setCod] = React.useState<string[]>(data.refundMethodCOD);
  const [activeTab, setActiveTab] = React.useState<"prepaid" | "cod">("prepaid");
  const [locationMode, setLocationMode] = React.useState<"auto" | "manual">(data.refundLocationMode === "manual" ? "manual" : "auto");
  const [selectedLocId, setSelectedLocId] = React.useState(data.refundLocationId ?? "");

  React.useEffect(() => {
    setTags(data.restrictedProductTags);
    setPrepaid(data.refundMethodPrepaid);
    setCod(data.refundMethodCOD);
    setLocationMode(data.refundLocationMode === "manual" ? "manual" : "auto");
    setSelectedLocId(data.refundLocationId ?? "");
  }, [data.restrictedProductTags, data.refundMethodPrepaid, data.refundMethodCOD, data.refundLocationMode, data.refundLocationId]);

  const addTag = () => {
    const v = tagInput.trim();
    if (v && !tags.includes(v)) {
      setTags([...tags, v]);
      setTagInput("");
    }
  };

  const removeTag = (t: string) => setTags(tags.filter((x) => x !== t));

  const togglePrepaid = (opt: string) => {
    setPrepaid((prev) => (prev.includes(opt) ? prev.filter((x) => x !== opt) : [...prev, opt]));
  };

  const toggleCOD = (opt: string) => {
    setCod((prev) => (prev.includes(opt) ? prev.filter((x) => x !== opt) : [...prev, opt]));
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    fd.set("restrictedProductTagsJson", JSON.stringify(tags));
    fd.set("refundMethodPrepaidJson", JSON.stringify(prepaid));
    fd.set("refundMethodCODJson", JSON.stringify(cod));
    fd.set("refundLocationMode", locationMode);
    fd.set("refundLocationId", selectedLocId);
    fetcher.submit(fd, { method: "post" });
  };

  const prepaidOpts = ["bank_details", "origin_source", "others"];
  const codOpts = ["bank_details", "origin_source", "others"];

  return (
    <s-page heading="Return Settings">
      <div className="app-content">
      {fetcher.data && "success" in fetcher.data && (
        <div className="app-alert app-alert-success">Settings saved successfully.</div>
      )}

      <fetcher.Form method="post" onSubmit={handleSubmit}>
        <div style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 24 }}>
          {/* No Return Period */}
          <s-section>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>No Return Period</div>
              <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>
                During a specified promotional or sale event, returns for items purchased within that period will not be processed. Note the date range.
              </p>
              {data.noReturnPeriodEnabled ? (
                <div style={{ padding: 16, background: "#f6f6f7", borderRadius: 8, marginBottom: 12 }}>
                  <p style={{ fontSize: 13, marginBottom: 8 }}>Return restrict period is enabled.</p>
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
                <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>Currently return restrict period is disabled.</p>
              )}
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" name="noReturnPeriodEnabled" defaultChecked={data.noReturnPeriodEnabled} />
                <span>Enable no-return period</span>
              </label>
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

          {/* Photo Required */}
          <s-section>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Photo Required</div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>
              Set up exchange settings that benefit both customers and the business for maximum convenience.
            </p>
            <p style={{ fontSize: 13, marginBottom: 12 }}>Please share item photos for better assistance with inquiries or concerns.</p>
            <div style={{ display: "flex", gap: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="radio" name="photoRequired" value="on" defaultChecked={data.photoRequired} />
                <span>Yes</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="radio" name="photoRequired" value="off" defaultChecked={!data.photoRequired} />
                <span>No</span>
              </label>
            </div>
          </s-section>

          {/* Return Fee */}
          <s-section>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Return Fee</div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>
              Configure a return fee that is subtracted from the refund amount automatically during the return process.
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <select name="returnFeeCurrency" defaultValue={data.returnFeeCurrency} style={{ padding: 10, borderRadius: 6, border: "1px solid #e1e3e5" }}>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="INR">INR</option>
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

          {/* Payment methods of return process */}
          <s-section>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Payment methods of return process</div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>
              Customers can choose refund method based on original payment type.
            </p>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button type="button" onClick={() => setActiveTab("prepaid")} style={{ padding: "8px 16px", borderRadius: 6, border: activeTab === "prepaid" ? "2px solid #005bd3" : "1px solid #e1e3e5", background: activeTab === "prepaid" ? "#f0f6ff" : "#fff", cursor: "pointer", fontWeight: 500 }}>
                Prepaid/Online paid orders
              </button>
              <button type="button" onClick={() => setActiveTab("cod")} style={{ padding: "8px 16px", borderRadius: 6, border: activeTab === "cod" ? "2px solid #005bd3" : "1px solid #e1e3e5", background: activeTab === "cod" ? "#f0f6ff" : "#fff", cursor: "pointer", fontWeight: 500 }}>
                Bank Transfer, Cheque, COD
              </button>
            </div>
            {activeTab === "prepaid" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {prepaidOpts.map((opt) => (
                  <label key={opt} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={prepaid.includes(opt)} onChange={() => togglePrepaid(opt)} />
                    <span style={{ textTransform: "capitalize" }}>{opt.replace(/_/g, " ")}</span>
                  </label>
                ))}
              </div>
            )}
            {activeTab === "cod" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {codOpts.map((opt) => (
                  <label key={opt} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={cod.includes(opt)} onChange={() => toggleCOD(opt)} />
                    <span style={{ textTransform: "capitalize" }}>{opt.replace(/_/g, " ")}</span>
                  </label>
                ))}
              </div>
            )}
          </s-section>

          {/* Auto Approval */}
          <s-section>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Auto Approval</div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>
              You have the flexibility to either manually approve return requests or opt for an automatic approval process.
            </p>
            <div style={{ display: "flex", gap: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="radio" name="autoApproveEnabled" value="on" defaultChecked={data.autoApproveEnabled} />
                <span>Return request approve automatically — Yes</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="radio" name="autoApproveEnabled" value="off" defaultChecked={!data.autoApproveEnabled} />
                <span>No</span>
              </label>
            </div>
          </s-section>

          {/* Auto Refund */}
          <s-section>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Auto Refund on Credit Note</div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 12 }}>
              When Fynd generates a credit note (status: credit_note_generated), automatically trigger a Shopify refund.
              If disabled, refunds must be processed manually from the return detail page.
            </p>
            <div style={{ display: "flex", gap: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="radio" name="autoRefundEnabled" value="on" defaultChecked={data.autoRefundEnabled} />
                <span>Auto-refund on credit note — Yes</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="radio" name="autoRefundEnabled" value="off" defaultChecked={!data.autoRefundEnabled} />
                <span>No</span>
              </label>
            </div>
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
