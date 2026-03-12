import React, { useState, useCallback } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, Link } from "react-router";
import { authenticate } from "../shopify.server";

/* ─── Types ─── */

type OrderLineItem = {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  price: string;
  imageUrl: string | null;
};

type OrderData = {
  id: string;
  name: string;
  createdAt: string;
  email: string | null;
  phone: string | null;
  currencyCode: string;
  shippingAddress: {
    firstName?: string;
    lastName?: string;
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    zip?: string;
    country?: string;
    landmark?: string;
  } | null;
  lineItems: OrderLineItem[];
};

type SelectedItem = {
  lineItemId: string;
  qty: number;
  reasonCode: string;
  condition: string;
  notes: string;
};

/* ─── Constants ─── */

const REASON_CODES = [
  { value: "", label: "Select reason..." },
  { value: "size_issue", label: "Size Issue" },
  { value: "quality_issue", label: "Quality Issue" },
  { value: "wrong_item", label: "Wrong Item" },
  { value: "damaged", label: "Damaged" },
  { value: "changed_mind", label: "Changed Mind" },
  { value: "not_as_described", label: "Not as Described" },
  { value: "other", label: "Other" },
];

const CONDITIONS = [
  { value: "", label: "Select condition..." },
  { value: "new_with_tags", label: "New with Tags" },
  { value: "new_without_tags", label: "New without Tags" },
  { value: "used_like_new", label: "Used - Like New" },
  { value: "used_fair", label: "Used - Fair" },
  { value: "used_poor", label: "Used - Poor" },
  { value: "damaged", label: "Damaged" },
];

const RESOLUTION_TYPES = [
  { value: "refund", label: "Refund" },
  { value: "exchange", label: "Exchange" },
  { value: "store_credit", label: "Store Credit" },
  { value: "replacement", label: "Replacement" },
];

const TOTAL_STEPS = 4;

const STEP_LABELS = [
  { num: 1, label: "Order Lookup" },
  { num: 2, label: "Select Items" },
  { num: 3, label: "Customer & CRM" },
  { num: 4, label: "Review & Submit" },
];

/* ─── Styles ─── */

