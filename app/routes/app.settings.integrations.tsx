import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { encrypt } from "../lib/encryption.server";

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
  return {
    fyndCompanyId: s?.fyndCompanyId || "",
    fyndApplicationId: s?.fyndApplicationId || "",
    fyndCredentials: s?.fyndCredentials ? "[encrypted]" : "",
    policyJson: s?.policyJson || "{}",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const fyndCompanyId = String(formData.get("fyndCompanyId") ?? "").trim();
  const fyndApplicationId = String(formData.get("fyndApplicationId") ?? "").trim();
  const fyndCredentials = formData.get("fyndCredentials") as string | null;
  const policyJson = String(formData.get("policyJson") ?? "{}").trim();

  let shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, include: { settings: true } });
  if (!shop) shop = await prisma.shop.create({ data: { shopDomain: session.shop }, include: { settings: true } });

  let credsToStore = shop.settings?.fyndCredentials;
  if (fyndCredentials && fyndCredentials !== "[encrypted]") {
    credsToStore = encrypt(JSON.stringify({ accessToken: fyndCredentials }));
  }

  await prisma.shopSettings.upsert({
    where: { shopId: shop.id },
    create: {
      shopId: shop.id,
      fyndCompanyId: fyndCompanyId || null,
      fyndApplicationId: fyndApplicationId || null,
      fyndCredentials: credsToStore,
      policyJson: policyJson || null,
    },
    update: {
      fyndCompanyId: fyndCompanyId || undefined,
      fyndApplicationId: fyndApplicationId || undefined,
      fyndCredentials: credsToStore ?? undefined,
      policyJson: policyJson || undefined,
    },
  });
  return { success: true };
};

export default function Integrations() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();

  return (
    <s-page heading="Partner Integrations">
      {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
        <div style={{ padding: 12, marginBottom: 16, background: "#fef2f2", borderRadius: 8, color: "#d72c0d" }}>
          {fetcher.data.error}
        </div>
      )}
      {fetcher.data && "success" in fetcher.data && (
        <div style={{ padding: 12, marginBottom: 16, background: "#e8f5e9", borderRadius: 8, color: "#2e7d32" }}>
          Settings saved successfully.
        </div>
      )}

      <fetcher.Form method="post">
        <p style={{ marginBottom: 24, color: "#6d7175", fontSize: 14 }}>
          Manage your partner integrations. Connect Fynd for reverse logistics and return fulfillment.
        </p>
        <s-section heading="Fynd integration">
          <s-text-field
            name="fyndCompanyId"
            label="Fynd Company ID"
            value={data.fyndCompanyId}
          />
          <s-text-field
            name="fyndApplicationId"
            label="Fynd Application ID"
            value={data.fyndApplicationId}
          />
          <s-text-field
            name="fyndCredentials"
            label="Fynd Access Token"
            type="password"
            value={data.fyndCredentials === "[encrypted]" ? "" : data.fyndCredentials}
            details="Leave blank to keep existing"
          />
          <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Policy (JSON)</label>
          <textarea name="policyJson" rows={4} defaultValue={data.policyJson} style={{ width: "100%", marginBottom: 16, padding: 12, borderRadius: 8, border: "1px solid #e1e3e5" }} />
        </s-section>
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
