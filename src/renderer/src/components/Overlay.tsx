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
      className="bg-bg/80 absolute inset-0 z-20 overflow-y-auto backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface border-border-strong m-3 rounded-lg border p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="field text-[11px] font-semibold tracking-widest">{title}</h2>
            <p className="text-text-subtle mt-1 text-[11px]">{subtitle}</p>
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

export function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="field text-text-subtle mb-2 text-[10px] font-semibold tracking-widest">
        {title}
      </h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}

/** A labelled row: fixed-width left column, explanation on the right. */
export function Row({ left, right }: { left: React.ReactNode; right: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <span className="flex w-[7.5rem] shrink-0 justify-start">{left}</span>
      <span className="text-text-muted min-w-0 flex-1 text-[11px] leading-snug">{right}</span>
    </div>
  )
}
