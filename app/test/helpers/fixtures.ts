/**
 * Test data factories for all Prisma models.
 * Each factory returns a complete object with sensible defaults, allowing overrides.
 */

let counter = 0;
function uid() { return `test-${++counter}`; }

export function createShop(overrides?: Record<string, unknown>) {
  return {
    id: uid(),
    shopDomain: "test-shop.myshopify.com",
    installedAt: new Date(),
    updatedAt: new Date(),
    settings: null,
    ...overrides,
  };
}

export function createShopSettings(overrides?: Record<string, unknown>) {
  return {
    id: uid(),
    shopId: "shop-1",
    returnWindowDays: 30,
    autoApproveEnabled: false,
    autoRefundEnabled: false,
    photoRequired: false,
    refundPaymentMethod: "original",
    refundLocationMode: "auto",
    refundLocationId: null,
    returnFeeAmount: null,
    returnFeeCurrency: "USD",
    bonusCreditEnabled: false,
    bonusCreditPct: 10,
    greenReturnsEnabled: false,
    greenReturnsThreshold: null,
    blocklistEnabled: false,
    portalLanguage: "en",
    shopLocale: "en",
    shopCurrency: "USD",
    shopTimezone: "UTC",
    fyndCompanyId: null,
    fyndApplicationId: null,
    fyndCredentials: null,
    fyndEnvironment: null,
    smtpHost: null,
    smtpPort: 587,
    smtpUser: null,
    smtpPass: null,
    smtpFromEmail: null,
    smtpFromName: null,
    smtpSecure: false,
    adminNotifyEmail: null,
    adminSoundEnabled: true,
    discountCodeRefundEnabled: false,
    discountCodePrefix: "RETURN",
    discountCodeExpiryDays: 90,
    portalExchangeEnabled: false,
    returnReasonsJson: null,
    policyJson: null,
    autoApproveRulesJson: null,
    returnOffersJson: null,
    restrictedRegionsJson: null,
    productPoliciesJson: null,
    portalThemeJson: null,
    portalConfigJson: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function createReturnCase(overrides?: Record<string, unknown>) {
  return {
    id: uid(),
    returnRequestNo: "RPM-TEST1234",
    shopId: "shop-1",
    shopifyOrderId: "gid://shopify/Order/12345",
    shopifyOrderName: "#1001",
    shopifyReturnId: null,
    status: "pending",
    refundStatus: null,
    resolutionType: "refund",
    customerName: "John Doe",
    customerEmailNorm: "john@example.com",
    customerPhoneNorm: "+11234567890",
    customerCity: "New York",
    customerCountry: "US",
    customerAddress1: "123 Main St",
    customerAddress2: null,
    customerProvince: "NY",
    customerZip: "10001",
    customerLandmark: null,
    currency: "USD",
    rejectionReason: null,
    adminNotes: null,
    notesForCustomer: null,
    customerNotes: null,
    customerMediaJson: null,
    isGreenReturn: false,
    bonusCreditAmount: null,
    discountCode: null,
    discountCodeValue: null,
    fyndReturnId: null,
    fyndReturnNo: null,
    fyndOrderId: null,
    fyndShipmentId: null,
    fyndCurrentStatus: null,
    fyndPayloadJson: null,
    fyndSyncStatus: null,
    fyndSyncRetries: 0,
    fyndSyncError: null,
    fyndSyncNextRetry: null,
    forwardAwb: null,
    returnAwb: null,
    refundJson: null,
    returnLabelUrl: null,
    returnLabelJson: null,
    exchangeOrderId: null,
    exchangeOrderName: null,
    exchangeItemsJson: null,
    exchangePreference: null,
    orderProcessedAt: null,
    lastFyndStatusCheck: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [],
    events: [],
    ...overrides,
  };
}

export function createReturnItem(overrides?: Record<string, unknown>) {
  return {
    id: uid(),
    returnCaseId: "rc-1",
    shopifyLineItemId: "gid://shopify/LineItem/999",
    title: "Blue T-Shirt",
    variantTitle: "Medium",
    sku: "BTS-M-001",
    price: "29.99",
    imageUrl: null,
    qty: 1,
    reasonCode: "wrong_size",
    notes: null,
    condition: "unused",
    fyndShipmentId: null,
    fyndBagId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

export function createReturnEvent(overrides?: Record<string, unknown>) {
  return {
    id: uid(),
    returnCaseId: "rc-1",
    source: "admin",
    eventType: "created",
    payloadJson: null,
    happenedAt: new Date(),
    ...overrides,
  };
}

export function createLookupSession(overrides?: Record<string, unknown>) {
  return {
    id: uid(),
    shopId: "shop-1",
    lookupType: "email",
    lookupValueHash: "abc123hash",
    lookupValueNorm: "john@example.com",
    matchedReturnIds: null,
    otpTarget: "john@example.com",
    otpSentAt: null,
    verifiedAt: null,
    expiresAt: new Date(Date.now() + 3600_000),
    attemptsCount: 0,
    portalToken: null,
    createdAt: new Date(),
    ...overrides,
  };
}

export function createApiKey(overrides?: Record<string, unknown>) {
  return {
    id: uid(),
    shopId: "shop-1",
    name: "Test Key",
    keyHash: "$2a$10$fakehashfortest",
    keyPrefix: "rpm_test",
    permissions: JSON.stringify(["read_returns", "write_returns", "read_settings", "manage_webhooks"]),
    isActive: true,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    shop: { id: "shop-1", shopDomain: "test-shop.myshopify.com" },
    ...overrides,
  };
}
