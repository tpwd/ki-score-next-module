# Changelog

## 1.0.0

- Server-side Next.js proxy and middleware integration through `withKiScore`.
- Dashboard connection key, or separate site ID and tracking secret.
- Authenticated background delivery with `waitUntil`, a two-second timeout and no redirects.
- Existing proxy responses and errors are preserved. Redirects, rejected requests,
  explicit non-HTML responses, assets, API routes and prefetches are excluded.
- Only a configured, trusted visitor IP header is accepted. URL query parameters
  are limited to `utm_*`; tracking credentials remain on the server.
- ESM, CommonJS and TypeScript declarations in the downloadable package.
