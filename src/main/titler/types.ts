/** What a titling backend returns. */
export interface Generated {
  /** At most six words — the strip headline. */
  title: string
  /** One or two sentences on where the session stands, or null if unusable. */
  state: string | null
}
