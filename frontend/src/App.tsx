import { lazy, Suspense, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Navbar, type NavSection } from './components/Navbar';
import { useAuth } from './context/AuthContext';
import type { GenreItem } from './types';

const HomePage = lazy(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })));
const ComicDetailPage = lazy(() =>
  import('./pages/ComicDetailPage').then((m) => ({ default: m.ComicDetailPage }))
);
const ReaderPage = lazy(() =>
  import('./pages/ReaderPage').then((m) => ({ default: m.ReaderPage }))
);
const AuthModal = lazy(() =>
  import('./components/AuthModal').then((m) => ({ default: m.AuthModal }))
);
const SettingsModal = lazy(() =>
  import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal }))
);
const UploadModal = lazy(() =>
  import('./components/UploadModal').then((m) => ({ default: m.UploadModal }))
);

function RouteLoadingFallback() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center bg-[#0D0F12] text-text-secondary">
      <div className="flex items-center gap-2.5 text-sm">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <span>Đang tải trang...</span>
      </div>
    </div>
  );
}

export default function App() {
  const location = useLocation();
  const { authModalOpen, settingsModalOpen, uploadModalOpen } = useAuth();
  const isReaderRoute = location.pathname.startsWith('/read/');
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [activeSection, setActiveSection] = useState<NavSection>('hinettruyen');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGenre, setSelectedGenre] = useState<GenreItem | null>(null);

  const handleQuickSearch = (keyword: string) => {
    setSelectedGenre(null);
    setSearchQuery(keyword);
    if (activeSection === 'favorites' || activeSection === 'history') {
      setActiveSection('hinettruyen');
    }
  };

  const handleSelectGenre = (genre: GenreItem | null) => {
    setSearchQuery('');
    setSelectedGenre(genre);
    setActiveSection('hinettruyen');
  };

  return (
    <div className="min-h-screen bg-surface-bg text-on-surface">
      {!isReaderRoute && (
        <Navbar
          activeSection={activeSection}
          onSelectSection={(sec) => {
            setSelectedGenre(null);
            setActiveSection(sec);
          }}
          onSelectGenre={handleSelectGenre}
          onQuickSearch={handleQuickSearch}
        />
      )}

      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          <Route
            path="/"
            element={
              <HomePage
                activeSection={activeSection}
                onSelectSection={setActiveSection}
                selectedGenre={selectedGenre}
                onSelectGenre={handleSelectGenre}
                searchQuery={searchQuery}
                onSearchQuery={setSearchQuery}
                refreshSignal={refreshSignal}
              />
            }
          />
          <Route
            path="/comic/:sourceType/:comicId"
            element={<ComicDetailPage refreshSignal={refreshSignal} />}
          />
          <Route path="/read/:sourceType/:comicId/:chapterId" element={<ReaderPage />} />
        </Routes>
      </Suspense>

      <Suspense fallback={null}>
        {authModalOpen && <AuthModal />}
        {settingsModalOpen && <SettingsModal />}
        {uploadModalOpen && (
          <UploadModal
            onUploaded={() => {
              setRefreshSignal((n) => n + 1);
              setActiveSection('local');
            }}
          />
        )}
      </Suspense>
    </div>
  );
}
