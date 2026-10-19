import { NextResponse } from "next/server"
import type { NextFetchEvent, NextMiddleware as NextProxy, NextRequest } from "next/server"
import { trackKiScore, withKiScore } from "next-ki-score"

// Type-checked by `next build` against the real Next.js types, never executed.

export const wrapped: NextProxy = withKiScore(
  (request: NextRequest) => {
    if (request.nextUrl.pathname === "/old") return NextResponse.redirect(new URL("/", request.url))
    return NextResponse.next()
  },
  { excludePaths: ["/admin/"] },
)

export const wrappedWithEvent: NextProxy = withKiScore(async (_request: NextRequest, event: NextFetchEvent) => {
  event.waitUntil(Promise.resolve())
})

export function manual(request: NextRequest, event: NextFetchEvent) {
  void trackKiScore(request, event)
  return NextResponse.next()
}