const S = {
  page: { maxWidth: 760, margin: "0 auto", padding: "0 0 40px" } as React.CSSProperties,

  section: {
    background: "#fff",
    borderRadius: 12,
    border: "1px solid #e5e7eb",
    padding: "24px 28px",
    marginBottom: 20,
  } as React.CSSProperties,

  sectionTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: "#111827",
    marginBottom: 4,
  } as React.CSSProperties,

  sectionSubtitle: {
    fontSize: 13,
    color: "#6b7280",
    marginBottom: 16,
  } as React.CSSProperties,

  label: {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: "#374151",
    marginBottom: 5,
  } as React.CSSProperties,

  input: {
    width: "100%",
    padding: "9px 12px",
    borderRadius: 8,
    border: "1px solid #d1d5db",
    fontSize: 13,
    color: "#111827",
    background: "#fff",
    outline: "none",
    transition: "border-color 0.15s",
    boxSizing: "border-box" as const,
  } as React.CSSProperties,

  select: {
    width: "100%",
    padding: "9px 12px",
    borderRadius: 8,
    border: "1px solid #d1d5db",
    fontSize: 13,
    color: "#111827",
    background: "#fff",
    outline: "none",
    boxSizing: "border-box" as const,
  } as React.CSSProperties,

  textarea: {
    width: "100%",
    padding: "9px 12px",
    borderRadius: 8,
    border: "1px solid #d1d5db",
    fontSize: 13,
    color: "#111827",
    background: "#fff",
    outline: "none",
    minHeight: 72,
    resize: "vertical" as const,
    fontFamily: "inherit",
    boxSizing: "border-box" as const,
  } as React.CSSProperties,

  btnPrimary: {
    padding: "10px 24px",
    borderRadius: 8,
    border: "none",
    background: "#4f46e5",
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    transition: "background 0.15s",
  } as React.CSSProperties,

  btnSecondary: {
    padding: "10px 24px",
    borderRadius: 8,
    border: "1px solid #d1d5db",
    background: "#fff",
    color: "#374151",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    transition: "all 0.15s",
  } as React.CSSProperties,

  btnSuccess: {
    padding: "10px 24px",
    borderRadius: 8,
    border: "none",
    background: "#059669",
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    transition: "background 0.15s",
  } as React.CSSProperties,

  stepper: {
    display: "flex",
    alignItems: "center",
    gap: 0,
    marginBottom: 28,
  } as React.CSSProperties,

  fieldRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 14,
    marginBottom: 14,
  } as React.CSSProperties,

  fieldGroup: {
    marginBottom: 14,
  } as React.CSSProperties,

  alertError: {
    padding: "12px 16px",
    borderRadius: 8,
    background: "#FEF2F2",
    border: "1px solid #FECACA",
    color: "#DC2626",
    fontSize: 13,
    fontWeight: 500,
    marginBottom: 16,
  } as React.CSSProperties,

  alertSuccess: {
    padding: "16px 20px",
    borderRadius: 10,
    background: "#F0FDF4",
    border: "1px solid #BBF7D0",
    color: "#166534",
    fontSize: 14,
    fontWeight: 500,
    marginBottom: 16,
  } as React.CSSProperties,

  alertWarning: {
    padding: "12px 16px",
    borderRadius: 8,
    background: "#FFFBEB",
    border: "1px solid #FDE68A",
    color: "#92400E",
    fontSize: 12,
    fontWeight: 500,
  } as React.CSSProperties,

  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "6px 0",
    fontSize: 13,
    color: "#374151",
    borderBottom: "1px solid #f3f4f6",
  } as React.CSSProperties,

  summaryLabel: {
    fontWeight: 500,
    color: "#6b7280",
    fontSize: 12,
  } as React.CSSProperties,

  summaryValue: {
    fontWeight: 600,
    color: "#111827",
    fontSize: 13,
  } as React.CSSProperties,

  radioGroup: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 12,
    marginTop: 6,
  } as React.CSSProperties,

  radioLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 16px",
    borderRadius: 8,
    border: "1px solid #d1d5db",
    fontSize: 13,
    fontWeight: 500,
    color: "#374151",
    cursor: "pointer",
    transition: "all 0.15s",
    background: "#fff",
  } as React.CSSProperties,

  radioLabelActive: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 16px",
    borderRadius: 8,
    border: "2px solid #4f46e5",
    fontSize: 13,
    fontWeight: 600,
    color: "#4f46e5",
    cursor: "pointer",
    transition: "all 0.15s",
    background: "#EEF2FF",
  } as React.CSSProperties,
};

/* ─── Loader ─── */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { shopDomain: session.shop };
};

/* ─── Spinner Component ─── */

function Spinner({ size = 14, color = "#fff" }: { size?: number; color?: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        border: `2px solid ${color}33`,
        borderTopColor: color,
        borderRadius: "50%",
        animation: "spin 0.6s linear infinite",
      }}
    />
  );
}

/* ─── Step Indicator Badge ─── */

function StepBadge({ current, total }: { current: number; total: number }) {
  return (
    <span style={{
      fontSize: 11,
      fontWeight: 600,
      color: "#6b7280",
      background: "#f3f4f6",
      padding: "3px 10px",
      borderRadius: 20,
      letterSpacing: "0.02em",
    }}>
      Step {current} of {total}
    </span>
  );
}

/* ─── Component ─── */

