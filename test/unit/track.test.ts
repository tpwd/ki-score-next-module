import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Mock } from "bun:test"

import { trackKiScore, withKiScore } from "../../src/index"
import { resetWarnings } from "../../src/log"

const ENV_KEYS = [
  "KISCORE_SITE_ID",
  "KISCORE_TRACKING_SECRET",
  "KISCORE_API_ENDPOINT",
  "KISCORE_CLIENT_IP_HEADER",
  "KISCORE_ENABLED",
  "KISCORE_DEBUG",
  "VERCEL",
  "NODE_ENV",
]

let savedEnv: Record<string, string | undefined>
let fetchMock: Mock<typeof fetch>
let warnMock: Mock<typeof console.warn>

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.NODE_ENV = "test"
  process.env.KISCORE_SITE_ID = "site-123"
  process.env.KISCORE_TRACKING_SECRET = "local-test-only"
  process.env.KISCORE_CLIENT_IP_HEADER = "x-real-ip"
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    fakeFetch(async () => new Response(null, { status: 200 })),
  )
  warnMock = spyOn(console, "warn").mockImplementation(() => {})
  resetWarnings()
})

afterEach(() => {
  fetchMock.mockRestore()
  warnMock.mockRestore()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

// Bun's fetch type carries extra properties such as preconnect.
function fakeFetch(implementation: () => Promise<Response>) {
  return implementation as unknown as typeof fetch
}

function request(
  path = "/beratung?utm_source=chatgpt.com&utm_campaign=test&token=reset-token",
  headers: Record<string, string> = {},
  method = "GET",
) {
  return new Request(`https://example.com${path}`, {
    method,
    headers: {
      accept: "text/html",
      "user-agent": "Mozilla/5.0",
      referer: "https://chatgpt.com/",
      "x-real-ip": "203.0.113.7",
      ...headers,
    },
  })
}

function event() {
  const pending: Promise<unknown>[] = []
  return { pending, waitUntil: (promise: Promise<unknown>) => pending.push(promise) }
}

function sentBody(call = 0) {
  return JSON.parse(String(fetchMock.mock.calls[call]?.[1]?.body))
}

describe("trackKiScore", () => {
  test("sends an authenticated hit with the path and its utm parameters only", async () => {
    const ev = event()
    await trackKiScore(request(), ev)

    expect(ev.pending).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.kiscore.ai/track/site-123")
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-Kiscore-Tracking-Secret": "local-test-only",
      },
    })
    expect(sentBody()).toEqual({
      url: "/beratung?utm_source=chatgpt.com&utm_campaign=test",
      user_agent: "Mozilla/5.0",
      referer: "https://chatgpt.com/",
      ip: "203.0.113.7",
    })
  })

  test("reads the client IP from x-real-ip on Vercel without further configuration", async () => {
    delete process.env.KISCORE_CLIENT_IP_HEADER
    await trackKiScore(request())
    expect(fetchMock).not.toHaveBeenCalled()

    process.env.VERCEL = "1"
    await trackKiScore(request())
    expect(sentBody().ip).toBe("203.0.113.7")
  })

  test("prefers explicit options over environment variables", async () => {
    await trackKiScore(request("/", { "cf-connecting-ip": "2001:db8::1" }), undefined, {
      siteId: "site/with space",
      trackingSecret: "option-secret",
      apiEndpoint: "https://collector.example.test/track/",
      clientIpHeader: "CF-Connecting-IP",
    })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://collector.example.test/track/site%2Fwith%20space")
    expect(init?.headers).toMatchObject({ "X-Kiscore-Tracking-Secret": "option-secret" })
    expect(sentBody().ip).toBe("2001:db8::1")
  })

  test("skips assets, API routes, prefetches, RSC requests and non-GET requests", async () => {
    for (const req of [
      request("/api"),
      request("/api/health"),
      request("/_next/static/chunks/main.js", { accept: "*/*" }),
      request("/_next/image?url=%2Fhero.png", { accept: "image/avif" }),
      request("/favicon.ico", { accept: "*/*" }),
      request("/hero.webp", { accept: "*/*" }),
      request("/robots.txt", { accept: "*/*" }),
      request("/sitemap.xml", { accept: "*/*" }),
      request("/", { rsc: "1" }),
      request("/?_rsc=1x2y3", { accept: "*/*" }),
      request("/", { "next-router-prefetch": "1" }),
      request("/", { purpose: "prefetch" }),
      request("/", { "sec-purpose": "prefetch;prerender" }),
      request("/", { accept: "application/json" }),
      request("/", {}, "POST"),
      request("/", {}, "HEAD"),
    ]) {
      await trackKiScore(req)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // In proxy.ts Next.js strips the rsc and prefetch headers and the _rsc
  // parameter. Browsers still mark client navigations and prefetches as fetches.
  test("skips browser fetches such as client navigations and link prefetches", async () => {
    await trackKiScore(
      request("/about", { accept: "*/*", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }),
    )
    expect(fetchMock).not.toHaveBeenCalled()

    await trackKiScore(request("/about", { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("honours additional excluded paths", async () => {
    await trackKiScore(request("/admin/users"), undefined, { excludePaths: ["/admin"] })
    expect(fetchMock).not.toHaveBeenCalled()
    await trackKiScore(request("/administration"), undefined, { excludePaths: ["/admin/"] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("tracks crawlers that send no accept header", async () => {
    const req = request("/preise")
    req.headers.delete("accept")
    await trackKiScore(req)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // Without the visitor's own IP, KI Score would attribute every visit to the
  // Next.js server and count them all as one visitor.
  test("skips requests without exactly one valid client IP", async () => {
    for (const ip of ["", "unknown", "203.0.113.7, 198.51.100.2", "999.1.1.1", "::g"]) {
      await trackKiScore(request("/", { "x-real-ip": ip }))
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("skips when it is not configured or switched off", async () => {
    process.env.KISCORE_ENABLED = "false"
    delete process.env.KISCORE_TRACKING_SECRET
    await trackKiScore(request())
    expect(warnMock).not.toHaveBeenCalled()

    delete process.env.KISCORE_ENABLED
    await trackKiScore(request())
    process.env.KISCORE_TRACKING_SECRET = "local-test-only"
    await trackKiScore(request(), undefined, { enabled: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("warns once per missing setting instead of on every request", async () => {
    delete process.env.KISCORE_SITE_ID
    await trackKiScore(request())
    await trackKiScore(request())
    process.env.KISCORE_SITE_ID = "site-123"
    delete process.env.KISCORE_CLIENT_IP_HEADER
    await trackKiScore(request())
    await trackKiScore(request())

    expect(warnMock.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining("KISCORE_SITE_ID"),
      expect.stringContaining("KISCORE_CLIENT_IP_HEADER"),
    ])
  })

  test("truncates oversized fields to the API limits without breaking characters", async () => {
    await trackKiScore(
      request(`/${"ä".repeat(1500)}`, {
        "user-agent": `GPTBot ${"x".repeat(2000)}`,
        referer: `https://chatgpt.com/${"y".repeat(3000)}`,
      }),
    )

    const body = sentBody()
    const bytes = (value: string) => new TextEncoder().encode(value).length
    expect(bytes(body.url)).toBeLessThanOrEqual(2048)
    expect(bytes(body.user_agent)).toBe(1024)
    expect(bytes(body.referer)).toBe(2048)
    expect(body.url).not.toContain("�")
    expect(body.user_agent.startsWith("GPTBot ")).toBe(true)
  })

  test("a failing tracking request never rejects", async () => {
    fetchMock.mockImplementation(
      fakeFetch(async () => {
        throw new Error("network down")
      }),
    )
    const ev = event()
    await expect(trackKiScore(request(), ev)).resolves.toBeUndefined()
    await expect(Promise.all(ev.pending)).resolves.toEqual([undefined])
  })
})

describe("withKiScore", () => {
  test("continues the request when used without an own proxy", async () => {
    const proxy = withKiScore()
    const ev = event()
    expect(await proxy(request(), ev)).toBeUndefined()
    await Promise.all(ev.pending)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("returns the response of the wrapped proxy and tracks in the background", async () => {
    const response = new Response("ok")
    const proxy = withKiScore(() => response)
    const ev = event()
    expect(await proxy(request(), ev)).toBe(response)
    await Promise.all(ev.pending)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("passes options when wrapping an own proxy", async () => {
    const proxy = withKiScore(() => undefined, { siteId: "wrapped-site" })
    await proxy(request(), event())
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.kiscore.ai/track/wrapped-site")
  })

  // A redirect is not a page view; its target is tracked on the next request.
  test("does not track requests the wrapped proxy redirects", async () => {
    const proxy = withKiScore(() => Response.redirect("https://example.com/login", 307))
    await proxy(request(), event())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rethrows errors of the wrapped proxy without tracking", async () => {
    const proxy = withKiScore(() => {
      throw new Error("auth backend down")
    })
    await expect(proxy(request(), event())).rejects.toThrow("auth backend down")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
