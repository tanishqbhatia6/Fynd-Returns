import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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
    notificationNewReturn: s?.notificationNewReturn ?? true,
    notificationApproved: s?.notificationApproved ?? true,
    notificationRejected: s?.notificationRejected ?? true,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const notificationNewReturn = formData.get("notificationNewReturn") === "on";
  const notificationApproved = formData.get("notificationApproved") === "on";
  const notificationRejected = formData.get("notificationRejected") === "on";

  let shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) shop = await prisma.shop.create({ data: { shopDomain: session.shop } });

  await prisma.shopSettings.upsert({
    where: { shopId: shop.id },
    create: {
      shopId: shop.id,
      notificationNewReturn,
      notificationApproved,
      notificationRejected,
    },
    update: {
      notificationNewReturn,
      notificationApproved,
      notificationRejected,
    },
  });
  return { success: true };
};

export default function Notifications() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean }>();

  return (
    <s-page heading="Notification">
      {fetcher.data && "success" in fetcher.data && (
        <div style={{ padding: 12, marginBottom: 16, background: "#e8f5e9", borderRadius: 8, color: "#2e7d32" }}>
          Settings saved successfully.
        </div>
      )}

      <fetcher.Form method="post">
        <p style={{ marginBottom: 24, color: "#6d7175", fontSize: 14 }}>
          Manage your notifications as needed. Choose which events trigger email or in-app notifications.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 480 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 12, padding: 16, background: "#f9fafb", borderRadius: 8, border: "1px solid #e1e3e5" }}>
            <input type="checkbox" name="notificationNewReturn" defaultChecked={data.notificationNewReturn} />
            <div>
              <div style={{ fontWeight: 600 }}>New return request</div>
              <div style={{ fontSize: 13, color: "#6d7175" }}>Notify when a customer initiates a return</div>
            </div>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 12, padding: 16, background: "#f9fafb", borderRadius: 8, border: "1px solid #e1e3e5" }}>
            <input type="checkbox" name="notificationApproved" defaultChecked={data.notificationApproved} />
            <div>
              <div style={{ fontWeight: 600 }}>Return approved</div>
              <div style={{ fontSize: 13, color: "#6d7175" }}>Notify when a return is approved</div>
            </div>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 12, padding: 16, background: "#f9fafb", borderRadius: 8, border: "1px solid #e1e3e5" }}>
            <input type="checkbox" name="notificationRejected" defaultChecked={data.notificationRejected} />
            <div>
              <div style={{ fontWeight: 600 }}>Return rejected</div>
              <div style={{ fontSize: 13, color: "#6d7175" }}>Notify when a return is rejected</div>
            </div>
          </label>
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
