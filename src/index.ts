import { debug, warnOnce } from "./log"
import { DEFAULT_EXCLUDED_PATHS, FIELD_LIMITS, clientIp, isPageView, trackedUrl, truncateUtf8 } from "./request"

export const DEFAULT_API_ENDPOINT = "https://api.kiscore.ai/track"

export interface KiScoreOptions {
  /** Site ID from the KIscore dashboard. Default: `KISCORE_SITE_ID`. */
  siteId?: string
  /** Server-only tracking secret. Default: `KISCORE_TRACKING_SECRET`. */
  trackingSecret?: string
  /** Default: `KISCORE_API_ENDPOINT`, otherwise `https://api.kiscore.ai/track`. */
  apiEndpoint?: string
  /**
   * Request header that your hosting proxy sets to the visitor IP, e.g.
   * `x-real-ip`. Default: `KISCORE_CLIENT_IP_HEADER`, on Vercel `x-real-ip`.
   */
  clientIpHeader?: string
  /** Default: `true`, unless `KISCORE_ENABLED=false`. */
  enabled?: boolean
  /** Logs every sent or skipped hit. Default: `KISCORE_DEBUG=true`. */
  debug?: boolean
  /** Timeout of the background request in milliseconds. Default: `2000`. */
  timeout?: number
  /** Additional path prefixes that are never tracked, e.g. `["/admin/"]`. */
  excludePaths?: string[]
}

/** The part of Next.js' `NextFetchEvent` that keeps the background request alive. */
export interface WaitUntilEvent {
  waitUntil(promise: Promise<unknown>): void
}

/**
 * Reports a page view to KIscore in the background. KIscore stores AI
 * crawler hits and visits referred by AI assistants; other visits are
 * discarded. Never throws and never delays the response.
 */
export function trackKiScore(request: Request, event?: WaitUntilEvent, options: KiScoreOptions = {}): Promise<void> {
  const config = resolveConfig(options)
  if (!config) return Promise.resolve()

  const url = new URL(request.url)
  if (!isPageView(request, url, [...DEFAULT_EXCLUDED_PATHS, ...config.excludePaths])) {
    return Promise.resolve()
  }

  const ip = clientIp(request, config.clientIpHeader)
  if (!ip) {
    debug(config.debug, `Skipped ${url.pathname}: no single valid IP in the "${config.clientIpHeader}" header.`)
    return Promise.resolve()
  }

  const payload = {
    url: trackedUrl(url),
    user_agent: truncateUtf8(request.headers.get("user-agent") ?? "", FIELD_LIMITS.user_agent),
    referer: truncateUtf8(request.headers.get("referer") ?? "", FIELD_LIMITS.referer),
    ip,
  }
  const sending = send(config, payload)
  event?.waitUntil(sending)
  return sending
}

type ProxyResult = Response | null | undefined | void

/**
 * Creates a Next.js proxy (or middleware) that reports page views to KIscore.
 *
 * ```ts
 * // proxy.ts
 * import { withKiScore } from "next-ki-score"
 * export const proxy = withKiScore()
 * ```
 *
 * Wrap an existing proxy to keep its behaviour. Requests it redirects are not
 * tracked, because the redirect target is tracked on the next request.
 */
export function withKiScore(options?: KiScoreOptions): (request: Request, event: WaitUntilEvent) => Promise<undefined>
export function withKiScore<Req extends Request, Evt extends WaitUntilEvent, Res extends ProxyResult>(
  handler: (request: Req, event: Evt) => Res | Promise<Res>,
  options?: KiScoreOptions,
): (request: Req, event: Evt) => Promise<Res>
export function withKiScore(
  handlerOrOptions?: ((request: Request, event: WaitUntilEvent) => ProxyResult | Promise<ProxyResult>) | KiScoreOptions,
  maybeOptions?: KiScoreOptions,
): (request: Request, event: WaitUntilEvent) => Promise<ProxyResult> {
  const handler = typeof handlerOrOptions === "function" ? handlerOrOptions : undefined
  const options = (typeof handlerOrOptions === "function" ? maybeOptions : handlerOrOptions) ?? {}

  return async (request, event) => {
    const result = handler ? await handler(request, event) : undefined
    if (!isRedirect(result)) void trackKiScore(request, event, options)
    return result
  }
}

interface ResolvedConfig {
  siteId: string
  trackingSecret: string
  apiEndpoint: string
  clientIpHeader: string
  debug: boolean
  timeout: number
  excludePaths: string[]
}

function resolveConfig(options: KiScoreOptions): ResolvedConfig | undefined {
  if (options.enabled === false || (options.enabled === undefined && isOff(env("KISCORE_ENABLED")))) {
    return undefined
  }

  const siteId = (options.siteId ?? env("KISCORE_SITE_ID") ?? "").trim()
  const trackingSecret = (options.trackingSecret ?? env("KISCORE_TRACKING_SECRET") ?? "").trim()
  if (!siteId || !trackingSecret) {
    warnOnce("KISCORE_SITE_ID or KISCORE_TRACKING_SECRET is missing, nothing is sent to KIscore.")
    return undefined
  }

  const clientIpHeader = (
    options.clientIpHeader ??
    env("KISCORE_CLIENT_IP_HEADER") ??
    (env("VERCEL") ? "x-real-ip" : "")
  )
    .trim()
    .toLowerCase()
  if (!clientIpHeader) {
    warnOnce(
      "KISCORE_CLIENT_IP_HEADER is missing, nothing is sent to KIscore. Set it to the header your hosting proxy fills with the visitor IP, e.g. x-real-ip.",
    )
    return undefined
  }

  return {
    siteId,
    trackingSecret,
    apiEndpoint: (options.apiEndpoint ?? env("KISCORE_API_ENDPOINT") ?? DEFAULT_API_ENDPOINT).trim().replace(/\/+$/, ""),
    clientIpHeader,
    debug: options.debug ?? isOn(env("KISCORE_DEBUG")),
    timeout: options.timeout ?? 2000,
    excludePaths: options.excludePaths ?? [],
  }
}

async function send(config: ResolvedConfig, payload: { url: string }): Promise<void> {
  try {
    const response = await fetch(`${config.apiEndpoint}/${encodeURIComponent(config.siteId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kiscore-Tracking-Secret": config.trackingSecret,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      // A redirect would forward the secret to another host.
      redirect: "error",
      signal: AbortSignal.timeout(config.timeout),
    })
    debug(config.debug, `Sent ${payload.url}: HTTP ${response.status}`)
  } catch (error) {
    debug(config.debug, `Failed to send ${payload.url}`, error)
  }
}

function isRedirect(result: ProxyResult): boolean {
  return Boolean(result && result.status >= 300 && result.status < 400)
}

function env(key: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[key]
}

function isOn(value: string | undefined): boolean {
  return value === "true" || value === "1"
}

function isOff(value: string | undefined): boolean {
  return value === "false" || value === "0"
}
