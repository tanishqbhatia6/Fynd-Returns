/**
 * User-friendly Return Request ID for display (e.g. RPM-A1B2C3D4)
 * Safe to use in both client and server.
 */
export function formatReturnRequestId(id: string): string {
  if (!id || id.length < 8) return id;
  const suffix = id.slice(-8).toUpperCase().replace(/[^A-Z0-9]/g, "X");
  return `RPM-${suffix}`;
}
