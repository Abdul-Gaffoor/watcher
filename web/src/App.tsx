import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { Header } from './components/Header';
import { ProtectedRoute } from './components/ProtectedRoute';
import { CatalogProvider } from './lib/CatalogProvider';
import { BrowsePage } from './pages/BrowsePage';
import { GenrePage } from './pages/GenrePage';
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
            <Route path="genre/:genreId" element={<GenrePage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="watch/:titleId" element={<WatchPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
