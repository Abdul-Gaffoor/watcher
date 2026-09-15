import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useCatalog } from '../lib/CatalogProvider';

export function Header() {
  const { user, logout } = useAuth();
  const { catalog } = useCatalog();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') ?? '');

  // Keep the box in step with the URL when the viewer navigates back or forward.
  useEffect(() => setQuery(searchParams.get('q') ?? ''), [searchParams]);

  return (
    <header className="header">
      <Link className="header__brand" to="/">
        <span className="header__mark" aria-hidden="true" />
        Watcher
      </Link>

      <nav className="header__nav" aria-label="Genres">
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'is-active' : undefined)}>
          Home
        </NavLink>
        {(catalog?.genres ?? []).map((genre) => (
          <NavLink
            key={genre.id}
            to={`/genre/${genre.id}`}
            className={({ isActive }) => (isActive ? 'is-active' : undefined)}
          >
            {genre.name}
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
