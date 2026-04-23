import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { AppPage } from "../components/AppPage";
import prisma from "../db.server";
import {
  getBillingMode,
  isSuperAdmin,
  setBillingPlanOverride,
  type BillingPlanOverride,
} from "../lib/billing.server";

/**
 * Superadmin-only UI for setting the per-shop billing override.
 *
 * Access control:
 *   - Loader and action both check isSuperAdmin() against the
 *     authenticated session's email. Non-superadmins get a 404-ish
 *     "not found" redirect to /app — the route intentionally doesn't
 *     announce its existence to regular merchants.
 *   - SUPERADMIN_EMAILS env var is the source of truth. Empty list =
 *     no superadmins; this route returns 404 for everyone.
 *
 * What it does:
 *   - Lists all shops with their current override state + last
 *     subscription snapshot.
 *   - Form lets a superadmin set any shop's billingPlanOverride to
 *     "free" / "paid" / "null (default)" with a required reason.
 *   - Every change is audited on the ShopSettings row
 *     (billingPlanOverrideBy + billingPlanOverrideAt).
 */

function sessionEmailFrom(session: unknown): string | null {
  return (
    (session as { onlineAccessInfo?: { associated_user?: { email?: string } } })
      .onlineAccessInfo?.associated_user?.email ?? null
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const email = sessionEmailFrom(session);
  if (!isSuperAdmin(email)) {
    // Fail closed. Redirect to /app so the URL isn't an information
    // leak ("route exists but you can't access it").
    throw redirect("/app");
  }

  const shops = await prisma.shop.findMany({
    include: { settings: true },
    orderBy: { installedAt: "desc" },
  });
  return {
    actingEmail: email,
    mode: getBillingMode(),
    shops: shops.map((s) => ({
      shopDomain: s.shopDomain,
      installedAt: s.installedAt.toISOString(),
      override: (s.settings?.billingPlanOverride as BillingPlanOverride) ?? null,
      overrideReason: s.settings?.billingPlanOverrideReason ?? null,
      overrideBy: s.settings?.billingPlanOverrideBy ?? null,
      overrideAt: s.settings?.billingPlanOverrideAt?.toISOString() ?? null,
      subscriptionStatus: s.settings?.subscriptionStatus ?? null,
      subscriptionName: s.settings?.subscriptionName ?? null,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const email = sessionEmailFrom(session);
  if (!isSuperAdmin(email)) {
    return { error: "Forbidden" };
  }

  const fd = await request.formData();
  const shopDomain = String(fd.get("shopDomain") ?? "").trim();
  const valueRaw = String(fd.get("override") ?? "").trim();
  const reason = String(fd.get("reason") ?? "").trim();

  if (!shopDomain) return { error: "Missing shopDomain" };
  if (!reason || reason.length < 4) {
    return { error: "Provide a short reason (min 4 chars) — shows up in the audit log" };
  }

  let value: BillingPlanOverride;
  if (valueRaw === "free") value = "free";
  else if (valueRaw === "paid") value = "paid";
  else if (valueRaw === "" || valueRaw === "null") value = null;
  else return { error: `Invalid override value: ${valueRaw}` };

  await setBillingPlanOverride(shopDomain, value, reason, email!);
  return { success: `Override for ${shopDomain} set to ${value ?? "default (env)"}` };
};

export default function BillingOverridePage() {
  const { actingEmail, mode, shops } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <AppPage heading="Billing override (superadmin)">
      <div className="app-content layout-wide" style={{ paddingBottom: 48 }}>

        <div style={{
          padding: "12px 16px",
          background: "#FEF2F2",
          border: "1px solid #FECACA",
          borderRadius: 10,
          fontSize: 13,
          color: "#991B1B",
          marginBottom: 20,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>
            <strong>Internal tool.</strong> Only users in <code>SUPERADMIN_EMAILS</code>
            can see this page. Acting as <strong>{actingEmail}</strong>. Current env
            mode: <strong>{mode}</strong>.
          </span>
        </div>

        {actionData && "error" in actionData && actionData.error && (
          <div style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, fontSize: 13, color: "#991B1B", marginBottom: 16 }}>
            {actionData.error}
          </div>
        )}
        {actionData && "success" in actionData && actionData.success && (
          <div style={{ padding: "10px 14px", background: "#ECFDF5", border: "1px solid #A7F3D0", borderRadius: 8, fontSize: 13, color: "#065F46", marginBottom: 16 }}>
            {actionData.success}
          </div>
        )}

        <div style={{
          background: "#fff",
          border: "1px solid #E2E8F0",
          borderRadius: 12,
          overflow: "hidden",
        }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#F8FAFC", borderBottom: "1px solid #E2E8F0" }}>
                <th style={th}>Shop</th>
                <th style={th}>Installed</th>
                <th style={th}>Override</th>
                <th style={th}>Reason</th>
                <th style={th}>Last subscription</th>
                <th style={th}>Change</th>
              </tr>
            </thead>
            <tbody>
              {shops.map((s) => (
                <tr key={s.shopDomain} style={{ borderBottom: "1px solid #F1F5F9" }}>
                  <td style={td}>
                    <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#0F172A" }}>
                      {s.shopDomain}
                    </div>
                  </td>
                  <td style={td}>
                    <span style={{ fontSize: 12, color: "#64748B" }}>
                      {new Date(s.installedAt).toISOString().slice(0, 10)}
                    </span>
                  </td>
                  <td style={td}>
                    <OverridePill value={s.override} />
                  </td>
                  <td style={td}>
                    {s.overrideReason ? (
                      <div>
                        <div style={{ fontSize: 12, color: "#475569" }}>{s.overrideReason}</div>
                        <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>
                          by {s.overrideBy ?? "?"}{s.overrideAt ? ` on ${new Date(s.overrideAt).toISOString().slice(0, 10)}` : ""}
                        </div>
                      </div>
                    ) : (
                      <span style={{ color: "#CBD5E1", fontStyle: "italic", fontSize: 12 }}>—</span>
                    )}
                  </td>
                  <td style={td}>
                    <div style={{ fontSize: 12, color: "#475569" }}>
                      {s.subscriptionStatus ? (
                        <>
                          <span style={{ fontWeight: 600, color: s.subscriptionStatus === "active" ? "#059669" : "#DC2626" }}>
                            {s.subscriptionStatus}
                          </span>
                          {s.subscriptionName ? <> · {s.subscriptionName}</> : null}
                        </>
                      ) : (
                        <span style={{ color: "#CBD5E1", fontStyle: "italic" }}>not checked</span>
                      )}
                    </div>
                  </td>
                  <td style={td}>
                    <Form method="post" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <input type="hidden" name="shopDomain" value={s.shopDomain} />
                      <select
                        name="override"
                        defaultValue={s.override ?? ""}
                        style={{ padding: "4px 8px", border: "1px solid #CBD5E1", borderRadius: 6, fontSize: 12 }}
                      >
                        <option value="">Default (env)</option>
                        <option value="free">free</option>
                        <option value="paid">paid</option>
                      </select>
                      <input
                        name="reason"
                        placeholder="Reason (audit log)"
                        required
                        minLength={4}
                        style={{ padding: "4px 8px", border: "1px solid #CBD5E1", borderRadius: 6, fontSize: 12, width: 180 }}
                      />
                      <button
                        type="submit"
                        style={{
                          padding: "4px 10px", fontSize: 12, fontWeight: 600,
                          background: "#4F46E5", color: "#fff",
                          border: "none", borderRadius: 6, cursor: "pointer",
                        }}
                      >
                        Save
                      </button>
                    </Form>
                  </td>
                </tr>
              ))}
              {shops.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ ...td, textAlign: "center", padding: "32px 12px", color: "#94A3B8" }}>
                    No shops installed yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 16 }}>
          <Link to="/app/billing" style={{ fontSize: 13, color: "#4F46E5", fontWeight: 600, textDecoration: "none" }}>
            ← Back to billing status
          </Link>
        </div>
      </div>
    </AppPage>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 11,
  fontWeight: 700,
  color: "#64748B",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const td: React.CSSProperties = {
  padding: "10px 12px",
  verticalAlign: "top",
};

function OverridePill({ value }: { value: "free" | "paid" | null }) {
  if (value === "free") {
    return <span style={{ padding: "2px 8px", background: "#ECFDF5", color: "#065F46", border: "1px solid #A7F3D0", borderRadius: 999, fontSize: 11, fontWeight: 700 }}>FREE</span>;
  }
  if (value === "paid") {
    return <span style={{ padding: "2px 8px", background: "#FEF3C7", color: "#92400E", border: "1px solid #FDE68A", borderRadius: 999, fontSize: 11, fontWeight: 700 }}>PAID</span>;
  }
  return <span style={{ fontSize: 11, color: "#CBD5E1", fontStyle: "italic" }}>default (env)</span>;
}
