# next-ki-score

Server-side AI traffic tracking for Next.js, powered by [KIscore](https://kiscore.ai).

Every page request is reported from your Next.js server to KIscore in the
background. KIscore keeps the hits of AI crawlers (GPTBot, ClaudeBot,
PerplexityBot, …) and visits referred by AI assistants such as ChatGPT or
Perplexity. Everything else is discarded.

- **Two lines of code** in `proxy.ts`
- **No browser script, no cookies**: nothing is added to your pages
- **Background delivery**: the page does not wait for the collector response; `waitUntil` keeps delivery alive, with a 2 s timeout
- **No dependencies**, works in the Node.js and the Edge runtime
- **Next.js 16** (`proxy.ts`) and **Next.js 15** (`middleware.ts`)

## Quick start

**1. Install**

```bash
npm install https://github.com/tpwd/ki-score-next-module/releases/download/v1.0.0/next-ki-score-1.0.0.tgz
```

The built package is published as a [GitHub release](https://github.com/tpwd/ki-score-next-module/releases/tag/v1.0.0).
It is not yet published in the npm registry. The command above installs the
release archive with npm; no build tools are needed in your application.

**2. Set the environment variables** on your server or hosting platform. Copy
the values from **Traffic Overview → Integration** in the KIscore dashboard.

```bash
KISCORE_CONNECTION_KEY=your-site-id.your-tracking-secret
KISCORE_CLIENT_IP_HEADER=x-real-ip   # not needed on Vercel, see "Visitor IP"
```

Use the connection key from the dashboard. Existing installations can continue
using `KISCORE_SITE_ID` and `KISCORE_TRACKING_SECRET` instead.

Never prefix them with `NEXT_PUBLIC_`. The tracking secret must not reach the
browser or a public repository.

**3. Create `proxy.ts`** next to your `app` directory (inside `src` if you use
one):

```ts
import { withKiScore } from "next-ki-score"

export const proxy = withKiScore()
```

On Next.js 15 the file is called `middleware.ts`:

```ts
import { withKiScore } from "next-ki-score"

export const middleware = withKiScore()
```

That's it. Deploy, then [check the integration](#check-the-integration).

## You already have a proxy

Next.js supports only one proxy file. Wrap your existing function; its
behaviour, return value and errors stay unchanged:

```ts
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { withKiScore } from "next-ki-score"

export const proxy = withKiScore((request: NextRequest) => {
  if (!request.cookies.has("session") && request.nextUrl.pathname.startsWith("/account")) {
    return NextResponse.redirect(new URL("/login", request.url))
  }
  return NextResponse.next()
})

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
```

Requests your proxy redirects or rejects are not reported; explicit non-HTML
responses are skipped as well. A redirect target is reported when the browser
requests it. The wrapper cannot inspect the final page response when your
proxy continues or rewrites the request: downstream errors and content types
are decided later by Next.js.

If you prefer to keep full control, call `trackKiScore` yourself:

```ts
import { NextResponse } from "next/server"
import type { NextFetchEvent, NextRequest } from "next/server"
import { trackKiScore } from "next-ki-score"

export function proxy(request: NextRequest, event: NextFetchEvent) {
  trackKiScore(request, event)
  return NextResponse.next()
}
```

A `matcher` is optional. The package skips assets itself, but a matcher saves
your proxy from running on them at all. Next.js reads the matcher at build time,
so it has to be written in your own `proxy.ts`.

## Visitor IP

KIscore counts each visitor once per day and source and needs the visitor IP
for that. For human visitors it stores only a daily hash, never the address
itself; AI crawler hits are stored with their IP. In a proxy, Next.js does not
expose the connection IP, so the package reads it from a header that **your
hosting proxy sets and overwrites** on every request:

| Hosting                                                         | `KISCORE_CLIENT_IP_HEADER`                       |
| --------------------------------------------------------------- | ------------------------------------------------ |
| Vercel                                                          | not needed, `x-real-ip` is used automatically    |
| Netlify                                                         | `x-nf-client-connection-ip`                      |
| Cloudflare, if your server only accepts traffic from Cloudflare | `cf-connecting-ip`                               |
| nginx with `proxy_set_header X-Real-IP $remote_addr;`           | `x-real-ip`                                      |
| any other reverse proxy                                         | the header it sets to the connecting client's IP |

Do not use a header that the visitor can set unchecked, or a list such as
`x-forwarded-for`. Only a single valid IPv4 or IPv6 address is accepted. If
the header is missing or invalid, the request is not reported: otherwise every
visit would be counted under your server's IP as one visitor.

## What is sent

For each page view, one `POST` request to `https://api.kiscore.ai/track/<site-id>`:

| Field        | Value                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `url`        | Path plus `utm_*` parameters, e.g. `/pricing?utm_source=chatgpt.com`. Other query parameters can contain tokens or email addresses and are never sent. |
| `user_agent` | The visitor's user agent                                                                                                                               |
| `referer`    | The visitor's referrer                                                                                                                                 |
| `ip`         | The visitor IP from the configured header                                                                                                              |

The tracking secret travels in the `X-Kiscore-Tracking-Secret` header. The
request refuses redirects, so the secret cannot be forwarded to another host.

Not reported:

- non-`GET` requests, `/api` routes, `/_next/*` and static files (images, scripts, styles, fonts, `robots.txt`, `sitemap.xml`, …)
- client-side navigations and link prefetches (browsers mark them with `Sec-Fetch-Mode`, Next.js additionally with `rsc` and `next-router-prefetch`)
- redirects, error responses and explicit non-HTML responses returned by your wrapped proxy
- requests without a valid visitor IP

Next.js must run your proxy for the request. Static pages served through the
Next.js proxy can be reported. A static export has no proxy, and an external
CDN that serves a request before it reaches Next.js bypasses this integration.

## Configuration

All settings can be passed as options or set as environment variables.
Explicit `siteId` and `trackingSecret` options take precedence over the
connection key; a connection key takes precedence over the separate environment
variables. A malformed connection key disables tracking rather than falling
back to potentially stale credentials.

```ts
export const proxy = withKiScore({
  excludePaths: ["/admin/", "/preview/"],
  debug: true,
})

// or, wrapping an existing proxy:
export const proxy = withKiScore(myProxy, { excludePaths: ["/admin/"] })
```

| Option           | Environment variable                                                                  | Default                                                         |
| ---------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `connectionKey`  | `KISCORE_CONNECTION_KEY`                                                              | dashboard connection key, or use the separate credentials below |
| `siteId`         | `KISCORE_SITE_ID`                                                                     | required                                                        |
| `trackingSecret` | `KISCORE_TRACKING_SECRET`                                                             | required                                                        |
| `clientIpHeader` | `KISCORE_CLIENT_IP_HEADER`                                                            | `x-real-ip` on Vercel, otherwise required                       |
| `apiEndpoint`    | `KISCORE_API_ENDPOINT`                                                                | `https://api.kiscore.ai/track`                                  |
| `enabled`        | `KISCORE_ENABLED` (`false` turns tracking off)                                        | `true`                                                          |
| `debug`          | `KISCORE_DEBUG` (`true` logs each report and each page view skipped for a missing IP) | `false`                                                         |
| `timeout`        |                                                                                       | `2000` ms                                                       |
| `excludePaths`   |                                                                                       | `[]`, added to the built-in exclusions                          |

If the credentials or the IP header are missing, nothing is
sent and the server log shows one warning naming the missing variable.

## Check the integration

Open any page of your deployed site with
`?utm_source=chatgpt.com&utm_campaign=kiscore-integration-test` (use `&` if the
URL already has a query). The visit then appears under **KI-Verweise** in
Traffic Overview. The same visitor is counted once per day and source.

Test on a deployment (preview or staging). Locally, `next dev` runs without a
hosting proxy, so there is no visitor IP and nothing is sent.

Nothing showing up? Set `KISCORE_DEBUG=true` and look at the server log of the
request:

- `KISCORE_CONNECTION_KEY … is missing`: the variables are not available at runtime
- `KISCORE_CONNECTION_KEY must contain site-id.tracking-secret`: copy the complete key from the dashboard
- `KISCORE_CLIENT_IP_HEADER is missing`: see [Visitor IP](#visitor-ip)
- `Skipped /…: no single valid IP in the "…" header`: your hosting does not set that header
- `Sent /…: HTTP 401`: site ID and tracking secret do not match

## Development

```bash
bun install
bun run test        # unit tests
bun run test:e2e    # builds a Next.js 16 app with proxy.ts and checks what reaches a local collector
bun run typecheck
bun run build
bun run test:package # installs the archive in a clean npm consumer; checks Node ESM and CommonJS
```

`test:e2e` uses one small Next.js app and a local HTTP collector. It checks the
actual production proxy, authenticated reports, excluded requests and delivery
when the collector is slow or unavailable. It does not provision hosted
platforms. Hosted deployments still need a manual check of the trusted IP
header and the resulting traffic in KIscore.

## Releases

Run the checks above, then `npm pack --pack-destination /tmp`. The archive
contains the built ESM/CommonJS code, declarations, README and MIT license.
Tag the checked commit, publish the archive and its SHA-256 checksum on GitHub,
and keep the GitLab mirror on the same commit and tag. GitHub source archives
do not include the built `dist` directory; install the `.tgz` release asset.

## License

MIT
