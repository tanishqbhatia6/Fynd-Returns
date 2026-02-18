import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
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
    settings: {
      fyndCompanyId: s?.fyndCompanyId || "",
      fyndApplicationId: s?.fyndApplicationId || "",
      fyndCredentials: s?.fyndCredentials ? "[encrypted]" : "",
      policyJson: s?.policyJson || "{}",
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const fyndCompanyId = formData.get("fyndCompanyId") as string;
  const fyndApplicationId = formData.get("fyndApplicationId") as string;
  const fyndCredentials = formData.get("fyndCredentials") as string;
  const policyJson = formData.get("policyJson") as string;

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

export default function Settings() {
  const { settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  return (
    <s-page heading="Settings">
      <s-section>
        <fetcher.Form method="post">
          <s-text-field
            name="fyndCompanyId"
            label="Fynd Company ID"
            value={settings.fyndCompanyId}
          />
          <s-text-field
            name="fyndApplicationId"
            label="Fynd Application ID"
            value={settings.fyndApplicationId}
          />
          <s-text-field
            name="fyndCredentials"
            label="Fynd Access Token"
            type="password"
            value={settings.fyndCredentials === "[encrypted]" ? "" : settings.fyndCredentials}
            details="Leave blank to keep existing"
          />
          <label>Policy (JSON)</label>
          <textarea name="policyJson" rows={4} defaultValue={settings.policyJson} style={{ width: '100%', marginBottom: 16 }} />
          <s-button type="submit" loading={fetcher.state !== "idle"}>
            Save
          </s-button>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}
