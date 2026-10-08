# next-ki-score

Server-side AI traffic tracking for Next.js, powered by [KI Score](https://kiscore.ai).

Every page request is reported from your Next.js server to KI Score in the
background. KI Score keeps the hits of AI crawlers (GPTBot, ClaudeBot,
PerplexityBot, …) and visits referred by AI assistants such as ChatGPT or
Perplexity. Everything else is discarded.

- **Two lines of code** in `proxy.ts`
- **No browser script, no cookies**: nothing is added to your pages
- **Never slows a page down**: sent after the response via `waitUntil`, 2 s timeout, errors are swallowed
- **No dependencies**, works in the Node.js and the Edge runtime
- **Next.js 16** (`proxy.ts`) and **Next.js 15** (`middleware.ts`)

## Quick start

**1. Install**

```bash
npm install next-ki-score
```

**2. Set the environment variables** on your server or hosting platform. Copy
the values from **Traffic Overview → Integration** in the KI Score dashboard.

```bash
KISCORE_SITE_ID=your-site-id
KISCORE_TRACKING_SECRET=your-tracking-secret
KISCORE_CLIENT_IP_HEADER=x-real-ip   # not needed on Vercel, see "Visitor IP"
```

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

Requests your proxy redirects are not reported; the redirect target is
reported when the browser requests it.

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

KI Score counts each visitor once per day and source and needs the visitor IP
for that. For human visitors it stores only a daily hash, never the address
itself; AI crawler hits are stored with their IP. In a proxy, Next.js does not
expose the connection IP, so the package reads it from a header that **your
hosting proxy sets and overwrites** on every request:

| Hosting | `KISCORE_CLIENT_IP_HEADER` |
| --- | --- |
| Vercel | not needed, `x-real-ip` is used automatically |
| Netlify | `x-nf-client-connection-ip` |
| Cloudflare, if your server only accepts traffic from Cloudflare | `cf-connecting-ip` |
| nginx with `proxy_set_header X-Real-IP $remote_addr;` | `x-real-ip` |
| any other reverse proxy | the header it sets to the connecting client's IP |

Do not use a header that the visitor can set unchecked, or a list such as
`x-forwarded-for`. Only a single valid IPv4 or IPv6 address is accepted. If
the header is missing or invalid, the request is not reported: otherwise every
visit would be counted under your server's IP as one visitor.

## What is sent

For each page view, one `POST` request to `https://api.kiscore.ai/track/<site-id>`:

| Field | Value |
| --- | --- |
| `url` | Path plus `utm_*` parameters, e.g. `/pricing?utm_source=chatgpt.com`. Other query parameters can contain tokens or email addresses and are never sent. |
| `user_agent` | The visitor's user agent |
| `referer` | The visitor's referrer |
| `ip` | The visitor IP from the configured header |

The tracking secret travels in the `X-Kiscore-Tracking-Secret` header. The
request refuses redirects, so the secret cannot be forwarded to another host.

Not reported:

- non-`GET` requests, `/api` routes, `/_next/*` and static files (images, scripts, styles, fonts, `robots.txt`, `sitemap.xml`, …)
- client-side navigations and link prefetches (browsers mark them with `Sec-Fetch-Mode`, Next.js additionally with `rsc` and `next-router-prefetch`)
- requests your wrapped proxy redirects
- requests without a valid visitor IP

Pages served from a CDN or static export never reach your proxy and cannot be
reported by it.

## Configuration

All settings can be passed as options or set as environment variables.
Options take precedence.

```ts
export const proxy = withKiScore({
  excludePaths: ["/admin/", "/preview/"],
  debug: true,
})

// or, wrapping an existing proxy:
export const proxy = withKiScore(myProxy, { excludePaths: ["/admin/"] })
```

| Option | Environment variable | Default |
| --- | --- | --- |
| `siteId` | `KISCORE_SITE_ID` | required |
| `trackingSecret` | `KISCORE_TRACKING_SECRET` | required |
| `clientIpHeader` | `KISCORE_CLIENT_IP_HEADER` | `x-real-ip` on Vercel, otherwise required |
| `apiEndpoint` | `KISCORE_API_ENDPOINT` | `https://api.kiscore.ai/track` |
| `enabled` | `KISCORE_ENABLED` (`false` turns tracking off) | `true` |
| `debug` | `KISCORE_DEBUG` (`true` logs each report and each page view skipped for a missing IP) | `false` |
| `timeout` | | `2000` ms |
| `excludePaths` | | `[]`, added to the built-in exclusions |

If the site ID, the tracking secret or the IP header is missing, nothing is
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

- `KISCORE_SITE_ID or KISCORE_TRACKING_SECRET is missing`: the variables are not available at runtime
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
```

## License

MIT
