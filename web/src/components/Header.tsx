import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useCatalog } from '../lib/CatalogProvider';
import { COLLECTION_ICONS, HomeIcon, SearchIcon, SettingsIcon, SignOutIcon, SlidersIcon } from './icons';

/**
 * A rail rather than a bar, and a search that floats over the artwork.
 *
 * The rail is icons, so every destination also carries a visually hidden label:
 * it is what a screen reader announces, what the tooltip repeats, and what
 * keeps the destinations findable by name rather than by shape.
 */
export function Header() {
  const { user, logout } = useAuth();
  const { roots } = useCatalog();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') ?? '');

  // Keep the box in step with the URL when the viewer navigates back or forward.
  useEffect(() => setQuery(searchParams.get('q') ?? ''), [searchParams]);

  const railItem = ({ isActive }: { isActive: boolean }) =>
    isActive ? 'rail__item is-active' : 'rail__item';

  return (
    <>
      <aside className="rail">
        {/* The product's name, in the display face. Four anonymous squares
            said nothing; a library ought to be willing to sign itself. */}
        <Link className="rail__mark" to="/" aria-label="Watcher home">
          <span aria-hidden="true">W</span>
        </Link>

        <nav className="header__nav rail__nav" aria-label="Library">
          <NavLink to="/" end className={railItem} title="Home">
            <HomeIcon />
            <span className="visually-hidden">Home</span>
          </NavLink>

          {roots.map((root, index) => {
            const CollectionIcon = COLLECTION_ICONS[index % COLLECTION_ICONS.length];
            return (
              <NavLink key={root.id} to={`/c/${root.id}`} className={railItem} title={root.name}>
                <CollectionIcon />
                <span className="visually-hidden">{root.name}</span>
              </NavLink>
            );
          })}

          {user?.roles?.includes('admin') && (
            <NavLink to="/admin" className={`${railItem({ isActive: false })} header__admin`} title="Manage library">
              <SettingsIcon />
              <span className="visually-hidden">Manage library</span>
            </NavLink>
          )}
        </nav>

        <button
          type="button"
          className="rail__item rail__item--quiet"
          onClick={() => void logout()}
          title={`Sign out${user?.name ? ` (${user.name})` : ''}`}
        >
          <SignOutIcon />
          <span className="visually-hidden">Sign out</span>
        </button>
      </aside>

      {/* Content scrolls under the floating search, so it fades out rather
          than sliding under an unexplained pill. */}
      <div className="top-scrim" aria-hidden="true" />

      {/* Floating rather than docked, so the artwork runs to the top of the
          window and the search sits on it like a control, not a chrome bar. */}
      <form
        className="searchbar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(query.trim() ? `/search?q=${encodeURIComponent(query.trim())}` : '/search');
        }}
      >
        <span className="searchbar__icon" aria-hidden="true">
          <SearchIcon />
        </span>
        <label className="visually-hidden" htmlFor="site-search">
          Search titles
        </label>
        <input
          id="site-search"
          type="search"
          placeholder="Search for a title"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="searchbar__submit" type="submit" title="Search">
          <SlidersIcon />
          <span className="visually-hidden">Search</span>
        </button>
      </form>
    </>
  );
}
