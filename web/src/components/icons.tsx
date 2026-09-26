/**
 * The rail is icons, so the icons have to carry meaning on their own. Drawn
 * inline rather than pulled from a set: there are six of them, and a font or a
 * package would cost more than the markup it replaces.
 *
 * Every one is a 24-box stroked path, so they share a weight and line join and
 * read as one family at rail size.
 */

interface IconProps {
  className?: string;
}

function Svg({ children, className }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.8V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.8" />
    </Svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m10.5 9.5 4.5 2.5-4.5 2.5z" />
    </Svg>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </Svg>
  );
}

export function GridIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
    </Svg>
  );
}

export function TicketIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8.5V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2.5a2.2 2.2 0 0 0 0 7V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2.5a2.2 2.2 0 0 0 0-7Z" />
      <path d="M12 8v1.5M12 14.5V16" />
    </Svg>
  );
}

/**
 * The library's top level is whatever the owner made it, so no icon can be
 * right by meaning. These are told apart by shape instead: adjacent roots get
 * different ones, and the name underneath is what actually says which is which.
 */
export const COLLECTION_ICONS = [LayersIcon, PlayIcon, GridIcon, TicketIcon];

export function BookmarkIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...props}>
      <path d="M6 4h12v17l-6-4-6 4V4Z" fill={filled ? 'currentColor' : 'none'} />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </Svg>
  );
}

/**
 * Uploading is what the dashboard is mostly for, and an upload arrow reads
 * instantly at rail size. A gear at 20px is a circle with specks round it, and
 * was being mistaken for a brightness control.
 */
export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 16V4" />
      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </Svg>
  );
}

export function SignOutIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3" />
      <path d="M10 8 6 12l4 4M6 12h9" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Svg>
  );
}
