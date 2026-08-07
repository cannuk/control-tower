/**
 * Elapsed-time readout for a flight strip: "NOW", "3M", "2H", "4D".
 *
 * Deliberately terse and uppercase. This field sits at a fixed narrow width at
 * the right edge of every strip so the column lines up down the list; "about 3
 * minutes ago" would either wrap or push the flight description into truncation.
 * The absolute timestamp lives in the strip's tooltip instead.
 */
export function elapsed(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000))
  if (seconds < 45) return 'NOW'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}M`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}H`
  return `${Math.round(hours / 24)}D`
}

export function absoluteTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  })
}
