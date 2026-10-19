import { test, expect } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../..", import.meta.url))

test("the release archive installs with npm and loads in Node as ESM and CommonJS", () => {
  const consumer = mkdtempSync(join(tmpdir(), "next-ki-score-consumer-"))
  try {
    const metadata = JSON.parse(
      execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", consumer, "--json"], {
        cwd: root,
        encoding: "utf8",
      }),
    )
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }))
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
        join(consumer, metadata[0].filename),
      ],
      { cwd: consumer, stdio: "pipe" },
    )

    const installed = join(consumer, "node_modules/next-ki-score")
    expect(readFileSync(join(installed, "LICENSE"), "utf8")).toContain("MIT License")
    writeFileSync(
      join(consumer, "verify.mjs"),
      `
      import assert from "node:assert/strict"
      import { createRequire } from "node:module"
      import { withKiScore, trackKiScore } from "next-ki-score"
      const commonjs = createRequire(import.meta.url)("next-ki-score")
      assert.equal(typeof commonjs.trackKiScore, "function")
      assert.equal(typeof trackKiScore, "function")
      const event = { waitUntil() { throw new Error("disabled tracking must not send") } }
      const request = new Request("https://example.test/")
      assert.equal(await withKiScore({ enabled: false })(request, event), undefined)
      assert.equal(await commonjs.withKiScore({ enabled: false })(request, event), undefined)
    `,
    )
    expect(() => execFileSync("node", ["verify.mjs"], { cwd: consumer, stdio: "pipe" })).not.toThrow()
  } finally {
    rmSync(consumer, { recursive: true, force: true })
  }
}, 30_000)
