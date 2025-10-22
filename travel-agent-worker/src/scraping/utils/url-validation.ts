const MALICIOUS_PROTOCOLS = new Set(["javascript:", "data:", "file:"]);

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateUrl(url: string, allowList: string[] = []): UrlValidationResult {
  try {
    const parsed = new URL(url);
    if (MALICIOUS_PROTOCOLS.has(parsed.protocol)) {
      return { valid: false, reason: "Unsupported protocol" };
    }

    if (allowList.length > 0 && !allowList.some((domain) => parsed.hostname.endsWith(domain))) {
      return { valid: false, reason: "Domain not allowed" };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, reason: (error as Error).message };
  }
}

export function normalizeUrl(url: string): string {
  return new URL(url).toString();
}
