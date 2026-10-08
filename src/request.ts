// Byte limits of the KIscore tracking API. Longer values are rejected with 413.
export const FIELD_LIMITS = { url: 2048, user_agent: 1024, referer: 2048 } as const

export const DEFAULT_EXCLUDED_PATHS: readonly string[] = ["/api/", "/_next/", "/_vercel/", "/__nextjs"]

const STATIC_FILE =
  /\.(?:ico|png|jpe?g|webp|avif|gif|svg|css|js|mjs|map|json|webmanifest|woff2?|ttf|otf|eot|pdf|xml|txt|mp4|webm|mp3)$/i

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/**
 * Whether a request is a full page view worth reporting: a GET for an HTML
 * document. Assets, API routes, prefetches and client-side RSC navigations are
 * skipped.
 */
export function isPageView(request: Request, url: URL, excludePaths: readonly string[]): boolean {
  if (request.method !== "GET") return false

  const path = url.pathname
  if (path === "/api" || excludePaths.some((prefix) => path.startsWith(prefix))) return false
  if (STATIC_FILE.test(path) || url.searchParams.has("_rsc")) return false

  const headers = request.headers
  const fetchMode = headers.get("sec-fetch-mode")
  if (
    // Browsers send "navigate" for page loads. Client navigations and link
    // prefetches are fetches; in proxy.ts Next.js strips their rsc headers.
    (fetchMode && fetchMode !== "navigate") ||
    headers.has("rsc") ||
    headers.has("next-router-prefetch") ||
    headers.has("x-middleware-prefetch") ||
    headers.get("purpose") === "prefetch" ||
    headers.get("sec-purpose")?.includes("prefetch")
  ) {
    return false
  }

  const accept = headers.get("accept")
  return !accept || accept.includes("text/html") || accept.includes("*/*")
}

/**
 * Reads the visitor IP from a header the hosting proxy overwrites. A list of
 * addresses or anything that is not a single IP is rejected, because the
 * visitor could have sent it.
 */
export function clientIp(request: Request, header: string): string | undefined {
  const value = request.headers.get(header)?.trim()
  return value && isIpAddress(value) ? value : undefined
}

export function isIpAddress(value: string): boolean {
  if (IPV4.test(value)) return true
  if (!value.includes(":") || !/^[\da-f:.]+$/i.test(value)) return false
  try {
    new URL(`http://[${value}]/`)
    return true
  } catch {
    return false
  }
}

/**
 * Path plus utm_* parameters. KIscore recognises AI referrals by utm_source;
 * other query parameters can carry tokens or email addresses and stay on the
 * site's server.
 */
export function trackedUrl(url: URL): string {
  const utm = new URLSearchParams()
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase().startsWith("utm_")) utm.append(key, value)
  }
  const query = utm.toString()
  const tracked = truncateUtf8(query ? `${url.pathname}?${query}` : url.pathname, FIELD_LIMITS.url)
  // Never end on a cut percent escape such as "%C3%A".
  return tracked.replace(/%[\da-f]?$/i, "")
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length <= maxBytes) return value

  let end = maxBytes
  // Step back to the start of a character instead of splitting it.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return new TextDecoder().decode(bytes.subarray(0, end))
}
