import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { login } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};

export default function Index() {
  return (
    <div style={{ padding: 48, textAlign: "center" }}>
      <h1>Return Pro Max</h1>
      <p>Fynd ↔ Shopify Returns Manager</p>
    </div>
  );
}