export default function CreateReturn() {
  const { shopDomain } = useLoaderData<typeof loader>();
  const orderFetcher = useFetcher();
  const submitFetcher = useFetcher();

  // Step management
  const [step, setStep] = useState(1);

  // Step 1: order lookup
  const [orderInput, setOrderInput] = useState("");

  // Step 2: item selection
  const [selectedItems, setSelectedItems] = useState<Record<string, SelectedItem>>({});

  // Step 3: customer + CRM details
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerAddress1, setCustomerAddress1] = useState("");
  const [customerAddress2, setCustomerAddress2] = useState("");
  const [customerCity, setCustomerCity] = useState("");
  const [customerProvince, setCustomerProvince] = useState("");
  const [customerZip, setCustomerZip] = useState("");
  const [customerCountry, setCustomerCountry] = useState("");
  const [customerLandmark, setCustomerLandmark] = useState("");

  const [crmTicketId, setCrmTicketId] = useState("");
  const [agentName, setAgentName] = useState("Admin");
  const [crmNotes, setCrmNotes] = useState("");
  const [resolutionType, setResolutionType] = useState<"refund" | "exchange" | "store_credit" | "replacement">("refund");
  const [exchangePreference, setExchangePreference] = useState("");
  const [overrideEligibility, setOverrideEligibility] = useState(false);

  // Validation
  const [validationError, setValidationError] = useState<string | null>(null);

  // Derived data from order fetch
  const orderData: OrderData | null =
    orderFetcher.data && !orderFetcher.data.error ? orderFetcher.data.order ?? null : null;
  const orderError: string | null =
    orderFetcher.data?.error ?? null;
  const isOrderLoading = orderFetcher.state === "loading" || orderFetcher.state === "submitting";

  // Submit state
  const isSubmitting = submitFetcher.state === "submitting" || submitFetcher.state === "loading";
  const submitError: string | null = submitFetcher.data && !submitFetcher.data.success ? (submitFetcher.data.error ?? null) : null;
  const submitSuccess = submitFetcher.data?.success === true;
  const createdReturnCase = submitFetcher.data?.returnCase ?? null;

  // Handle redirect on success
  React.useEffect(() => {
    if (submitSuccess && createdReturnCase?.id) {
      window.location.href = `/app/returns/${createdReturnCase.id}`;
    }
  }, [submitSuccess, createdReturnCase]);

  /* ── Step 1: search order ── */
  const handleOrderSearch = useCallback(() => {
    const trimmed = orderInput.trim().replace(/^#/, "");
    if (!trimmed) {
      setValidationError("Please enter an order number.");
      return;
    }
    setValidationError(null);
    orderFetcher.load(
      `/api/portal/order?shop=${encodeURIComponent(shopDomain)}&orderNumber=${encodeURIComponent(trimmed)}`
    );
  }, [orderInput, shopDomain, orderFetcher]);

  // Auto-advance to step 2 on successful order fetch + pre-fill customer data
  React.useEffect(() => {
    if (orderData && step === 1) {
      const addr = orderData.shippingAddress;
      setCustomerEmail(orderData.email ?? "");
      setCustomerPhone(orderData.phone ?? "");
      if (addr) {
        setCustomerName(
          `${addr.firstName ?? ""} ${addr.lastName ?? ""}`.trim()
        );
        setCustomerAddress1(addr.address1 ?? "");
        setCustomerAddress2(addr.address2 ?? "");
        setCustomerCity(addr.city ?? "");
        setCustomerProvince(addr.province ?? "");
        setCustomerZip(addr.zip ?? "");
        setCustomerCountry(addr.country ?? "");
        setCustomerLandmark(addr.landmark ?? "");
      }
      setSelectedItems({});
      setStep(2);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderData]);

  /* ── Step 2: item selection helpers ── */
  const toggleItem = useCallback((id: string) => {
    setSelectedItems((prev) => {
      const next = { ...prev };
      if (next[id]) {
        delete next[id];
      } else {
        const li = orderData?.lineItems.find((l) => l.id === id);
        next[id] = {
          lineItemId: id,
          qty: li?.quantity ?? 1,
          reasonCode: "",
          condition: "",
          notes: "",
        };
      }
      return next;
    });
  }, [orderData]);

  const updateItem = useCallback(
    (id: string, field: keyof SelectedItem, value: string | number) => {
      setSelectedItems((prev) => ({
        ...prev,
        [id]: { ...prev[id], [field]: value },
      }));
    },
    []
  );

  const validateStep2 = useCallback((): boolean => {
    const items = Object.values(selectedItems);
    if (items.length === 0) {
      setValidationError("Please select at least one item to return.");
      return false;
    }
    for (const item of items) {
      if (!item.reasonCode) {
        setValidationError("Please select a return reason for all selected items.");
        return false;
      }
      if (!item.condition) {
        setValidationError("Please select the item condition for all selected items.");
        return false;
      }
      if (item.qty < 1) {
        setValidationError("Quantity must be at least 1 for all selected items.");
        return false;
      }
    }
    setValidationError(null);
    return true;
  }, [selectedItems]);

  const handleStep2Next = useCallback(() => {
    if (validateStep2()) setStep(3);
  }, [validateStep2]);

  /* ── Step 3: validate and proceed to review ── */
  const validateStep3 = useCallback((): boolean => {
    if (!customerEmail.trim()) {
      setValidationError("Customer email is required.");
      return false;
    }
    if (!resolutionType) {
      setValidationError("Please select a resolution type.");
      return false;
    }
    setValidationError(null);
    return true;
  }, [customerEmail, resolutionType]);

  const handleStep3Next = useCallback(() => {
    if (validateStep3()) setStep(4);
  }, [validateStep3]);

  /* ── Step 4: submit ── */
  const handleSubmit = useCallback(() => {
    if (!orderData) return;

    const items = Object.values(selectedItems).map((si) => ({
      lineItemId: si.lineItemId,
      qty: si.qty,
      reasonCode: si.reasonCode || undefined,
      notes: si.notes || undefined,
      condition: si.condition || undefined,
    }));

    const lineItemsWithPrice = Object.values(selectedItems).map((si) => {
      const li = orderData.lineItems.find((l) => l.id === si.lineItemId);
      return {
        id: si.lineItemId,
        title: li?.title,
        variantTitle: li?.variantTitle ?? undefined,
        price: li?.price,
        imageUrl: li?.imageUrl ?? undefined,
      };
    });

    const body = {
      shopifyOrderName: orderData.name,
      items,
      customerEmail: customerEmail.trim() || undefined,
      customerPhone: customerPhone.trim() || undefined,
      customerName: customerName.trim() || undefined,
      customerCity: customerCity.trim() || undefined,
      customerCountry: customerCountry.trim() || undefined,
      customerAddress1: customerAddress1.trim() || undefined,
      customerAddress2: customerAddress2.trim() || undefined,
      customerProvince: customerProvince.trim() || undefined,
      customerZip: customerZip.trim() || undefined,
      customerLandmark: customerLandmark.trim() || undefined,
      resolutionType,
      exchangePreference: resolutionType === "exchange" ? exchangePreference.trim() || undefined : undefined,
      crmTicketId: crmTicketId.trim() || undefined,
      crmNotes: crmNotes.trim() || undefined,
      createdByStaff: agentName.trim() || "Admin",
      adminOverride: overrideEligibility || undefined,
      currency: orderData.currencyCode || undefined,
      orderCreatedAt: orderData.createdAt || undefined,
      lineItemsWithPrice,
    };

    submitFetcher.submit(JSON.stringify(body), {
      method: "POST",
      action: "/api/admin/create-return",
      encType: "application/json",
    });
  }, [
    orderData, selectedItems, customerEmail, customerPhone, customerName,
    customerCity, customerCountry, customerAddress1, customerAddress2,
    customerProvince, customerZip, customerLandmark, resolutionType,
    exchangePreference, crmTicketId, crmNotes, agentName, overrideEligibility,
    submitFetcher,
  ]);

  /* ── Helper: get readable label for reason/condition ── */
  const getReasonLabel = (code: string) =>
    REASON_CODES.find((r) => r.value === code)?.label ?? code;
  const getConditionLabel = (code: string) =>
    CONDITIONS.find((c) => c.value === code)?.label ?? code;
  const getResolutionLabel = (val: string) =>
    RESOLUTION_TYPES.find((r) => r.value === val)?.label ?? val;

  /* ── Computed totals for summary ── */
  const selectedItemsList = Object.values(selectedItems);
  const estimatedTotal = selectedItemsList.reduce((sum, si) => {
    const li = orderData?.lineItems.find((l) => l.id === si.lineItemId);
    return sum + (parseFloat(li?.price ?? "0") * si.qty);
  }, 0);

  return (
    <div style={S.page}>
      {/* Spinner animation keyframes */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ── Back link ── */}
      <div style={{ marginBottom: 20, display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#6b7280" }}>
        <Link
          to="/app/returns"
          style={{ color: "#4f46e5", textDecoration: "none", fontWeight: 500, display: "flex", alignItems: "center", gap: 4 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Returns
        </Link>
        <span>/</span>
        <span style={{ color: "#111827", fontWeight: 600 }}>Create Return</span>
      </div>

      {/* ── Page heading ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "#111827", margin: 0 }}>Create Return</h1>
        <StepBadge current={step} total={TOTAL_STEPS} />
      </div>

      {/* ── Step Indicator ── */}
      <div style={S.stepper}>
        {STEP_LABELS.map((s, idx) => {
          const isActive = step === s.num;
          const isDone = step > s.num;
          return (
            <React.Fragment key={s.num}>
              {idx > 0 && (
                <div style={{
                  flex: 1,
                  height: 2,
                  background: isDone ? "#4f46e5" : "#e5e7eb",
                  transition: "background 0.2s",
                }} />
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 700,
                  flexShrink: 0,
                  background: isDone ? "#4f46e5" : isActive ? "#EEF2FF" : "#f3f4f6",
                  color: isDone ? "#fff" : isActive ? "#4f46e5" : "#9ca3af",
                  border: isActive ? "2px solid #4f46e5" : isDone ? "2px solid #4f46e5" : "2px solid #e5e7eb",
                  transition: "all 0.2s",
                }}>
                  {isDone ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    s.num
                  )}
                </div>
                <span style={{
                  fontSize: 12,
                  fontWeight: isActive ? 700 : 500,
                  color: isActive ? "#111827" : isDone ? "#4f46e5" : "#9ca3af",
                  whiteSpace: "nowrap",
                }}>
                  {s.label}
                </span>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* ════════════════════════════════════════════════════════════════
          STEP 1 — Order Lookup
         ════════════════════════════════════════════════════════════════ */}
      {step === 1 && (
        <div style={S.section}>
          <div style={S.sectionTitle}>Look up Order</div>
          <div style={S.sectionSubtitle}>
            Enter the Shopify order number to load items for the return.
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <label style={S.label}>Order Number</label>
              <input
                type="text"
                value={orderInput}
                onChange={(e) => { setOrderInput(e.target.value); setValidationError(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleOrderSearch();
                  }
                }}
                placeholder="e.g. 1042, #1042"
                style={S.input}
                autoFocus
              />
            </div>
            <button
              type="button"
              onClick={handleOrderSearch}
              disabled={isOrderLoading}
              style={{
                ...S.btnPrimary,
                opacity: isOrderLoading ? 0.6 : 1,
                cursor: isOrderLoading ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {isOrderLoading ? (
                <>
                  <Spinner />
                  Searching...
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  Search
                </>
              )}
            </button>
          </div>

          {validationError && (
            <div style={{ ...S.alertError, marginTop: 12 }}>{validationError}</div>
          )}

          {orderError && (
            <div style={{ ...S.alertError, marginTop: 12 }}>{orderError}</div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════
          STEP 2 — Item Selection
         ════════════════════════════════════════════════════════════════ */}
      {step === 2 && orderData && (
        <div>
          {/* Order summary bar */}
          <div style={{
            ...S.section,
            padding: "14px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#f9fafb",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Order
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>
                  {orderData.name}
                </div>
              </div>
              <div style={{ width: 1, height: 28, background: "#e5e7eb" }} />
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Customer
                </div>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#111827" }}>
                  {orderData.email ?? "N/A"}
                </div>
              </div>
              <div style={{ width: 1, height: 28, background: "#e5e7eb" }} />
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Items
                </div>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#111827" }}>
                  {orderData.lineItems.length}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => { setStep(1); setSelectedItems({}); setValidationError(null); }}
              style={{ ...S.btnSecondary, padding: "6px 14px", fontSize: 12 }}
            >
              Change Order
            </button>
          </div>

          {/* Items list */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Select Items to Return</div>
            <div style={S.sectionSubtitle}>
              Check the items the customer wants to return, set quantity, reason, and condition.
            </div>

            {validationError && <div style={S.alertError}>{validationError}</div>}

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {orderData.lineItems.map((li) => {
                const isChecked = !!selectedItems[li.id];
                const sel = selectedItems[li.id];

                return (
                  <div
                    key={li.id}
                    style={{
                      padding: "14px 16px",
                      borderRadius: 10,
                      border: isChecked ? "2px solid #4f46e5" : "1px solid #e5e7eb",
                      background: isChecked ? "#FAFBFF" : "#fff",
                      transition: "all 0.15s",
                    }}
                  >
                    {/* Item header row */}
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleItem(li.id)}
                        style={{ width: 18, height: 18, accentColor: "#4f46e5", cursor: "pointer", flexShrink: 0 }}
                      />
                      {li.imageUrl && (
                        <img
                          src={li.imageUrl}
                          alt=""
                          style={{ width: 44, height: 44, borderRadius: 6, objectFit: "cover", border: "1px solid #e5e7eb", flexShrink: 0 }}
                        />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {li.title}
                        </div>
                        <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2, display: "flex", gap: 10 }}>
                          {li.variantTitle && <span>{li.variantTitle}</span>}
                          {li.sku && <span>SKU: {li.sku}</span>}
                          <span>Qty ordered: {li.quantity}</span>
                        </div>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                        {orderData.currencyCode} {li.price}
                      </div>
                    </div>

                    {/* Expanded fields when checked */}
                    {isChecked && sel && (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #eef2ff" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 10 }}>
                          <div>
                            <label style={S.label}>Return Qty</label>
                            <input
                              type="number"
                              min={1}
                              max={li.quantity}
                              value={sel.qty}
                              onChange={(e) =>
                                updateItem(li.id, "qty", Math.max(1, Math.min(li.quantity, parseInt(e.target.value) || 1)))
                              }
                              style={S.input}
                            />
                          </div>
                          <div>
                            <label style={S.label}>Reason</label>
                            <select
                              value={sel.reasonCode}
                              onChange={(e) => updateItem(li.id, "reasonCode", e.target.value)}
                              style={{
                                ...S.select,
                                borderColor: sel.reasonCode ? "#d1d5db" : "#fca5a5",
                              }}
                            >
                              {REASON_CODES.map((r) => (
                                <option key={r.value} value={r.value}>{r.label}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label style={S.label}>Condition</label>
                            <select
                              value={sel.condition}
                              onChange={(e) => updateItem(li.id, "condition", e.target.value)}
                              style={{
                                ...S.select,
                                borderColor: sel.condition ? "#d1d5db" : "#fca5a5",
                              }}
                            >
                              {CONDITIONS.map((c) => (
                                <option key={c.value} value={c.value}>{c.label}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div>
                          <label style={S.label}>Notes (optional)</label>
                          <input
                            type="text"
                            value={sel.notes}
                            onChange={(e) => updateItem(li.id, "notes", e.target.value)}
                            placeholder="Additional details about this item..."
                            style={S.input}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Footer buttons */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 20 }}>
              <button
                type="button"
                onClick={() => { setStep(1); setValidationError(null); }}
                style={S.btnSecondary}
              >
                Back
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, color: "#6b7280" }}>
                  {Object.keys(selectedItems).length} item{Object.keys(selectedItems).length !== 1 ? "s" : ""} selected
                </span>
                <button type="button" onClick={handleStep2Next} style={S.btnPrimary}>
                  Next
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════
          STEP 3 — Customer & CRM Details
         ════════════════════════════════════════════════════════════════ */}
      {step === 3 && orderData && (
        <div>
          {validationError && <div style={S.alertError}>{validationError}</div>}

          {/* Customer Info */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Customer Information</div>
            <div style={S.sectionSubtitle}>
              Pre-filled from the order. Edit if needed.
            </div>

            <div style={S.fieldRow}>
              <div>
                <label style={S.label}>Full Name</label>
                <input
                  type="text"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  style={S.input}
                />
              </div>
              <div>
                <label style={S.label}>
                  Email <span style={{ color: "#DC2626" }}>*</span>
                </label>
                <input
                  type="email"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  style={S.input}
                  required
                />
              </div>
            </div>

            <div style={S.fieldRow}>
              <div>
                <label style={S.label}>Phone</label>
                <input
                  type="tel"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  style={S.input}
                />
              </div>
              <div>
                <label style={S.label}>Country</label>
                <input
                  type="text"
                  value={customerCountry}
                  onChange={(e) => setCustomerCountry(e.target.value)}
                  style={S.input}
                />
              </div>
            </div>

            <div style={S.fieldRow}>
              <div>
                <label style={S.label}>Address Line 1</label>
                <input
                  type="text"
                  value={customerAddress1}
                  onChange={(e) => setCustomerAddress1(e.target.value)}
                  style={S.input}
                />
              </div>
              <div>
                <label style={S.label}>Address Line 2</label>
                <input
                  type="text"
                  value={customerAddress2}
                  onChange={(e) => setCustomerAddress2(e.target.value)}
                  style={S.input}
                />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 14 }}>
              <div>
                <label style={S.label}>City</label>
                <input
                  type="text"
                  value={customerCity}
                  onChange={(e) => setCustomerCity(e.target.value)}
                  style={S.input}
                />
              </div>
              <div>
                <label style={S.label}>State / Province</label>
                <input
                  type="text"
                  value={customerProvince}
                  onChange={(e) => setCustomerProvince(e.target.value)}
                  style={S.input}
                />
              </div>
              <div>
                <label style={S.label}>ZIP / Postal Code</label>
                <input
                  type="text"
                  value={customerZip}
                  onChange={(e) => setCustomerZip(e.target.value)}
                  style={S.input}
                />
              </div>
            </div>

            <div style={S.fieldGroup}>
              <label style={S.label}>Landmark</label>
              <input
                type="text"
                value={customerLandmark}
                onChange={(e) => setCustomerLandmark(e.target.value)}
                placeholder="Near landmark (optional)"
                style={S.input}
              />
            </div>
          </div>

          {/* CRM Details */}
          <div style={S.section}>
            <div style={S.sectionTitle}>CRM & Resolution Details</div>
            <div style={S.sectionSubtitle}>
              Link this return to your CRM ticket and set the resolution.
            </div>

            <div style={S.fieldRow}>
              <div>
                <label style={S.label}>CRM Ticket ID</label>
                <input
                  type="text"
                  value={crmTicketId}
                  onChange={(e) => setCrmTicketId(e.target.value)}
                  placeholder="e.g. TICK-12345"
                  style={S.input}
                />
              </div>
              <div>
                <label style={S.label}>Agent Name</label>
                <input
                  type="text"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="Agent name"
                  style={S.input}
                />
              </div>
            </div>

            <div style={S.fieldGroup}>
              <label style={S.label}>CRM Notes</label>
              <textarea
                value={crmNotes}
                onChange={(e) => setCrmNotes(e.target.value)}
                placeholder="Internal notes about this return (reason for override, special handling, etc.)"
                style={S.textarea}
              />
            </div>

            {/* Resolution type radio buttons */}
            <div style={S.fieldGroup}>
              <label style={S.label}>
                Resolution Type <span style={{ color: "#DC2626" }}>*</span>
              </label>
              <div style={S.radioGroup}>
                {RESOLUTION_TYPES.map((r) => (
                  <label
                    key={r.value}
                    style={resolutionType === r.value ? S.radioLabelActive : S.radioLabel}
                  >
                    <input
                      type="radio"
                      name="resolutionType"
                      value={r.value}
                      checked={resolutionType === r.value}
                      onChange={() => setResolutionType(r.value as typeof resolutionType)}
                      style={{ display: "none" }}
                    />
                    {r.label}
                  </label>
                ))}
              </div>
            </div>

            {resolutionType === "exchange" && (
              <div style={S.fieldGroup}>
                <label style={S.label}>Exchange Preference</label>
                <textarea
                  value={exchangePreference}
                  onChange={(e) => setExchangePreference(e.target.value)}
                  placeholder="Describe the replacement item, size, color, variant, etc."
                  style={S.textarea}
                />
              </div>
            )}

            {/* Override eligibility gate */}
            <div style={{
              marginTop: 16,
              padding: "14px 16px",
              borderRadius: 8,
              background: "#FFFBEB",
              border: "1px solid #FDE68A",
            }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={overrideEligibility}
                  onChange={(e) => setOverrideEligibility(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: "#D97706", marginTop: 1, flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#92400E" }}>
                    Override eligibility gates
                  </div>
                  <div style={{ fontSize: 12, color: "#A16207", marginTop: 2 }}>
                    Bypass return window, product tag restrictions, and other automated eligibility checks.
                    Use only when authorized -- this action is logged.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Footer buttons */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button
              type="button"
              onClick={() => { setValidationError(null); setStep(2); }}
              style={S.btnSecondary}
            >
              Back
            </button>
            <button type="button" onClick={handleStep3Next} style={S.btnPrimary}>
              Review
            </button>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════
          STEP 4 — Review & Submit
         ════════════════════════════════════════════════════════════════ */}
      {step === 4 && orderData && (
        <div>
          {submitError && <div style={S.alertError}>{submitError}</div>}

          {/* Items Summary */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Return Items</div>
            <div style={S.sectionSubtitle}>
              {selectedItemsList.length} item{selectedItemsList.length !== 1 ? "s" : ""} selected for return from order {orderData.name}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {selectedItemsList.map((si) => {
                const li = orderData.lineItems.find((l) => l.id === si.lineItemId);
                if (!li) return null;
                return (
                  <div key={si.lineItemId} style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 14px",
                    background: "#f9fafb",
                    borderRadius: 8,
                    border: "1px solid #e5e7eb",
                  }}>
                    {li.imageUrl && (
                      <img
                        src={li.imageUrl}
                        alt=""
                        style={{ width: 40, height: 40, borderRadius: 6, objectFit: "cover", border: "1px solid #e5e7eb", flexShrink: 0 }}
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {li.title}
                      </div>
                      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2, display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {li.variantTitle && <span>{li.variantTitle}</span>}
                        <span>Qty: {si.qty}</span>
                        <span>{getReasonLabel(si.reasonCode)}</span>
                        <span>{getConditionLabel(si.condition)}</span>
                      </div>
                      {si.notes && (
                        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2, fontStyle: "italic" }}>
                          Note: {si.notes}
                        </div>
                      )}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                      {orderData.currencyCode} {(parseFloat(li.price) * si.qty).toFixed(2)}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Total */}
            <div style={{
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
              gap: 8,
              marginTop: 14,
              paddingTop: 14,
              borderTop: "1px solid #e5e7eb",
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#6b7280" }}>Estimated Refund:</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: "#111827", fontVariantNumeric: "tabular-nums" }}>
                {orderData.currencyCode} {estimatedTotal.toFixed(2)}
              </span>
            </div>
          </div>

          {/* Customer Info Summary */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Customer Information</div>
            <div style={{ marginTop: 12 }}>
              <div style={S.summaryRow}>
                <span style={S.summaryLabel}>Name</span>
                <span style={S.summaryValue}>{customerName || "--"}</span>
              </div>
              <div style={S.summaryRow}>
                <span style={S.summaryLabel}>Email</span>
                <span style={S.summaryValue}>{customerEmail || "--"}</span>
              </div>
              <div style={S.summaryRow}>
                <span style={S.summaryLabel}>Phone</span>
                <span style={S.summaryValue}>{customerPhone || "--"}</span>
              </div>
              <div style={S.summaryRow}>
                <span style={S.summaryLabel}>Address</span>
                <span style={S.summaryValue}>
                  {[customerAddress1, customerAddress2, customerCity, customerProvince, customerZip, customerCountry]
                    .filter(Boolean)
                    .join(", ") || "--"}
                </span>
              </div>
              {customerLandmark && (
                <div style={S.summaryRow}>
                  <span style={S.summaryLabel}>Landmark</span>
                  <span style={S.summaryValue}>{customerLandmark}</span>
                </div>
              )}
            </div>
          </div>

          {/* CRM & Resolution Summary */}
          <div style={S.section}>
            <div style={S.sectionTitle}>CRM & Resolution</div>
            <div style={{ marginTop: 12 }}>
              <div style={S.summaryRow}>
                <span style={S.summaryLabel}>Resolution Type</span>
                <span style={{
                  ...S.summaryValue,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}>
                  <span style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: resolutionType === "refund" ? "#059669"
                      : resolutionType === "exchange" ? "#4f46e5"
                      : resolutionType === "store_credit" ? "#D97706"
                      : "#6366F1",
                  }} />
                  {getResolutionLabel(resolutionType)}
                </span>
              </div>
              {resolutionType === "exchange" && exchangePreference && (
                <div style={S.summaryRow}>
                  <span style={S.summaryLabel}>Exchange Preference</span>
                  <span style={S.summaryValue}>{exchangePreference}</span>
                </div>
              )}
              <div style={S.summaryRow}>
                <span style={S.summaryLabel}>Agent</span>
                <span style={S.summaryValue}>{agentName || "Admin"}</span>
              </div>
              {crmTicketId && (
                <div style={S.summaryRow}>
                  <span style={S.summaryLabel}>CRM Ticket</span>
                  <span style={{ ...S.summaryValue, fontFamily: "monospace" }}>{crmTicketId}</span>
                </div>
              )}
              {crmNotes && (
                <div style={S.summaryRow}>
                  <span style={S.summaryLabel}>Notes</span>
                  <span style={{ ...S.summaryValue, maxWidth: 400, wordBreak: "break-word" }}>{crmNotes}</span>
                </div>
              )}
              {overrideEligibility && (
                <div style={{
                  ...S.alertWarning,
                  marginTop: 12,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#92400E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  Eligibility gates will be overridden for this return.
                </div>
              )}
            </div>
          </div>

          {/* Footer buttons */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button
              type="button"
              onClick={() => { setStep(3); }}
              style={S.btnSecondary}
            >
              Back
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting}
              style={{
                ...S.btnSuccess,
                opacity: isSubmitting ? 0.6 : 1,
                cursor: isSubmitting ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "12px 32px",
                fontSize: 14,
              }}
            >
              {isSubmitting ? (
                <>
                  <Spinner />
                  Submitting...
                </>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Submit Return
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
