export async function isKairosEnabled(): Promise<boolean> {
  // Restored workspace fallback: without the unrecovered entitlement gate,
  // keep assistant mode disabled instead of accidentally enabling KAIROS flows.
  return false
}
