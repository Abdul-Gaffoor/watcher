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
import { searchCatalog, type SearchResults } from './search';
import type { Catalog, Collection, Note, Title } from './types';

interface CatalogContextValue {
  catalog: Catalog | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  byId: (id: string) => Title | undefined;
  noteById: (id: string) => Note | undefined;
  /** Notes filed directly in this collection, in catalog order. */
  notesIn: (collectionId: string) => Note[];
  collectionById: (id: string) => Collection | undefined;
  /** Top-level shelves, in declared order. These are the nav. */
  roots: Collection[];
  childrenOf: (collectionId: string | null) => Collection[];
  /** Only the titles filed directly here, not in its descendants. */
  titlesDirectlyIn: (collectionId: string) => Title[];
  /** Everything below this point, which is what a shelf actually shows. */
  titlesBeneath: (collectionId: string) => Title[];
  /** Root-first ancestry, for breadcrumbs. */
  pathTo: (collectionId: string) => Collection[];
  /** Collections as well as titles: a course name is what people search for. */
  search: (query: string) => SearchResults;
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
    const collections = catalog?.collections ?? [];
    const notes = catalog?.notes ?? [];
    const titleIndex = new Map(titles.map((title) => [title.id, title]));
    const collectionIndex = new Map(collections.map((collection) => [collection.id, collection]));

    // Built once per catalog rather than filtered per call, because a shelf
    // page asks for children and descendants repeatedly while rendering.
    const childIndex = new Map<string | null, Collection[]>();
    for (const collection of collections) {
      const parentId = collection.parentId ?? null;
      const siblings = childIndex.get(parentId) ?? [];
      siblings.push(collection);
      childIndex.set(parentId, siblings);
    }

    const titlesByCollection = new Map<string, Title[]>();
    for (const title of titles) {
      const bucket = titlesByCollection.get(title.collectionId) ?? [];
      bucket.push(title);
      titlesByCollection.set(title.collectionId, bucket);
    }

    const childrenOf = (collectionId: string | null) => childIndex.get(collectionId) ?? [];

    const titlesBeneath = (collectionId: string): Title[] => {
      const found: Title[] = [];
      // Iterative, so a catalog that somehow contained a cycle would not take
      // the whole page down with it.
      const seen = new Set<string>();
      const stack = [collectionId];
      while (stack.length > 0) {
        const current = stack.pop() as string;
        if (seen.has(current)) continue;
        seen.add(current);
        found.push(...(titlesByCollection.get(current) ?? []));
        for (const child of childrenOf(current)) stack.push(child.id);
      }
      return found;
    };

    const pathTo = (collectionId: string): Collection[] => {
      const trail: Collection[] = [];
      const seen = new Set<string>();
      let current: string | null = collectionId;
      while (current !== null && !seen.has(current)) {
        seen.add(current);
        const collection = collectionIndex.get(current);
        if (!collection) break;
        trail.unshift(collection);
        current = collection.parentId ?? null;
      }
      return trail;
    };

    return {
      catalog,
      loading,
      error,
      reload,
      byId: (id) => titleIndex.get(id),
      collectionById: (id) => collectionIndex.get(id),
      roots: childrenOf(null),
      childrenOf,
      titlesDirectlyIn: (collectionId) => titlesByCollection.get(collectionId) ?? [],
      noteById: (id) => notes.find((note) => note.id === id),
      notesIn: (collectionId) => notes.filter((note) => note.collectionId === collectionId),
      titlesBeneath,
      pathTo,
      search: (query) => searchCatalog(query, titles, collections, notes, pathTo),
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
