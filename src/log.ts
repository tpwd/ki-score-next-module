const PREFIX = "[next-ki-score]"
const warned = new Set<string>()

/** Warns once per process, so a missing setting does not flood the server log. */
export function warnOnce(message: string): void {
  if (warned.has(message)) return
  warned.add(message)
  console.warn(`${PREFIX} ${message}`)
}

export function debug(enabled: boolean, message: string, details?: unknown): void {
  if (!enabled) return
  if (details === undefined) console.debug(`${PREFIX} ${message}`)
  else console.debug(`${PREFIX} ${message}`, details)
}

/** Test hook: forget which warnings were already printed. */
export function resetWarnings(): void {
  warned.clear()
}
