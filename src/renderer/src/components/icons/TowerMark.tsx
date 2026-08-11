/**
 * The app mark, in the bar.
 *
 * The same geometry as `resources/icon.svg`, minus that file's 88% Dock inset —
 * here it should fill its box, because it sits beside the wordmark rather than beside
 * other app icons.
 *
 * Full-colour, and unlike the radar that is defensible: this is the product's
 * identity, not a status. Nothing about the blue encodes anything, so there is
 * nothing to misread in a palette that renders it unchanged. It is the same
 * reasoning that makes the radar's colour *wrong* — that one sits on a control.
 *
 * Kept as its own component rather than an <img> of the icon file so it inherits
 * crisp vector rendering at any size and needs no asset loading in the renderer.
 */
export function TowerMark({
  size = 18,
  className,
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Control Tower"
    >
      <defs>
        {/* One seam down the centre, applied to every part — see resources/icon.svg */}
        <clipPath id="towerShade">
          <rect x="128" y="0" width="128" height="256" />
        </clipPath>
      </defs>

      <g>
        <rect x="50" y="228" width="156" height="18" fill="#A9B5BF" />
        <g clipPath="url(#towerShade)">
          <rect x="50" y="228" width="156" height="18" fill="#7D8B99" />
        </g>
      </g>

      <g>
        <rect x="112" y="144" width="32" height="86" fill="#A9B5BF" />
        <g clipPath="url(#towerShade)">
          <rect x="112" y="144" width="32" height="86" fill="#7D8B99" />
        </g>
      </g>

      <g>
        <polygon points="16,40 240,40 196,150 60,150" fill="#29ABE5" />
        <g clipPath="url(#towerShade)">
          <polygon points="16,40 240,40 196,150 60,150" fill="#0080C8" />
        </g>
      </g>

      <g>
        <polygon points="38.4,96 217.6,96 212.8,108 43.2,108" fill="#D3DAE1" />
        <g clipPath="url(#towerShade)">
          <polygon points="38.4,96 217.6,96 212.8,108 43.2,108" fill="#B4BFC9" />
        </g>
      </g>

      <g>
        <polygon points="76,14 180,14 240,40 16,40" fill="#E3E8ED" />
        <g clipPath="url(#towerShade)">
          <polygon points="76,14 180,14 240,40 16,40" fill="#C3CCD5" />
        </g>
      </g>
    </svg>
  )
}
