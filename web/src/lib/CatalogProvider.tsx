import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { fetchCatalog } from './api';
import type { Catalog, Genre, Title } from './types';

interface CatalogContextValue {
  catalog: Catalog | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  byId: (id: string) => Title | undefined;
  genreById: (id: string) => Genre | undefined;
  titlesInGenre: (genreId: string) => Title[];
  search: (query: string) => Title[];
  featured: Title | null;
}

const CatalogContext = createContext<CatalogContextValue | null>(null);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchCatalog()
      .then((next) => {
        if (!cancelled) setCatalog(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load the catalog');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const value = useMemo<CatalogContextValue>(() => {
    const titles = catalog?.titles ?? [];
    const titleIndex = new Map(titles.map((title) => [title.id, title]));
    const genreIndex = new Map((catalog?.genres ?? []).map((genre) => [genre.id, genre]));

    return {
      catalog,
      loading,
      error,
      reload,
      byId: (id) => titleIndex.get(id),
      genreById: (id) => genreIndex.get(id),
      titlesInGenre: (genreId) => titles.filter((title) => title.genreIds.includes(genreId)),
      search: (query) => {
        const needle = query.trim().toLowerCase();
        if (!needle) return [];
        return titles.filter((title) =>
          [title.title, title.description, title.instructor ?? '', ...(title.tags ?? [])]
            .join(' ')
            .toLowerCase()
            .includes(needle),
        );
      },
      featured: titles.find((title) => title.featured) ?? titles[0] ?? null,
    };
  }, [catalog, loading, error, reload]);

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogContextValue {
  const context = useContext(CatalogContext);
  if (!context) throw new Error('useCatalog must be used inside <CatalogProvider>');
  return context;
}
