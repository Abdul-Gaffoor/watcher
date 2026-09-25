import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { Header } from './components/Header';
import { ProtectedRoute } from './components/ProtectedRoute';
import { CatalogProvider } from './lib/CatalogProvider';
import { BrowsePage } from './pages/BrowsePage';
import { AdminPage } from './pages/AdminPage';
import { CollectionPage } from './pages/CollectionPage';
import { LoginPage } from './pages/LoginPage';
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
        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route index element={<BrowsePage />} />
            <Route path="c/:collectionId" element={<CollectionPage />} />
            {/* Kept so links made before the library became a tree still land. */}
            <Route path="genre/:collectionId" element={<CollectionPage />} />
            <Route path="admin" element={<AdminPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="watch/:titleId" element={<WatchPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
