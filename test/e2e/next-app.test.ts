import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"

// Builds test/fixtures/next-app (proxy.ts: `export const proxy = withKiScore()`)
// against the built package and serves it with `next start`. A local collector
// stands in for the KI Score API.

const root = fileURLToPath(new URL("../..", import.meta.url))
const fixture = "test/fixtures/next-app"
const next = `${root}/node_modules/.bin/next`

interface Hit {
  path: string
  secret: string | null
  body: { url: string; user_agent: string; referer: string; ip: string }
}

const hits: Hit[] = []
const collector = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    hits.push({
      path: new URL(request.url).pathname,
      secret: request.headers.get("x-kiscore-tracking-secret"),
      body: await request.json(),
    })
    return Response.json({ status: "ok" })
  },
})

let app: ReturnType<typeof Bun.spawn> | undefined
let baseUrl = ""

beforeAll(async () => {
  await run([next, "build", fixture])

  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  app = Bun.spawn([next, "start", fixture, "-p", String(port), "-H", "127.0.0.1"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      KISCORE_SITE_ID: "e2e-site",
      KISCORE_TRACKING_SECRET: "e2e-local-secret",
      KISCORE_API_ENDPOINT: `http://127.0.0.1:${collector.port}/track`,
      KISCORE_CLIENT_IP_HEADER: "x-real-ip",
    },
    stdout: "ignore",
    stderr: "inherit",
  })
  await waitFor(async () => (await fetch(baseUrl)).ok, 30_000)
})

afterAll(async () => {
  app?.kill()
  await app?.exited
  collector.stop(true)
})

const browserPage = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  referer: "https://chatgpt.com/",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  "x-real-ip": "203.0.113.7",
}

describe("next start with withKiScore()", () => {
  test("reports a page view with the path and its utm parameters", async () => {
    const response = await fetch(`${baseUrl}/?utm_source=chatgpt.com&utm_campaign=e2e&token=reset-token`, {
      headers: { ...browserPage, "user-agent": "KIscore-E2E-Page/1.0" },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("fixture home")

    const hit = await hitFrom("KIscore-E2E-Page/1.0")
    expect(hit).toEqual({
      path: "/track/e2e-site",
      secret: "e2e-local-secret",
      body: {
        url: "/?utm_source=chatgpt.com&utm_campaign=e2e",
        user_agent: "KIscore-E2E-Page/1.0",
        referer: "https://chatgpt.com/",
        ip: "203.0.113.7",
      },
    })
  })

  test("does not report client navigations, prefetches, assets or visitors without IP", async () => {
    // Headers as sent by the Next.js 16 app router for a client navigation.
    const navigation = {
      accept: "*/*",
      rsc: "1",
      "next-router-state-tree": encodeURIComponent(JSON.stringify(["", { children: ["__PAGE__", {}] }])),
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "x-real-ip": "203.0.113.7",
      "user-agent": "KIscore-E2E-Skipped/1.0",
    }
    const rsc = await fetch(`${baseUrl}/about?_rsc=e2e`, { headers: navigation })
    expect(rsc.headers.get("content-type")).toContain("text/x-component")
    await (
      await fetch(`${baseUrl}/about?_rsc=e2e`, { headers: { ...navigation, "next-router-prefetch": "1" } })
    ).arrayBuffer()

    const html = await (await fetch(baseUrl, { headers: browserPage })).text()
    const chunk = html.match(/\/_next\/static\/[^"]+\.js/)?.[0]
    expect(chunk).toBeDefined()
    for (const path of [chunk!, "/favicon.ico"]) {
      await (
        await fetch(`${baseUrl}${path}`, { headers: { accept: "*/*", "x-real-ip": "203.0.113.7", "user-agent": "KIscore-E2E-Skipped/1.0" } })
      ).arrayBuffer()
    }
    const { "x-real-ip": _, ...withoutIp } = browserPage
    await (await fetch(`${baseUrl}/about`, { headers: { ...withoutIp, "user-agent": "KIscore-E2E-Skipped/1.0" } })).text()

    // Requests are sent in the background: wait for a later page view first.
    await (await fetch(`${baseUrl}/about`, { headers: { ...browserPage, "user-agent": "KIscore-E2E-Sentinel/1.0" } })).text()
    await hitFrom("KIscore-E2E-Sentinel/1.0")
    await Bun.sleep(250)
    expect(hits.filter((hit) => hit.body.user_agent === "KIscore-E2E-Skipped/1.0")).toEqual([])
  })
})

async function hitFrom(userAgent: string): Promise<Hit> {
  let hit: Hit | undefined
  await waitFor(() => (hit = hits.find((candidate) => candidate.body.user_agent === userAgent)) !== undefined, 5_000)
  return hit!
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeout: number) {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      if (await condition()) return
    } catch {
      // Server not up yet.
    }
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeout} ms`)
    await Bun.sleep(100)
  }
}

async function run(command: string[]) {
  const child = Bun.spawn(command, { cwd: root, stdout: "ignore", stderr: "inherit" })
  if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed`)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))))
    })
  })
}
