import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useCatalog } from '../lib/CatalogProvider';

export function Header() {
  const { user, logout } = useAuth();
  const { roots } = useCatalog();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') ?? '');

  // Keep the box in step with the URL when the viewer navigates back or forward.
  useEffect(() => setQuery(searchParams.get('q') ?? ''), [searchParams]);

  /**
   * The bar is transparent over the billboard and only takes a background once
   * there is content scrolled behind it. Passive, because this fires often and
   * never prevents the scroll.
   */
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={scrolled ? 'header header--scrolled' : 'header'}>
      <Link className="header__brand" to="/">
        <span className="header__mark" aria-hidden="true" />
        Watcher
      </Link>

      <nav className="header__nav" aria-label="Genres">
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'is-active' : undefined)}>
          Home
        </NavLink>
        {roots.map((root) => (
          <NavLink
            key={root.id}
            to={`/c/${root.id}`}
            className={({ isActive }) => (isActive ? 'is-active' : undefined)}
          >
            {root.name}
          </NavLink>
        ))}
      </nav>

      <form
        className="header__search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(query.trim() ? `/search?q=${encodeURIComponent(query.trim())}` : '/search');
        }}
      >
        <label className="visually-hidden" htmlFor="site-search">
          Search titles
        </label>
        <input
          id="site-search"
          type="search"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </form>

      <div className="header__account">
        {user?.roles?.includes('admin') && (
          <NavLink className="header__admin" to="/admin">
            Manage
          </NavLink>
        )}
        <span className="header__user" title={user?.username}>
          {user?.name ?? user?.username}
        </span>
        <button type="button" className="button button--ghost" onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </header>
  );
}
