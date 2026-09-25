/**
 * Artwork for a title that has none.
 *
 * Every upload from now on carries a frame grabbed from the video itself, but
 * anything uploaded before that existed has nothing, and a browser that cannot
 * decode a given codec will still produce nothing. The old fallback was the
 * title's first letter on a flat panel, which made a library of "Class - 1",
 * "Class - 2" into a wall of identical purple Cs — the shelf could not be read
 * at a glance, which is the only thing a shelf is for.
 *
 * So: derived from the id, so a title keeps the same artwork forever and two
 * titles rarely collide, and carrying the actual name, so the tile is legible
 * without reading the caption underneath.
 */

/** FNV-1a. Small, stable, and spreads adjacent ids like "class-1" and "class-2". */
function hashOf(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Wrapped by width rather than by word count, so a long word does not push a
 * line off the tile. Three lines at most; the caption underneath carries the
 * rest.
 */
function wrap(text: string, perLine: number): string[] {
  const lines: string[] = [];
  let line = '';

  for (const word of text.split(/\s+/)) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= perLine) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
    if (lines.length === 3) break;
  }
  if (line && lines.length < 3) lines.push(line);

  const last = lines.length - 1;
  if (lines[last] && lines.join(' ').length < text.length) lines[last] = `${lines[last]}…`;
  return lines;
}

interface Props {
  /** The id, not the name: artwork must not change when a title is renamed. */
  seed: string;
  label: string;
  /**
   * tile     carries the name, for a shelf where nothing else does
   * plain    the same artwork without it, for a list that prints the name beside
   * backdrop behind a billboard, where the page's own headline is the name
   */
  variant?: 'tile' | 'plain' | 'backdrop';
}

export function GeneratedArt({ seed, label, variant = 'tile' }: Props) {
  const hash = hashOf(seed);

  // Nearly the whole wheel, offset past the reds, which read as an error.
  // A narrow band was the original mistake: every tile came out the same
  // magenta, which is the wall of identical panels this exists to avoid.
  const hue = 25 + (hash % 305);
  const hueB = (hue + 38) % 360;
  const angle = 20 + ((hash >> 8) % 50);

  const id = `art-${seed.replace(/[^a-z0-9]/gi, '')}-${variant}`;
  const lines = variant === 'tile' ? wrap(label, 14) : [];

  return (
    <svg
      className={`genart genart--${variant}`}
      viewBox="0 0 320 180"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={`${id}-g`} gradientTransform={`rotate(${angle} 0.5 0.5)`}>
          <stop offset="0%" stopColor={`hsl(${hue} 46% 26%)`} />
          <stop offset="100%" stopColor={`hsl(${hueB} 52% 14%)`} />
        </linearGradient>
        <radialGradient id={`${id}-r`} cx="78%" cy="18%" r="72%">
          <stop offset="0%" stopColor={`hsl(${hue} 70% 62%)`} stopOpacity="0.38" />
          <stop offset="100%" stopColor={`hsl(${hue} 70% 62%)`} stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width="320" height="180" fill={`url(#${id}-g)`} />
      <rect width="320" height="180" fill={`url(#${id}-r)`} />

      {/* Concentric arcs, offset by the hash. Enough structure that a tile has
          a shape to recognise, faint enough not to fight the name on top. */}
      <g fill="none" stroke="#fff" strokeOpacity="0.09" strokeWidth="1.2">
        {[0, 1, 2, 3, 4].map((ring) => (
          <circle key={ring} cx={248 + (hash % 40)} cy={40 + ((hash >> 4) % 30)} r={26 + ring * 26} />
        ))}
      </g>

      {lines.length > 0 && (
        <>
          {/* A floor under the text, so the name stays readable wherever the
              gradient happens to land light. */}
          <rect y="96" width="320" height="84" fill="#05060c" opacity="0.34" />
          <text
            x="18"
            y={lines.length === 1 ? 148 : lines.length === 2 ? 133 : 118}
            fill="#fff"
            fontSize="23"
            fontWeight="700"
            letterSpacing="-0.4"
          >
            {lines.map((line, index) => (
              <tspan key={line} x="18" dy={index === 0 ? 0 : 27}>
                {line}
              </tspan>
            ))}
          </text>
        </>
      )}
    </svg>
  );
}
