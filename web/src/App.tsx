import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { Header } from './components/Header';
import { ProtectedRoute } from './components/ProtectedRoute';
import { CatalogProvider } from './lib/CatalogProvider';
import { BrowsePage } from './pages/BrowsePage';
import { AdminPage } from './pages/AdminPage';
import { CollectionPage } from './pages/CollectionPage';
import { DevicePairPage } from './pages/DevicePairPage';
import { LinkDevicePage } from './pages/LinkDevicePage';
import { LoginPage } from './pages/LoginPage';
import { NoteEditPage } from './pages/NoteEditPage';
import { NotePage } from './pages/NotePage';
import { SearchPage } from './pages/SearchPage';
import { WatchPage } from './pages/WatchPage';

/** The catalog is only fetchable once the signed cookies exist, so it is mounted inside the guard. */
function AppShell() {
  return (
    <CatalogProvider>
      <Header />
      <Outlet />
    </CatalogProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* The device being signed in. No session yet, by definition. */}
        <Route path="/pair" element={<DevicePairPage />} />
        <Route element={<ProtectedRoute />}>
          {/* The approving phone. Guarded, and outside the shell: it needs an
              identity but not the catalog, and a viewer who is not signed in
              is sent to log in and returns here with the code intact. */}
          <Route path="link" element={<LinkDevicePage />} />
          <Route element={<AppShell />}>
            <Route index element={<BrowsePage />} />
            <Route path="c/:collectionId" element={<CollectionPage />} />
            {/* Kept so links made before the library became a tree still land. */}
            <Route path="genre/:collectionId" element={<CollectionPage />} />
            <Route path="admin" element={<AdminPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="watch/:titleId" element={<WatchPage />} />
            <Route path="notes/:noteId" element={<NotePage />} />
            {/* Writing a note. `/write` rather than `/notes/new`, because a note
                titled "New" would take the id `new` and then the two routes
                would be the same URL. */}
            <Route path="write" element={<NoteEditPage />} />
            <Route path="notes/:noteId/edit" element={<NoteEditPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
