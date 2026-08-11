import { X } from 'lucide-react'

/**
 * The shell both full-surface panels are drawn in.
 *
 * Extracted when preferences arrived and immediately started re-implementing the
 * key's backdrop, dismissal and header. Two copies of a dismissal rule is how you
 * end up with one panel you can click away and one you cannot.
 *
 * Dismissal is deliberately generous — backdrop click, the X, and Escape (owned by
 * App, so it works before the panel has focus). An overlay that traps you is worse
 * than no overlay.
 */
export function Overlay({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string
  subtitle: string
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      /*
       * A modal scrim over the boards, starting below the title bar.
       *
       * Two things come out of stopping at `top-titlebar` rather than covering the
       * window. The traffic lights stop being a problem by construction: macOS
       * composites them above the web view, so they stay sharp and on top of anything
       * drawn underneath, and the panel used to run directly beneath them at its old
       * 12px margin. And the header stays crisp and live, so KEY and PREFS still toggle
       * and the mark still reads — the chrome is what tells you the window is still
       * there with a panel over it, which a blurred header would not.
       *
       * The scrim is also translucent for the first time. It carried `bg-bg/80` since
       * it was written, which never applied any alpha at all — an opacity modifier on an
       * `@theme inline` colour whose value is a bare `var()` is silently dropped, so it
       * compiled to a fully opaque background. That is why its `backdrop-blur` appeared
       * to do nothing: there was never anything showing through to blur. The alpha lives
       * in `--ct-scrim` now, per palette, which is the form that survives.
       */
      className="bg-scrim top-titlebar absolute inset-x-0 bottom-0 z-20 overflow-y-auto p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        /*
         * Inset on every side, so the blurred boards frame the panel instead of it
         * running to the window edges, and capped in width.
         *
         * The cap is about the line length, not the look. These panels are mostly
         * definitions — a term and a sentence explaining it — and at a 1512px window
         * the sentences ran past 150 characters, which is roughly twice what anyone
         * reads comfortably and the main reason the key felt dense rather than long.
         * `mx-auto` centres it once the window is wider than the cap.
         *
         * The inset is the scrim's padding rather than a margin here: a margin plus
         * `mx-auto` cancel each other, so the panel would have touched both edges on any
         * window narrower than the cap — exactly the case the inset is for.
         */
        className="bg-surface border-border-strong mx-auto max-w-[44rem] rounded-lg border p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="field text-prose font-semibold tracking-widest">{title}</h2>
            <p className="text-text-subtle mt-1 text-ui leading-relaxed">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="hover:bg-surface-raised text-text-muted hover:text-text -mt-1 rounded p-1.5"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * A titled group of rows.
 *
 * The heading sits on a rule that runs the width of the panel, which is what separates
 * one group from the next at a glance. Before, four sections of definitions ran
 * together as one column of evenly spaced lines — nothing marked where PULL REQUEST
 * STATUS ended and BOARDS began except a slightly bolder line of text.
 */
export function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mt-6 first:mt-0">
      <h3 className="field text-text-muted border-border-strong mb-1 border-b pb-1.5 text-footnote font-semibold tracking-widest">
        {title}
      </h3>
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

/**
 * A sub-heading inside a section, for grouping rows that belong together.
 *
 * Thirteen pull-request statuses in one flat list is an alphabet to be read rather
 * than a vocabulary to be scanned. Grouped into the phases a PR actually passes
 * through, the same thirteen become five short lists.
 */
export function Subhead({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-text-subtle mt-4 mb-1 text-footnote">{children}</p>
}

/**
 * A labelled row: fixed-width term column, explanation on the right.
 *
 * The hairline is what gives a long list rhythm — it lets the eye track across from a
 * chip to its meaning without counting lines, and it makes a wrapped two-line
 * definition obviously one entry rather than two. Suppressed on the first row of a
 * group, where the section rule or subhead is already the boundary.
 *
 * The term column is 10.5rem because the widest chip needs it. At 8.5rem the longest
 * labels had nowhere to go and broke across two lines inside the chip — NEEDS
 * RE-REVIEW measures about 158px with its icon and padding, against the 136px it was
 * given. Nothing on a strip ever wraps, so a key that wraps is showing you something
 * the app does not have.
 */
export function Row({ left, right }: { left: React.ReactNode; right: string }): React.JSX.Element {
  return (
    <div className="border-scope-line flex items-start gap-4 border-t py-2 first:border-t-0">
      <span className="flex w-[10.5rem] shrink-0 justify-start pt-px">{left}</span>
      <span className="text-text-muted min-w-0 flex-1 text-ui leading-relaxed">{right}</span>
    </div>
  )
}
