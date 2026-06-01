import {
  Checkbox,
  Field,
  Label,
  Radio,
  RadioGroup,
  Tab,
  TabGroup,
  TabList,
  TabPanel,
  TabPanels,
} from "@headlessui/react";
import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  BadgeCheck,
  Box,
  Check,
  Clipboard,
  Copy,
  FileImage,
  ImagePlus,
  Loader2,
  Mail,
  PackageCheck,
  PackageSearch,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Tag,
  Truck,
} from "lucide-react";
import { PortalApi } from "./api";
import type {
  CreateReturnResponse,
  ItemSelection,
  LookupResponse,
  LookupType,
  MediaPayload,
  OrderResponse,
  PortalBootstrap,
  PortalLineItem,
  PortalOrder,
  PortalReturn,
  ProductResponse,
  ReturnOffer,
} from "./types";
import {
  filesToMediaPayload,
  formatDate,
  formatMoney,
  getReasonsForItem,
  humanize,
  latestDeliveredAt,
  normalizeItems,
  statusTone,
  t,
  validateMedia,
} from "./utils";

type TabId = "track_order" | "track_return" | "create";

type Toast = {
  tone: "success" | "error" | "info";
  message: string;
};

type OtpState = {
  sessionId: string;
  lookupType: LookupType;
  lookupValue: string;
};

type ExchangeChoice = {
  lineItemId: string;
  productId: string;
  variantId: string;
  variantTitle: string;
};

