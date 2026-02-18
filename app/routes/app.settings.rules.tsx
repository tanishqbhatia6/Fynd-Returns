import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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

function parseJson<T>(val: string | null, fallback: T): T {
  if (!val || !val.trim()) return fallback;
  try {
    const parsed = JSON.parse(val) as T;
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  let shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { settings: true },
  });
  if (!shop) {
    shop = await prisma.shop.create({
      data: { shopDomain: session.shop },
      include: { settings: true },
    });
  }
  const s = shop.settings;
  const reasons = parseJson<string[]>(s?.returnReasonsJson ?? null, DEFAULT_REASONS);
  const regions = parseJson<Array<{ country?: string; province?: string }>>(s?.restrictedRegionsJson ?? null, []);
  const offers = parseJson<Array<{ id?: string; reason?: string; tag?: string; discount?: string }>>(s?.returnOffersJson ?? null, []);

  return {
    returnWindowDays: s?.returnWindowDays ?? 30,
    minimumReturnPrice: s?.minimumReturnPrice != null ? String(s.minimumReturnPrice) : "0",
    returnReasons: reasons,
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
  const restrictedRegionsJson = formData.get("restrictedRegionsJson") as string | null;
  const returnOffersJson = formData.get("returnOffersJson") as string | null;

  let shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) shop = await prisma.shop.create({ data: { shopDomain: session.shop } });

  let returnReasonsStr: string | undefined;
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
      restrictedRegionsJson: restrictedRegionsStr,
      returnOffersJson: returnOffersStr,
    },
    update: {
      returnWindowDays,
      minimumReturnPrice,
      ...(returnReasonsStr !== undefined && { returnReasonsJson: returnReasonsStr }),
      ...(restrictedRegionsStr !== undefined && { restrictedRegionsJson: restrictedRegionsStr }),
      ...(returnOffersStr !== undefined && { returnOffersJson: returnOffersStr }),
    },
  });
  return { success: true };
};

export default function ReturnRules() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean }>();
  const [reasons, setReasons] = React.useState<string[]>(data.returnReasons);
  const [reasonInput, setReasonInput] = React.useState("");
  const [regions, setRegions] = React.useState<Array<{ country?: string; province?: string }>>(data.restrictedRegions);
  const [regionInput, setRegionInput] = React.useState("");

  React.useEffect(() => {
    setReasons(data.returnReasons);
    setRegions(data.restrictedRegions);
  }, [data.returnReasons, data.restrictedRegions]);

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

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    fd.set("returnReasonsJson", JSON.stringify(reasons));
    fd.set("restrictedRegionsJson", JSON.stringify(regions));
    fd.set("returnOffersJson", JSON.stringify(data.returnOffers));
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <s-page heading="Return Rules">
      {fetcher.data && "success" in fetcher.data && (
        <div style={{ padding: 12, marginBottom: 16, background: "#e8f5e9", borderRadius: 8, color: "#2e7d32" }}>
          Settings saved successfully.
        </div>
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

        <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
          <s-button type="submit" loading={fetcher.state !== "idle"}>Save</s-button>
          <Link to="/app/settings">
            <s-button variant="secondary" type="button">Discard</s-button>
          </Link>
        </div>
      </fetcher.Form>
    </s-page>
  );
}
