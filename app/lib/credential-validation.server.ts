/**
 * Input validation and sanitization for credentials.
 * Prevents injection, oversized payloads, and malformed data.
 */

const MAX_LENGTH = {
  companyId: 64,
  applicationId: 128,
  clientId: 256,
  clientSecret: 512,
  applicationToken: 512,
  customBaseUrl: 256,
  policyJson: 16 * 1024, // 16KB
};

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function sanitizeCredentialInputs(values: {
  fyndCompanyId?: string;
  fyndApplicationId?: string;
  fyndClientId?: string;
  fyndClientSecret?: string;
  fyndApplicationToken?: string;
  fyndCustomBaseUrl?: string;
  policyJson?: string;
}): { valid: boolean; error?: string; sanitized?: typeof values } {
  const sanitized = { ...values };

  if (values.fyndCompanyId !== undefined) {
    const v = values.fyndCompanyId.trim();
    if (v.length > MAX_LENGTH.companyId) return { valid: false, error: "Company ID too long" };
    if (v && !ID_PATTERN.test(v)) return { valid: false, error: "Company ID contains invalid characters" };
    sanitized.fyndCompanyId = v;
  }

  if (values.fyndApplicationId !== undefined) {
    const v = values.fyndApplicationId.trim();
    if (v.length > MAX_LENGTH.applicationId) return { valid: false, error: "Application ID too long" };
    if (v && !ID_PATTERN.test(v)) return { valid: false, error: "Application ID contains invalid characters" };
    sanitized.fyndApplicationId = v;
  }

  if (values.fyndClientId !== undefined) {
    const v = values.fyndClientId.trim();
    if (v.length > MAX_LENGTH.clientId) return { valid: false, error: "Client ID too long" };
    sanitized.fyndClientId = v;
  }

  if (values.fyndClientSecret !== undefined) {
    const v = values.fyndClientSecret.trim();
    if (v.length > MAX_LENGTH.clientSecret) return { valid: false, error: "Client Secret too long" };
    sanitized.fyndClientSecret = v;
  }

  if (values.fyndApplicationToken !== undefined) {
    const v = values.fyndApplicationToken.trim();
    if (v.length > MAX_LENGTH.applicationToken) return { valid: false, error: "Application Token too long" };
    sanitized.fyndApplicationToken = v;
  }

  if (values.fyndCustomBaseUrl !== undefined) {
    const v = values.fyndCustomBaseUrl.trim();
    if (v.length > MAX_LENGTH.customBaseUrl) return { valid: false, error: "Custom URL too long" };
    if (v) {
      try {
        const url = new URL(v.startsWith("http") ? v : `https://${v}`);
        if (!["http:", "https:"].includes(url.protocol)) return { valid: false, error: "URL must be HTTPS" };
      } catch {
        return { valid: false, error: "Invalid custom URL format" };
      }
    }
    sanitized.fyndCustomBaseUrl = v;
  }

  if (values.policyJson !== undefined) {
    const v = values.policyJson.trim();
    if (v.length > MAX_LENGTH.policyJson) return { valid: false, error: "Policy JSON too long" };
    if (v && v !== "{}") {
      try {
        JSON.parse(v);
      } catch {
        return { valid: false, error: "Policy must be valid JSON" };
      }
    }
    sanitized.policyJson = v;
  }

  return { valid: true, sanitized };
}