export function ReturnPortalApp({ bootstrap }: { bootstrap: PortalBootstrap }) {
  const api = useMemo(() => new PortalApi(bootstrap.appUrl), [bootstrap.appUrl]);
  const tabs = useMemo(() => availableTabs(bootstrap), [bootstrap]);
  const [activeTab, setActiveTab] = useState<TabId>(initialTab(bootstrap, tabs));
  const [toast, setToast] = useState<Toast | null>(null);
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeTab),
  );

  useEffect(() => {
    document.documentElement.lang = bootstrap.locale;
  }, [bootstrap.locale]);

  function notify(toastData: Toast) {
    setToast(toastData);
    window.setTimeout(() => setToast(null), 3200);
  }

  return (
    <div className="rpm-shell">
      <div className="rpm-floating-layer" aria-hidden="true">
        <span className="rpm-float-mark rpm-float-one">
          <Truck size={18} />
        </span>
        <span className="rpm-float-mark rpm-float-two">
          <Box size={18} />
        </span>
        <span className="rpm-float-mark rpm-float-three">
          <BadgeCheck size={18} />
        </span>
        <span className="rpm-float-mark rpm-float-four">
          <Clipboard size={18} />
        </span>
        <span className="rpm-float-mark rpm-float-five">
          <PackageSearch size={18} />
        </span>
        <span className="rpm-float-mark rpm-float-six">
          <FileImage size={18} />
        </span>
        <span className="rpm-float-mark rpm-float-seven">
          <ShieldCheck size={18} />
        </span>
        <span className="rpm-float-mark rpm-float-eight">
          <RotateCcw size={18} />
        </span>
        <span className="rpm-float-mark rpm-float-nine">
          <Tag size={18} />
        </span>
        <span className="rpm-float-mark rpm-float-ten">
          <Mail size={18} />
        </span>
        <span className="rpm-float-mark rpm-float-eleven">
          <PackageCheck size={18} />
        </span>
        <span className="rpm-float-mark rpm-float-twelve">
          <ImagePlus size={18} />
        </span>
        <span className="rpm-float-mark rpm-float-thirteen">
          <Copy size={18} />
        </span>
        <span className="rpm-float-mark rpm-float-fourteen">
          <Check size={18} />
        </span>
      </div>
      <Hero bootstrap={bootstrap} />

      <main className="rpm-workbench" aria-label="Return portal">
        <TabGroup
          selectedIndex={activeIndex}
          onChange={(index) => {
            const next = tabs[index]?.id;
            if (next) setActiveTab(next);
          }}
        >
          <TabList className="rpm-tabs" aria-label="Portal navigation">
            {tabs.map((tab) => (
              <Tab key={tab.id} className={({ selected }) => `rpm-tab${selected ? " is-active" : ""}`}>
                {tab.icon}
                {tab.label}
              </Tab>
            ))}
          </TabList>
          <TabPanels className="rpm-workbench-body">
            {tabs.map((tab) => (
              <TabPanel key={tab.id}>
                {tab.id === "track_order" && (
                  <LookupPanel
                    api={api}
                    bootstrap={bootstrap}
                    mode="order"
                    notify={notify}
                    switchToReturn={() => setActiveTab("track_return")}
                  />
                )}
                {tab.id === "track_return" && (
                  <LookupPanel
                    api={api}
                    bootstrap={bootstrap}
                    mode="return"
                    notify={notify}
                    switchToReturn={() => setActiveTab("track_return")}
                  />
                )}
                {tab.id === "create" && (
                  <CreateReturnPanel
                    api={api}
                    bootstrap={bootstrap}
                    notify={notify}
                    switchToTrackReturn={() => setActiveTab("track_return")}
                  />
                )}
              </TabPanel>
            ))}
          </TabPanels>
        </TabGroup>
      </main>

      {toast && (
        <div className="rpm-toast" role="status">
          {toast.tone === "success" ? <Check size={18} /> : <AlertCircle size={18} />}
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}

function Hero({ bootstrap }: { bootstrap: PortalBootstrap }) {
  const shopLabel = bootstrap.shop || "Customer portal";

  return (
    <section className="rpm-hero">
      <div className="rpm-hero-main">
        <div className="rpm-hero-copy-block">
          <div className="rpm-brand-row">
            <div className="rpm-brand-mark">
              {bootstrap.brandLogoUrl ? (
                <img src={bootstrap.brandLogoUrl} alt="" />
              ) : (
                <PackageCheck size={22} />
              )}
            </div>
            <div>
              <div className="rpm-brand-name">ReturnPro Max</div>
              <div className="rpm-brand-shop">{shopLabel}</div>
            </div>
          </div>
          <div className="rpm-eyebrow">
            <ShieldCheck size={15} />
            Secure self-service portal
          </div>
          <h1>{t(bootstrap, "portal.heading")}</h1>
          <p className="rpm-hero-copy">{t(bootstrap, "portal.subheading")}</p>
          <div className="rpm-policy">
            <ShieldCheck size={18} />
            <div>
              <strong>{t(bootstrap, "portal.policyBanner", { days: bootstrap.returnWindowDays })}</strong>
              {bootstrap.returnPolicy && <div>{bootstrap.returnPolicy}</div>}
            </div>
          </div>
        </div>
        <div className="rpm-hero-visual" aria-hidden="true">
          <div className="rpm-visual-card rpm-visual-card-main">
            <div className="rpm-visual-icon">
              <Truck size={20} />
            </div>
            <div>
              <span>Order status</span>
              <strong>Track shipments</strong>
            </div>
            <em>Live</em>
          </div>
          <div className="rpm-visual-lines">
            <span />
            <span />
            <span />
          </div>
          <div className="rpm-visual-card">
            <div className="rpm-visual-icon">
              <RotateCcw size={20} />
            </div>
            <div>
              <span>Return flow</span>
              <strong>Items, reason, review</strong>
            </div>
            <em>Ready</em>
          </div>
        </div>
      </div>
    </section>
  );
}

function LookupPanel({
  api,
  bootstrap,
  mode,
  notify,
  switchToReturn,
}: {
  api: PortalApi;
  bootstrap: PortalBootstrap;
  mode: "order" | "return";
  notify: (toast: Toast) => void;
  switchToReturn: () => void;
}) {
  const defaultType: LookupType = mode === "order" ? "order_no" : "return_id";
  const [lookupType, setLookupType] = useState<LookupType>(defaultType);
  const [lookupValue, setLookupValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [slowLoading, setSlowLoading] = useState(false);
  const [error, setError] = useState("");
  const [otp, setOtp] = useState<OtpState | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [result, setResult] = useState<LookupResponse | null>(null);

  useEffect(() => {
    setLookupType(defaultType);
    setLookupValue("");
    setResult(null);
    setError("");
    setOtp(null);
  }, [defaultType]);

  const options = mode === "order" ? orderLookupOptions(bootstrap) : returnLookupOptions(bootstrap);

  useEffect(() => {
    if (!loading) {
      setSlowLoading(false);
      return;
    }
    const timeout = window.setTimeout(() => setSlowLoading(true), 7000);
    return () => window.clearTimeout(timeout);
  }, [loading]);

  async function runLookup(portalToken?: string, sessionId?: string) {
    const value = lookupValue.trim();
    if (!value) {
      setError(t(bootstrap, "portal.error.pleaseEnter", { field: labelForLookup(bootstrap, lookupType) }));
      return;
    }
    setLoading(true);
    setError("");
    try {
      const data = await api.lookup({
        shop: bootstrap.shop,
        lookupType,
        lookupValue: value,
        portalToken,
        sessionId,
      });
      if (data.labels) bootstrap.labels = { ...bootstrap.labels, ...data.labels };
      if (data.requiresOtp && data.sessionId) {
        setOtp({ sessionId: data.sessionId, lookupType, lookupValue: value });
        notify({ tone: "info", message: "Verification code sent." });
        return;
      }
      setResult(data);
      enrichResults(data, api, bootstrap, setResult).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t(bootstrap, "portal.error.lookupFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function verifyOtp() {
    if (!otp) return;
    if (otpCode.trim().length < 4) {
      setError("Enter the verification code.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const verified = await api.verifyOtp(otp.sessionId, otpCode.trim());
      if (!verified.portalToken) throw new Error("Verification failed.");
      window.__RPM_AUTH_TOKEN__ = verified.portalToken;
      const data = await api.lookup({
        shop: bootstrap.shop,
        lookupType: otp.lookupType,
        lookupValue: otp.lookupValue,
        portalToken: verified.portalToken,
        sessionId: otp.sessionId,
      });
      setOtp(null);
      setOtpCode("");
      setResult(data);
      enrichResults(data, api, bootstrap, setResult).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setLoading(false);
    }
  }

  async function resendOtp() {
    if (!otp) return;
    try {
      await api.resendOtp(otp.sessionId);
      notify({ tone: "success", message: "Code sent again." });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to resend code.");
    }
  }

  if (otp) {
    return (
      <section>
        <SectionHead
          icon={<Mail size={20} />}
          title="Verify your email"
          copy="Enter the verification code to see private order and return details."
        />
        <div className="rpm-form-grid">
          <label className="rpm-field">
            <span className="rpm-label">Verification code</span>
            <input
              className="rpm-input"
              value={otpCode}
              onChange={(event) => setOtpCode(event.target.value.replace(/[^\d]/g, "").slice(0, 6))}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </label>
          <button className="rpm-button" type="button" disabled={loading} onClick={verifyOtp}>
            {loading ? <Loader2 className="rpm-spin" size={16} /> : <BadgeCheck size={16} />}
            Verify
          </button>
          <button className="rpm-button secondary" type="button" onClick={resendOtp}>
            <RefreshCw size={16} />
            Resend
          </button>
        </div>
        {error && <ErrorBox message={error} />}
        <div className="rpm-footer-actions">
          <button className="rpm-button ghost" type="button" onClick={() => setOtp(null)}>
            <ArrowLeft size={16} />
            Change search
          </button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <SectionHead
        icon={mode === "order" ? <PackageSearch size={20} /> : <RotateCcw size={20} />}
        title={mode === "order" ? t(bootstrap, "portal.tab.trackOrder") : t(bootstrap, "portal.tab.trackReturn")}
        copy={
          mode === "order"
            ? "Search by order number, email, phone, or forward tracking number."
            : "Search by return ID, return number, email, phone, or return tracking number."
        }
      />

      <div className="rpm-form-grid">
        <label className="rpm-field">
          <span className="rpm-label">Search by</span>
          <select
            className="rpm-select"
            value={lookupType}
            onChange={(event) => setLookupType(event.target.value as LookupType)}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="rpm-field">
          <span className="rpm-label">{labelForLookup(bootstrap, lookupType)}</span>
          <input
            className="rpm-input"
            value={lookupValue}
            onChange={(event) => setLookupValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runLookup();
            }}
            placeholder={placeholderForLookup(bootstrap, lookupType)}
          />
        </label>
        <button className="rpm-button" type="button" disabled={loading} onClick={() => void runLookup()}>
          {loading ? <Loader2 className="rpm-spin" size={16} /> : <Search size={16} />}
          {loading ? t(bootstrap, "portal.lookup.searching") : t(bootstrap, "portal.lookup.submit")}
        </button>
      </div>

      {error && <ErrorBox message={error} />}
      {loading && <Skeleton message={slowLoading ? "Still checking Shopify and return records. Keep this page open." : undefined} />}
      {result && !loading && (
        <LookupResults
          api={api}
          bootstrap={bootstrap}
          data={result}
          preferred={mode}
          notify={notify}
          switchToReturn={switchToReturn}
          onChange={setResult}
        />
      )}
    </section>
  );
}

function LookupResults({
  api,
  bootstrap,
  data,
  preferred,
  notify,
  switchToReturn,
  onChange,
}: {
  api: PortalApi;
  bootstrap: PortalBootstrap;
  data: LookupResponse;
  preferred: "order" | "return";
  notify: (toast: Toast) => void;
  switchToReturn: () => void;
  onChange: (next: LookupResponse) => void;
}) {
  const orders = data.orders || [];
  const returns = data.returns || [];
  const showOrders = preferred === "order" ? orders.length > 0 : orders.length > 0 && returns.length === 0;
  const showReturns = preferred === "return" ? returns.length > 0 : returns.length > 0;

  if (!showOrders && !showReturns) {
    return (
      <div className="rpm-empty">
        <div>
          <Search size={30} />
          <h3>{t(bootstrap, "portal.results.noResults")}</h3>
          <p>{t(bootstrap, "portal.results.noResultsDesc")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rpm-results">
      {showOrders && (
        <>
          <h3 className="rpm-section-title">{t(bootstrap, "portal.results.orders")}</h3>
          {orders.map((order, index) => (
            <OrderCard key={order.id || order.name || index} bootstrap={bootstrap} order={order} returns={returns} />
          ))}
        </>
      )}
      {showReturns && (
        <>
          <h3 className="rpm-section-title">{t(bootstrap, "portal.results.returns")}</h3>
          {returns.map((returnCase) => (
            <ReturnCard
              key={returnCase.id}
              api={api}
              bootstrap={bootstrap}
              returnCase={returnCase}
              notify={notify}
              onCancelled={() => {
                onChange({
                  ...data,
                  returns: returns.map((r) =>
                    r.id === returnCase.id ? { ...r, status: "cancelled" } : r,
                  ),
                });
              }}
            />
          ))}
        </>
      )}
      {returns.length > 0 && preferred === "order" && (
        <button type="button" className="rpm-button secondary" onClick={switchToReturn}>
          <RotateCcw size={16} />
          View return details
        </button>
      )}
    </div>
  );
}

function OrderCard({
  bootstrap,
  order,
  returns,
}: {
  bootstrap: PortalBootstrap;
  order: PortalOrder;
  returns: PortalReturn[];
}) {
  const status = order.displayFulfillmentStatus || order.fulfillmentStatus || order.financialStatus || "processing";
  const currency = order.currencyCode || bootstrap.currency;
  const relatedReturns = returns.filter((r) => r.shopifyOrderName && order.name && r.shopifyOrderName === order.name);

  return (
    <article className="rpm-result-card">
      <div className="rpm-card-head">
        <div>
          <h4 className="rpm-card-title">{order.name || "Order"}</h4>
          <p className="rpm-card-meta">Placed {formatDate(order.processedAt || order.createdAt, bootstrap)}</p>
        </div>
        <span className={`rpm-badge ${statusTone(status)}`}>{humanize(status)}</span>
      </div>
      <div className="rpm-kv-grid">
        <InfoBlock label="Total" value={formatMoney(order.totalPrice, currency, bootstrap.locale) || "Not available"} />
        <InfoBlock label="Payment" value={humanize(order.financialStatus || "not available")} />
        <InfoBlock label="Tracking" value={trackingLabel(order)} />
      </div>
      <ItemList items={order.lineItems || []} currency={currency} bootstrap={bootstrap} />
      {relatedReturns.length > 0 && (
        <div className="rpm-note">
          <RotateCcw size={16} />
          {relatedReturns.length} linked return request{relatedReturns.length === 1 ? "" : "s"} found for this order.
        </div>
      )}
    </article>
  );
}

function latestReturnJourneyStatus(returnCase: PortalReturn) {
  const journey = returnCase.returnJourney || [];
  for (let index = journey.length - 1; index >= 0; index -= 1) {
    const status = String(journey[index]?.status ?? "").trim();
    if (status) return status;
  }
  return "";
}

function returnDisplayStatus(returnCase: PortalReturn) {
  return (
    latestReturnJourneyStatus(returnCase) ||
    returnCase.fyndCurrentStatus ||
    returnCase.status ||
    "pending"
  );
}

function ReturnCard({
  api,
  bootstrap,
  returnCase,
  notify,
  onCancelled,
}: {
  api: PortalApi;
  bootstrap: PortalBootstrap;
  returnCase: PortalReturn;
  notify: (toast: Toast) => void;
  onCancelled: () => void;
}) {
  const status = returnDisplayStatus(returnCase);
  const isTerminal = /cancelled|completed|rejected|declined|refunded/i.test(String(status));
  const canCancel =
    bootstrap.config.allowReturnCancellation &&
    !isTerminal &&
    !returnCase.cancellationRequestedAt &&
    Boolean(window.__RPM_AUTH_TOKEN__);
  const [busy, setBusy] = useState(false);

  async function cancel() {
    setBusy(true);
    try {
      const result = await api.cancelReturn({
        shop: bootstrap.shop,
        returnCaseId: returnCase.id,
        portalToken: window.__RPM_AUTH_TOKEN__,
        portalCsrfToken: window.__RPM_PORTAL_CSRF__,
        isApproved: String(returnCase.status || "").toLowerCase() === "approved",
      });
      if (!result.success) throw new Error(result.error || "Unable to cancel return.");
      notify({ tone: "success", message: "Return cancellation submitted." });
      onCancelled();
    } catch (err) {
      notify({ tone: "error", message: err instanceof Error ? err.message : "Unable to cancel return." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rpm-result-card">
      <div className="rpm-card-head">
        <div>
          <h4 className="rpm-card-title">{returnCase.returnRequestNo || returnCase.returnRequestId || returnCase.id}</h4>
          <p className="rpm-card-meta">
            {returnCase.shopifyOrderName || "Order"} / Created {formatDate(returnCase.createdAt, bootstrap)}
          </p>
        </div>
        <span className={`rpm-badge ${statusTone(status)}`}>{humanize(status)}</span>
      </div>
      <div className="rpm-kv-grid">
        <InfoBlock label="Resolution" value={humanize(returnCase.resolutionType || "refund")} />
        <InfoBlock label="Return AWB" value={returnCase.returnAwb || "Pending"} />
        <InfoBlock label="Refund" value={humanize(returnCase.refundStatus || "Not started")} />
      </div>
      {returnCase.returnLabel?.labelUrl && (
        <a className="rpm-button secondary" href={returnCase.returnLabel.labelUrl} target="_blank" rel="noreferrer">
          <Clipboard size={16} />
          Open return label
        </a>
      )}
      <ReturnTimeline returnCase={returnCase} bootstrap={bootstrap} />
      {returnCase.items && returnCase.items.length > 0 && (
        <div className="rpm-items">
          {returnCase.items.map((item, index) => (
            <div className="rpm-item-row" key={item.id || index}>
              <span className="rpm-icon-box">
                <Box size={16} />
              </span>
              <div>
                <p className="rpm-item-title">{item.title || t(bootstrap, "portal.common.item")}</p>
                <p className="rpm-item-meta">
                  Qty {item.qty || item.quantity || 1}
                  {item.reasonCode ? ` / ${humanize(item.reasonCode)}` : ""}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
      {canCancel && (
        <div className="rpm-footer-actions">
          <button type="button" className="rpm-button danger" disabled={busy} onClick={() => void cancel()}>
            {busy ? <Loader2 className="rpm-spin" size={16} /> : <AlertCircle size={16} />}
            Cancel return
          </button>
        </div>
      )}
      {returnCase.cancellationRequestedAt && (
        <div className="rpm-note">
          <AlertCircle size={16} />
          Cancellation request is waiting for store review.
        </div>
      )}
    </article>
  );
}

function ReturnTimeline({ returnCase, bootstrap }: { returnCase: PortalReturn; bootstrap: PortalBootstrap }) {
  const events = [
    ...(returnCase.returnJourney || []).map((step) => ({
      label: humanize(step.status),
      date: step.timestamp || step.time,
    })),
    ...(returnCase.events || []).map((event) => ({
      label: humanize(event.message || event.eventType),
      date: event.happenedAt,
    })),
  ].slice(0, 5);

  if (events.length === 0) return null;

  return (
    <div className="rpm-items">
      {events.map((event, index) => (
        <div className="rpm-item-row" key={`${event.label}-${index}`}>
          <span className="rpm-icon-box">
            <Check size={16} />
          </span>
          <div>
            <p className="rpm-item-title">{event.label}</p>
            <p className="rpm-item-meta">{formatDate(event.date, bootstrap)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function CreateReturnPanel({
  api,
  bootstrap,
  notify,
  switchToTrackReturn,
}: {
  api: PortalApi;
  bootstrap: PortalBootstrap;
  notify: (toast: Toast) => void;
  switchToTrackReturn: () => void;
}) {
  const [step, setStep] = useState<"start" | "items" | "manual" | "existing" | "success">("start");
  const [orderNumber, setOrderNumber] = useState("");
  const [orderData, setOrderData] = useState<OrderResponse | null>(null);
  const [rows, setRows] = useState<ItemSelection[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [condition, setCondition] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [manualItems, setManualItems] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [mediaFiles, setMediaFiles] = useState<File[]>([]);
  const [mediaError, setMediaError] = useState("");
  const [resolutionType, setResolutionType] = useState<"refund" | "exchange">("refund");
  const [exchangePreference, setExchangePreference] = useState("");
  const [exchangeProducts, setExchangeProducts] = useState<Record<string, ProductResponse["products"]>>({});
  const [exchangeChoices, setExchangeChoices] = useState<Record<string, ExchangeChoice>>({});
  const [offerAccepted, setOfferAccepted] = useState<CreateReturnResponse | null>(null);
  const [success, setSuccess] = useState<CreateReturnResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [slowLoading, setSlowLoading] = useState(false);
  const [error, setError] = useState("");

  const selectedRows = rows.filter((row) => selected[row.rowKey] && !row.disabled);
  const firstReasonList = selectedRows[0]
    ? getReasonsForItem(bootstrap, selectedRows[0].productType)
    : bootstrap.returnReasons;
  const matchedOffer = useMemo(
    () => findOffer(orderData?.returnOffers?.offers || [], reason, selectedRows),
    [orderData?.returnOffers?.offers, reason, selectedRows],
  );
  const exchangeEnabled = Boolean(orderData?.portalExchangeEnabled || bootstrap.features.portalExchangeEnabled);
  const estimatedRefund = estimateRefund(orderData, selectedRows, qty, bootstrap);

  useEffect(() => {
    if (!reason && firstReasonList.length > 0) setReason(firstReasonList[0]);
  }, [firstReasonList, reason]);

  useEffect(() => {
    if (resolutionType !== "exchange" || selectedRows.length === 0) return;
    void loadExchangeProducts();
  }, [resolutionType, selectedRows.map((row) => row.rowKey).join("|")]);

  useEffect(() => {
    if (!loading) {
      setSlowLoading(false);
      return;
    }
    const timeout = window.setTimeout(() => setSlowLoading(true), 7000);
    return () => window.clearTimeout(timeout);
  }, [loading]);

  async function findOrder() {
    const value = orderNumber.trim().replace(/^#/, "");
    if (!value) {
      setError("Enter an order number.");
      return;
    }
    setLoading(true);
    setError("");
    setOfferAccepted(null);
    try {
      const data = await api.order(bootstrap.shop, value);
      if (!data.order) throw new Error(data.error || "Order not found.");
      const normalizedRows = normalizeItems(data);
      setOrderData(data);
      setRows(normalizedRows);
      setEmail(data.order.email || "");
      setSelected({});
      setQty(Object.fromEntries(normalizedRows.map((row) => [row.rowKey, Math.min(1, row.availableQty || 1)])));
      const hasAvailable = normalizedRows.some((row) => !row.disabled && row.availableQty > 0);
      setStep((data.activeReturns || []).length > 0 && !hasAvailable ? "existing" : "items");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Order lookup failed.");
    } finally {
      setLoading(false);
    }
  }

  async function submitManual() {
    if (!orderNumber.trim()) {
      setError("Enter the order number.");
      return;
    }
    if (!manualEmail.trim()) {
      setError("Enter your email address.");
      return;
    }
    if (!manualItems.trim()) {
      setError("Describe the items you want to return.");
      return;
    }
    if (bootstrap.config.allowMediaUploads !== false && mediaFiles.length === 0) {
      setError("Upload at least one photo before submitting the return.");
      return;
    }
    await submitPayload({
      manual: true,
      shop: bootstrap.shop,
      shopifyOrderName: orderNumber.trim().startsWith("#") ? orderNumber.trim() : `#${orderNumber.trim()}`,
      customerEmail: manualEmail.trim(),
      manualItemDescription: manualItems.trim(),
      customerNotes: notes.trim() || undefined,
      items: [{ lineItemId: "manual", qty: 1, reasonCode: reason || "Other" }],
      portalCsrfToken: window.__RPM_PORTAL_CSRF__,
    });
  }

  async function submitReturn(acceptOffer = false) {
    if (!orderData?.order) return;
    if (selectedRows.length === 0) {
      setError(t(bootstrap, "portal.error.selectOneItem"));
      return;
    }
    if (resolutionType === "exchange" && !exchangePreference.trim() && Object.keys(exchangeChoices).length === 0) {
      setError("Choose an exchange variant or describe what you want.");
      return;
    }
    if (bootstrap.config.allowMediaUploads !== false && mediaFiles.length === 0) {
      setError("Upload at least one photo before submitting the return.");
      return;
    }
    const order = orderData.order;
    const shipping = order.shippingAddress;
    await submitPayload({
      shop: bootstrap.shop,
      orderId: order.id,
      shopifyOrderName: order.name,
      customerEmail: (email || order.email || "").trim() || undefined,
      customerPhone: order.phone || shipping?.phone || undefined,
      customerName: shipping ? `${shipping.firstName || ""} ${shipping.lastName || ""}`.trim() || undefined : undefined,
      customerCity: shipping?.city || undefined,
      customerCountry: shipping?.country || shipping?.countryCode || undefined,
      customerAddress1: shipping?.address1 || undefined,
      customerAddress2: shipping?.address2 || undefined,
      customerProvince: shipping?.province || undefined,
      customerZip: shipping?.zip || undefined,
      customerNotes: notes.trim() || undefined,
      orderCreatedAt: order.createdAt,
      orderProcessedAt: order.processedAt || undefined,
      orderDeliveredAt: latestDeliveredAt(order),
      currency: order.currencyCode || bootstrap.currency,
      resolutionType,
      exchangePreference: buildExchangePreference(exchangePreference, exchangeChoices),
      exchangeVariants: Object.values(exchangeChoices),
      items: buildReturnItems(selectedRows, qty, reason, condition),
      lineItemsWithPrice: (order.lineItems || []).map((item) => lineItemWithPrice(item)),
      lineItemEstimates: orderData.lineItemEstimates || undefined,
      shipmentsSnapshot: orderData.shipments || undefined,
      acceptOffer,
      portalCsrfToken: window.__RPM_PORTAL_CSRF__,
    });
  }

  async function submitPayload(payload: Record<string, unknown>) {
    setLoading(true);
    setError("");
    try {
      const mediaPayload = mediaFiles.length > 0 ? await filesToMediaPayload(mediaFiles) : [];
      const data = await api.createReturn({
        ...payload,
        customerMedia: mediaPayload.length > 0 ? mediaPayload : undefined,
      });
      if (data.offerAccepted) {
        setOfferAccepted(data);
        notify({ tone: "success", message: "Offer accepted." });
        return;
      }
      if (!data.success) throw new Error(data.error || t(bootstrap, "portal.error.failedToSubmit"));
      setSuccess(data);
      setStep("success");
      notify({ tone: "success", message: data.message || "Return submitted." });
    } catch (err) {
      setError(err instanceof Error ? err.message : t(bootstrap, "portal.error.failedToSubmit"));
    } finally {
      setLoading(false);
    }
  }

  async function loadExchangeProducts() {
    const toLoad = selectedRows.filter((row) => row.productId && !exchangeProducts[row.rowKey]);
    if (toLoad.length === 0) return;
    const updates: Record<string, ProductResponse["products"]> = {};
    await Promise.all(
      toLoad.map(async (row) => {
        try {
          const data = await api.products(bootstrap.shop, row.productId || "");
          updates[row.rowKey] = data.products || [];
        } catch {
          updates[row.rowKey] = [];
        }
      }),
    );
    setExchangeProducts((current) => ({ ...current, ...updates }));
  }

  function updateFiles(files: FileList | null) {
    const next = Array.from(files || []);
    const errors = validateMedia(next);
    if (errors.length) {
      setMediaError(errors.join(" "));
      return;
    }
    setMediaError("");
    setMediaFiles(next);
  }

  if (step === "success" && success) {
    return (
      <section className="rpm-success-section">
        <SectionHead icon={<BadgeCheck size={20} />} title={t(bootstrap, "portal.create.successTitle")} copy={success.summary?.nextSteps || t(bootstrap, "portal.create.successNextSteps")} />
        <div className="rpm-result-card rpm-success-card">
          <div className="rpm-success-badge" aria-hidden="true">
            <BadgeCheck size={28} />
          </div>
          <div className="rpm-kv-grid">
            <InfoBlock label="Return request ID" value={success.returnRequestId || success.returnId || "Created"} />
            <InfoBlock label="Status" value={humanize(success.status || success.summary?.status || "pending")} />
            <InfoBlock label="Order" value={success.summary?.orderName || orderData?.order?.name || orderNumber} />
          </div>
          <div className="rpm-footer-actions">
            <button className="rpm-button secondary" type="button" onClick={() => copyText(success.returnRequestId || success.returnId || "", notify)}>
              <Copy size={16} />
              {t(bootstrap, "portal.common.copy")}
            </button>
            <button className="rpm-button" type="button" onClick={switchToTrackReturn}>
              <Search size={16} />
              Track this return
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (step === "existing") {
    return (
      <section>
        <SectionHead
          icon={<AlertCircle size={20} />}
          title="Return already submitted"
          copy="Every returnable item on this order already has a return in progress."
        />
        <div className="rpm-results">
          {(orderData?.activeReturns || orderData?.existingReturns || []).map((returnCase) => (
            <ReturnCard
              key={returnCase.id}
              api={api}
              bootstrap={bootstrap}
              returnCase={returnCase}
              notify={notify}
              onCancelled={() => undefined}
            />
          ))}
        </div>
        <div className="rpm-footer-actions">
          <button className="rpm-button secondary" type="button" onClick={() => setStep("start")}>
            <ArrowLeft size={16} />
            Search another order
          </button>
        </div>
      </section>
    );
  }

  if (step === "manual") {
    return (
      <section>
        <Stepper active={2} />
        <SectionHead icon={<Clipboard size={20} />} title="Manual return request" copy="Use this when the order lookup is unavailable." />
        <div className="rpm-stack">
          <Field className="rpm-field">
            <Label className="rpm-label">Order number</Label>
            <input className="rpm-input" value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} />
          </Field>
          <Field className="rpm-field">
            <Label className="rpm-label">Email for updates</Label>
            <input className="rpm-input" type="email" value={manualEmail} onChange={(event) => setManualEmail(event.target.value)} />
          </Field>
          <label className="rpm-field">
            <span className="rpm-label">Reason</span>
            <select className="rpm-select" value={reason} onChange={(event) => setReason(event.target.value)}>
              {bootstrap.returnReasons.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="rpm-field">
            <span className="rpm-label">Items to return</span>
            <textarea className="rpm-textarea" value={manualItems} onChange={(event) => setManualItems(event.target.value)} placeholder="Item name, size, quantity, and condition" />
          </label>
          <label className="rpm-field">
            <span className="rpm-label">Notes</span>
            <textarea className="rpm-textarea" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <MediaUpload bootstrap={bootstrap} files={mediaFiles} error={mediaError} required onFiles={updateFiles} />
        </div>
        {error && <ErrorBox message={error} />}
        <div className="rpm-footer-actions">
          <button className="rpm-button" type="button" disabled={loading} onClick={() => void submitManual()}>
            {loading ? <Loader2 className="rpm-spin" size={16} /> : <RotateCcw size={16} />}
            Submit request
          </button>
          <button className="rpm-button secondary" type="button" onClick={() => setStep("start")}>
            <ArrowLeft size={16} />
            {t(bootstrap, "portal.common.back")}
          </button>
        </div>
      </section>
    );
  }

  if (step === "items" && orderData?.order) {
    return (
      <section>
        <Stepper active={2} />
        <SectionHead
          icon={<PackageCheck size={20} />}
          title="Select items"
          copy={`${orderData.order.name || "Order"} is ready for return selection.`}
        />

        {(orderData.previousReturns || []).length > 0 && (
          <div className="rpm-note">
            <AlertCircle size={16} />
            This order already has previous returns. Unavailable items are disabled below.
          </div>
        )}

        <div className="rpm-two-col">
          <div className="rpm-stack">
            <div className="rpm-items">
              {rows.map((row) => (
                <SelectableItem
                  key={row.rowKey}
                  row={row}
                  checked={Boolean(selected[row.rowKey])}
                  quantity={qty[row.rowKey] || 1}
                  currency={orderData.order?.currencyCode || bootstrap.currency}
                  bootstrap={bootstrap}
                  onChecked={(checked) => setSelected((current) => ({ ...current, [row.rowKey]: checked }))}
                  onQty={(nextQty) => setQty((current) => ({ ...current, [row.rowKey]: nextQty }))}
                />
              ))}
            </div>

            <label className="rpm-field">
              <span className="rpm-label">Reason</span>
              <select className="rpm-select" value={reason} onChange={(event) => setReason(event.target.value)}>
                {firstReasonList.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>

            <label className="rpm-field">
              <span className="rpm-label">Item condition</span>
              <select className="rpm-select" value={condition} onChange={(event) => setCondition(event.target.value)}>
                <option value="">Select condition</option>
                <option value="unused">New - unused</option>
                <option value="used_good">Used - good condition</option>
                <option value="used_fair">Used - fair condition</option>
                <option value="used_damaged">Used - damaged</option>
                <option value="defective">Defective</option>
              </select>
            </label>

            <label className="rpm-field">
              <span className="rpm-label">Email for updates</span>
              <input className="rpm-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>

            <label className="rpm-field">
              <span className="rpm-label">Notes</span>
              <textarea className="rpm-textarea" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Add anything the store should know" />
            </label>

            {exchangeEnabled && (
              <ResolutionPicker
                resolutionType={resolutionType}
                setResolutionType={setResolutionType}
                selectedRows={selectedRows}
                products={exchangeProducts}
                choices={exchangeChoices}
                preference={exchangePreference}
                setPreference={setExchangePreference}
                setChoices={setExchangeChoices}
              />
            )}

            <MediaUpload bootstrap={bootstrap} files={mediaFiles} error={mediaError} required onFiles={updateFiles} />
          </div>

          <aside className="rpm-panel" style={{ padding: 16 }}>
            <h3 className="rpm-section-title">Summary</h3>
            <div className="rpm-kv-grid" style={{ gridTemplateColumns: "1fr" }}>
              <InfoBlock label="Selected items" value={String(selectedRows.length)} />
              <InfoBlock label="Estimated refund" value={estimatedRefund} />
              <InfoBlock label="Return deadline" value={formatDate(orderData.returnDeadline, bootstrap)} />
            </div>
            {orderData.returnFee && (
              <div className="rpm-note">
                <Tag size={16} />
                Return fee: {formatMoney(orderData.returnFee.amount, orderData.returnFee.currency, bootstrap.locale)}
              </div>
            )}
            {matchedOffer && !offerAccepted && (
              <div className="rpm-note">
                <Tag size={16} />
                <span>{matchedOffer.message}</span>
              </div>
            )}
            {offerAccepted && (
              <div className="rpm-success">
                <BadgeCheck size={16} />
                <span>
                  Offer accepted. Code: <strong>{offerAccepted.discountCode}</strong>
                </span>
              </div>
            )}
          </aside>
        </div>

        {error && <ErrorBox message={error} />}

        <div className="rpm-footer-actions">
          {matchedOffer && !offerAccepted && (
            <button className="rpm-button secondary" type="button" disabled={loading} onClick={() => void submitReturn(true)}>
              <Tag size={16} />
              Accept offer
            </button>
          )}
          {!offerAccepted && (
            <button className="rpm-button" type="button" disabled={loading} onClick={() => void submitReturn(false)}>
              {loading ? <Loader2 className="rpm-spin" size={16} /> : <RotateCcw size={16} />}
              {t(bootstrap, "portal.create.submit")}
            </button>
          )}
          <button className="rpm-button secondary" type="button" onClick={() => setStep("start")}>
            <ArrowLeft size={16} />
            {t(bootstrap, "portal.common.back")}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <Stepper active={1} />
      <SectionHead icon={<RotateCcw size={20} />} title={t(bootstrap, "portal.create.startTitle")} copy={t(bootstrap, "portal.create.startDesc")} />
      <div className="rpm-form-grid">
        <Field className="rpm-field">
          <Label className="rpm-label">Order number</Label>
          <input
            className="rpm-input"
            value={orderNumber}
            onChange={(event) => setOrderNumber(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void findOrder();
            }}
            placeholder="e.g. #1001"
          />
        </Field>
        <button className="rpm-button" type="button" disabled={loading} onClick={() => void findOrder()}>
          {loading ? <Loader2 className="rpm-spin" size={16} /> : <Search size={16} />}
          {t(bootstrap, "portal.create.findOrder")}
        </button>
        <button className="rpm-button secondary" type="button" onClick={() => setStep("manual")}>
          <Clipboard size={16} />
          {t(bootstrap, "portal.create.manualSubmit")}
        </button>
      </div>
      {error && <ErrorBox message={error} />}
      {loading && <Skeleton message={slowLoading ? "Still checking the order. Shopify can be slow here, but the request is still running." : undefined} />}
    </section>
  );
}

function ResolutionPicker({
  resolutionType,
  setResolutionType,
  selectedRows,
  products,
  choices,
  preference,
  setPreference,
  setChoices,
}: {
  resolutionType: "refund" | "exchange";
  setResolutionType: (next: "refund" | "exchange") => void;
  selectedRows: ItemSelection[];
  products: Record<string, ProductResponse["products"]>;
  choices: Record<string, ExchangeChoice>;
  preference: string;
  setPreference: (next: string) => void;
  setChoices: (next: Record<string, ExchangeChoice>) => void;
}) {
  const options = [
    { value: "refund" as const, label: "Refund", copy: "Send the item back and receive a refund." },
    { value: "exchange" as const, label: "Exchange", copy: "Pick another variant or leave exchange notes." },
  ];

  return (
    <div className="rpm-panel" style={{ padding: 14 }}>
      <RadioGroup value={resolutionType} onChange={setResolutionType} aria-label="Resolution">
        <Label className="rpm-label">Resolution</Label>
        <div className="rpm-choice-grid">
          {options.map((option) => (
            <Radio key={option.value} value={option.value} className="rpm-choice-card">
              {({ checked }) => (
                <>
                  <span className="rpm-choice-dot">{checked && <Check size={13} />}</span>
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.copy}</small>
                  </span>
                </>
              )}
            </Radio>
          ))}
        </div>
      </RadioGroup>
      {resolutionType === "exchange" && (
        <div className="rpm-stack" style={{ marginTop: 12 }}>
          {selectedRows.map((row) => {
            const product = (products[row.rowKey] || [])[0];
            const variants = product?.variants || [];
            return (
              <label className="rpm-field" key={row.rowKey}>
                <span className="rpm-label">{row.title}</span>
                {variants.length > 0 ? (
                  <select
                    className="rpm-select"
                    value={choices[row.rowKey]?.variantId || ""}
                    onChange={(event) => {
                      const variant = variants.find((v) => v.id === event.target.value);
                      setChoices({
                        ...choices,
                        [row.rowKey]: {
                          lineItemId: row.lineItemId,
                          productId: row.productId || "",
                          variantId: event.target.value,
                          variantTitle: variant?.title || "Selected variant",
                        },
                      });
                    }}
                  >
                    <option value="">Choose a variant</option>
                    {variants.map((variant) => (
                      <option key={variant.id} value={variant.id}>
                        {variant.title || "Variant"}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="rpm-card-meta">Variant picker unavailable for this item.</span>
                )}
              </label>
            );
          })}
          <label className="rpm-field">
            <span className="rpm-label">Exchange preference</span>
            <textarea
              className="rpm-textarea"
              value={preference}
              onChange={(event) => setPreference(event.target.value)}
              placeholder="Size, color, or variant you prefer"
            />
          </label>
        </div>
      )}
    </div>
  );
}

function SelectableItem({
  row,
  checked,
  quantity,
  currency,
  bootstrap,
  onChecked,
  onQty,
}: {
  row: ItemSelection;
  checked: boolean;
  quantity: number;
  currency: string;
  bootstrap: PortalBootstrap;
  onChecked: (checked: boolean) => void;
  onQty: (qty: number) => void;
}) {
  const max = Math.max(1, row.availableQty || 1);
  const disabledLabel = row.disabledReason || "Return already in progress for this item.";
  return (
    <div className={`rpm-item-row rpm-selectable-row${row.disabled ? " is-disabled" : ""}`}>
      <Checkbox
        checked={checked}
        disabled={row.disabled}
        onChange={onChecked}
        className="rpm-select-control"
        aria-label={`Select ${row.title}`}
      >
        <span className="rpm-select-box">{checked && <Check size={13} />}</span>
        <span>{checked ? "Selected" : "Select"}</span>
      </Checkbox>
      <ProductThumb src={row.imageUrl} title={row.title} />
      <div>
        <p className="rpm-item-title">{row.title}</p>
        <p className="rpm-item-meta">
          {row.variantTitle || row.sku || "Standard"} / Available {row.availableQty}
          {row.price ? ` / ${formatMoney(row.price, currency, bootstrap.locale)}` : ""}
        </p>
        {row.disabled && (
          <p className="rpm-item-status">
            <AlertCircle size={14} />
            {disabledLabel}
          </p>
        )}
      </div>
      <select
        className="rpm-select"
        style={{ width: 86 }}
        value={Math.min(quantity, max)}
        disabled={!checked || row.disabled}
        onChange={(event) => onQty(Number(event.target.value))}
      >
        {Array.from({ length: max }, (_, index) => index + 1).map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    </div>
  );
}

function MediaUpload({
  bootstrap,
  files,
  error,
  required,
  onFiles,
}: {
  bootstrap: PortalBootstrap;
  files: File[];
  error: string;
  required?: boolean;
  onFiles: (files: FileList | null) => void;
}) {
  if (bootstrap.config.allowMediaUploads === false) return null;
  return (
    <div>
      <label className="rpm-upload">
        <input
          type="file"
          multiple
          accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime"
          onChange={(event) => onFiles(event.target.files)}
        />
        <span>
          <ImagePlus size={24} />
          <strong>
            Upload return photos
            {required && <em>Required</em>}
          </strong>
          <br />
          Add at least one clear product photo. Images up to 5MB, video up to 50MB.
        </span>
      </label>
      {files.length > 0 && (
        <div className="rpm-card-meta" style={{ marginTop: 8 }}>
          {files.map((file) => file.name).join(", ")}
        </div>
      )}
      {error && <ErrorBox message={error} />}
    </div>
  );
}

function SectionHead({ icon, title, copy }: { icon: React.ReactNode; title: string; copy?: string }) {
  return (
    <div className="rpm-section-head">
      <div>
        <h2 className="rpm-section-title">{title}</h2>
        {copy && <p className="rpm-section-copy">{copy}</p>}
      </div>
      <span className="rpm-icon-box">{icon}</span>
    </div>
  );
}

function Stepper({ active }: { active: number }) {
  return (
    <div className="rpm-stepper" aria-label="Create return progress">
      {["Find order", "Select items", "Submit"].map((label, index) => (
        <div key={label} className={`rpm-step${active === index + 1 ? " is-active" : ""}`}>
          {index + 1}. {label}
        </div>
      ))}
    </div>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rpm-kv">
      <span>{label}</span>
      <strong>{value || "Not available"}</strong>
    </div>
  );
}

function ItemList({
  items,
  currency,
  bootstrap,
}: {
  items: PortalLineItem[];
  currency: string;
  bootstrap: PortalBootstrap;
}) {
  if (items.length === 0) return null;
  return (
    <div className="rpm-items">
      {items.slice(0, 5).map((item) => (
        <div className="rpm-item-row" key={item.id}>
          <ProductThumb src={item.imageUrl} title={item.title || "Item"} />
          <div>
            <p className="rpm-item-title">{item.title || "Item"}</p>
            <p className="rpm-item-meta">
              Qty {item.quantity || 1}
              {item.variantTitle ? ` / ${item.variantTitle}` : ""}
            </p>
          </div>
          <span className="rpm-card-meta">{formatMoney(item.price ?? item.discountedPrice, currency, bootstrap.locale)}</span>
        </div>
      ))}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rpm-error" role="alert">
      <AlertCircle size={16} />
      {message}
    </div>
  );
}

function ProductThumb({ src, title }: { src?: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return <img className="rpm-thumb" src={src} alt={title} onError={() => setFailed(true)} loading="lazy" />;
  }
  return (
    <span className="rpm-thumb rpm-thumb-placeholder" aria-label={`${title} image unavailable`} role="img">
      <FileImage size={18} />
    </span>
  );
}

function Skeleton({ message }: { message?: string }) {
  return (
    <div className="rpm-result-card" style={{ marginTop: 18 }}>
      <div className="rpm-skeleton">
        <span className="rpm-skeleton-line" style={{ width: "58%" }} />
        <span className="rpm-skeleton-line" style={{ width: "100%" }} />
        <span className="rpm-skeleton-line" style={{ width: "82%" }} />
      </div>
      {message && (
        <div className="rpm-loading-note">
          <Loader2 className="rpm-spin" size={15} />
          {message}
        </div>
      )}
    </div>
  );
}

function availableTabs(bootstrap: PortalBootstrap) {
  const tabs: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [];
  if (bootstrap.config.showOrderTracking) {
    tabs.push({ id: "track_order", label: t(bootstrap, "portal.tab.trackOrder"), icon: <Truck size={16} /> });
  }
  if (bootstrap.config.showReturnTracking) {
    tabs.push({ id: "track_return", label: t(bootstrap, "portal.tab.trackReturn"), icon: <PackageSearch size={16} /> });
  }
  if (bootstrap.config.showCreateReturnTab) {
    tabs.push({ id: "create", label: t(bootstrap, "portal.tab.createReturn"), icon: <RotateCcw size={16} /> });
  }
  return tabs.length ? tabs : [{ id: "track_return" as const, label: "Track return", icon: <PackageSearch size={16} /> }];
}

function initialTab(bootstrap: PortalBootstrap, tabs: Array<{ id: TabId }>): TabId {
  const preferred =
    bootstrap.config.defaultTab === "order" || bootstrap.config.defaultTab === "track"
      ? "track_order"
      : bootstrap.config.defaultTab === "create"
        ? "create"
        : "track_return";
  return tabs.some((tab) => tab.id === preferred) ? preferred : tabs[0]?.id || "track_return";
}

function orderLookupOptions(bootstrap: PortalBootstrap) {
  return [
    { value: "order_no" as const, label: t(bootstrap, "portal.lookup.orderNumber") },
    { value: "email" as const, label: t(bootstrap, "portal.lookup.emailAddress") },
    { value: "mobile" as const, label: t(bootstrap, "portal.lookup.phoneNumber") },
    { value: "forward_awb" as const, label: t(bootstrap, "portal.lookup.forwardAwb") },
  ];
}

function returnLookupOptions(bootstrap: PortalBootstrap) {
  return [
    { value: "return_id" as const, label: t(bootstrap, "portal.lookup.returnRequestId") },
    { value: "return_no" as const, label: t(bootstrap, "portal.lookup.returnNumber") },
    { value: "order_no" as const, label: t(bootstrap, "portal.lookup.orderNumber") },
    { value: "email" as const, label: t(bootstrap, "portal.lookup.emailAddress") },
    { value: "mobile" as const, label: t(bootstrap, "portal.lookup.phoneNumber") },
    { value: "return_awb" as const, label: t(bootstrap, "portal.lookup.returnAwb") },
  ];
}

function labelForLookup(bootstrap: PortalBootstrap, lookupType: LookupType) {
  const map: Record<LookupType, string> = {
    order_no: t(bootstrap, "portal.lookup.orderNumber"),
    return_id: t(bootstrap, "portal.lookup.returnRequestId"),
    return_no: t(bootstrap, "portal.lookup.returnNumber"),
    forward_awb: t(bootstrap, "portal.lookup.forwardAwb"),
    return_awb: t(bootstrap, "portal.lookup.returnAwb"),
    email: t(bootstrap, "portal.lookup.emailAddress"),
    mobile: t(bootstrap, "portal.lookup.phoneNumber"),
  };
  return map[lookupType];
}

function placeholderForLookup(bootstrap: PortalBootstrap, lookupType: LookupType) {
  if (lookupType === "email") return t(bootstrap, "portal.lookup.placeholderEmail");
  if (lookupType === "mobile") return t(bootstrap, "portal.lookup.placeholderPhone");
  if (lookupType.includes("awb")) return t(bootstrap, "portal.lookup.placeholderAwb");
  return t(bootstrap, "portal.lookup.placeholderOrder");
}

function trackingLabel(order: PortalOrder) {
  const first = order.fulfillments?.flatMap((f) => f.trackingInfo || [])[0];
  return first?.number || humanize(order.displayFulfillmentStatus || order.fulfillmentStatus || "Pending");
}

async function enrichResults(
  data: LookupResponse,
  api: PortalApi,
  bootstrap: PortalBootstrap,
  setResult: (next: LookupResponse) => void,
) {
  const orders = data.orders || [];
  const returns = data.returns || [];
  const ordersNeeding = orders.filter((order) => order._needsFyndEnrich && order.name);
  const returnsNeeding = returns.filter((returnCase) => returnCase._needsFyndEnrich && returnCase.id);
  if (ordersNeeding.length === 0 && returnsNeeding.length === 0) return;

  const nextOrders = [...orders];
  const nextReturns = [...returns];

  await Promise.all([
    ...ordersNeeding.map(async (order) => {
      const enriched = await api.enrich({ shop: bootstrap.shop, type: "orders", orderName: order.name });
      const index = nextOrders.findIndex((candidate) => candidate.name === order.name);
      if (index >= 0) nextOrders[index] = { ...nextOrders[index], fyndData: enriched.fyndData as Record<string, unknown> | null };
    }),
    returnsNeeding.length
      ? api
          .enrich({ shop: bootstrap.shop, type: "returns", returnIds: returnsNeeding.map((r) => r.id) })
          .then((enriched) => {
            const map = enriched.returnEnrichments || {};
            for (const [id, value] of Object.entries(map)) {
              const index = nextReturns.findIndex((candidate) => candidate.id === id);
              if (index >= 0) nextReturns[index] = { ...nextReturns[index], ...(value as PortalReturn) };
            }
          })
      : Promise.resolve(),
  ]);

  setResult({ ...data, orders: nextOrders, returns: nextReturns });
}

function lineItemWithPrice(item: PortalLineItem) {
  return {
    id: item.id,
    title: item.title,
    variantTitle: item.variantTitle || null,
    sku: item.sku || null,
    price: item.price || item.discountedPrice || null,
    imageUrl: item.imageUrl || null,
    productTags: item.productTags || [],
    productType: item.productType || null,
  };
}

function buildReturnItems(
  selectedRows: ItemSelection[],
  quantities: Record<string, number>,
  reason: string,
  condition: string,
) {
  return selectedRows.flatMap((row) => {
    const requestedQty = Math.max(1, Math.min(quantities[row.rowKey] || 1, row.availableQty || 1));
    const base = {
      reasonCode: reason || "Other",
      condition: condition || undefined,
    };

    if (row.memberLineItems?.length) {
      let remaining = requestedQty;
      const items: Array<{ lineItemId: string; qty: number; reasonCode: string; condition?: string }> = [];
      for (const member of row.memberLineItems) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, Math.max(0, member.availableQty || 0));
        if (take <= 0) continue;
        items.push({ lineItemId: member.lineItemId, qty: take, ...base });
        remaining -= take;
      }
      return items;
    }

    return [
      {
        lineItemId: row.lineItemId,
        qty: requestedQty,
        ...base,
        fyndShipmentId: row.fyndShipmentId,
        fyndBagId: row.fyndBagId,
        fyndArticleId: row.fyndArticleId,
        fyndAffiliateLineId: row.fyndAffiliateLineId,
        fyndSellerIdentifier: row.fyndSellerIdentifier,
        fyndItemId: row.fyndItemId,
        fyndQuantityAvailable: row.fyndQuantityAvailable,
        fyndPriceEffective: row.fyndPriceEffective,
        fyndSize: row.fyndSize,
        fyndLineNumber: row.fyndLineNumber,
      },
    ];
  });
}

function estimateRefund(
  data: OrderResponse | null,
  selectedRows: ItemSelection[],
  qty: Record<string, number>,
  bootstrap: PortalBootstrap,
) {
  if (!data) return formatMoney(0, bootstrap.currency, bootstrap.locale);
  const currency = data.returnFee?.currency || data.order?.currencyCode || bootstrap.currency;
  if (selectedRows.length === 0) return formatMoney(0, currency, bootstrap.locale);
  const estimates = data.lineItemEstimates || {};
  const total = selectedRows.reduce((sum, row) => {
    const estimate = Number(estimates[row.lineItemId]?.amount ?? row.price ?? 0);
    const count = Math.max(1, qty[row.rowKey] || 1);
    return sum + (Number.isFinite(estimate) ? estimate * count : 0);
  }, 0);
  const fee = Number(data.returnFee?.amount || 0);
  return formatMoney(Math.max(0, total - fee), currency, bootstrap.locale);
}

function findOffer(offers: ReturnOffer[], reason: string, selectedRows: ItemSelection[]) {
  if (!offers.length || !selectedRows.length) return null;
  const tags = selectedRows.flatMap((row) => row.productTags || []).map((tag) => tag.toLowerCase());
  return (
    offers.find((offer) => {
      const reasonMatches = !offer.reasonCode || offer.reasonCode === reason;
      const tagMatches = !offer.tag || tags.includes(offer.tag.toLowerCase());
      return reasonMatches && tagMatches;
    }) || null
  );
}

function buildExchangePreference(preference: string, choices: Record<string, ExchangeChoice>) {
  const selected = Object.values(choices).filter((choice) => choice.variantId);
  const summary = selected.map((choice) => `${choice.lineItemId}: ${choice.variantTitle}`).join("; ");
  return [preference.trim(), summary].filter(Boolean).join(" / ") || undefined;
}

async function copyText(text: string, notify: (toast: Toast) => void) {
  try {
    await navigator.clipboard.writeText(text);
    notify({ tone: "success", message: "Copied." });
  } catch {
    notify({ tone: "error", message: "Copy failed." });
  }
}
