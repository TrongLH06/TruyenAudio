import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ComicCard } from '../components/ComicCard';
import type { NavSection } from '../components/Navbar';
import { useAuth } from '../context/AuthContext';
import { api, ApiError, peekCachedGet, resolveBackendUrl } from '../lib/api';
import { loadLocalHistory } from '../lib/localPrefs';
import { getMobileImageUrl } from '../lib/mobileImage';
import type { ComicSummary, FavoriteItem, GenreItem, HiNetHomeResponse, HistoryItem } from '../types';

const FALLBACK_GENRES: GenreItem[] = [
  { name: 'Action', slug: 'action-95' },
  { name: 'Chuyển Sinh', slug: 'chuyen-sinh-2130' },
  { name: 'Cổ Đại', slug: 'co-dai-207' },
  { name: 'Fantasy', slug: 'fantasy-105' },
  { name: 'Drama', slug: 'drama-103' },
  { name: 'Comedy', slug: 'comedy-99' },
  { name: 'Adventure', slug: 'adventure' },
  { name: 'Đam Mỹ', slug: 'dam-my' },
];

interface HomePageProps {
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  selectedGenre: GenreItem | null;
  onSelectGenre: (genre: GenreItem | null) => void;
  searchQuery: string;
  onSearchQuery: (q: string) => void;
  refreshSignal: number;
}

export function HomePage({
  activeSection,
  onSelectSection,
  selectedGenre,
  onSelectGenre,
  searchQuery,
  onSearchQuery,
  refreshSignal,
}: HomePageProps) {
  const { user, openAuthModal, openSettingsModal, openUploadModal } = useAuth();

  const [mobileSearch, setMobileSearch] = useState(searchQuery);
  const [page, setPage] = useState(1);
  const [showAnnouncement, setShowAnnouncement] = useState(true);
  const [rankTab, setRankTab] = useState<'month' | 'week' | 'day'>('month');

  const initialHomeCache = peekCachedGet<HiNetHomeResponse>('/api/comics/hinettruyen/home');
  const [hinetHome, setHinetHome] = useState<HiNetHomeResponse | null>(initialHomeCache);
  const [feedComics, setFeedComics] = useState<ComicSummary[]>(initialHomeCache?.latest || []);
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>(() => loadLocalHistory());

  const [loadingFeed, setLoadingFeed] = useState(!initialHomeCache?.latest?.length);
  const [error, setError] = useState('');

  const featuredScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMobileSearch(searchQuery);
    setPage(1);
  }, [searchQuery, selectedGenre, activeSection]);

  // Load HiNetTruyen home bundle (featured, rankings, genres) + user sidebar
  useEffect(() => {
    const loadBase = async () => {
      try {
        const homeData = await api.getHiNetHome().catch(() => null);
        if (homeData) {
          setHinetHome(homeData);
        }
      } catch {
        // handled by feed loader
      }

      if (user) {
        try {
          const [favs, hist] = await Promise.all([api.listFavorites(), api.listHistory()]);
          setFavorites(favs);
          setHistory(hist.length > 0 ? hist : loadLocalHistory());
        } catch {
          setHistory(loadLocalHistory());
        }
      } else {
        setFavorites([]);
        setHistory(loadLocalHistory());
      }
    };
    void loadBase();
  }, [user, refreshSignal]);

  // Load primary feed whenever section, search, genre, or page changes
  const loadFeed = useCallback(async () => {
    setError('');
    const usingHomeLatest =
      activeSection === 'hinettruyen' && !searchQuery && !selectedGenre && page === 1;
    if (!(usingHomeLatest && hinetHome?.latest.length)) {
      setLoadingFeed(true);
    }
    try {
      if (activeSection === 'hinettruyen') {
        if (usingHomeLatest) {
          const home = hinetHome || (await api.getHiNetHome());
          if (!hinetHome) setHinetHome(home);
          setFeedComics(home.latest);
        } else {
          const list = await api.browseExternalComics(
            'hinettruyen',
            searchQuery,
            selectedGenre?.slug || '',
            page
          );
          setFeedComics(list);
        }
      } else if (activeSection === 'mangadex') {
        const list = await api.browseExternalComics(
          'mangadex',
          searchQuery,
          selectedGenre?.slug || '',
          page
        );
        setFeedComics(list);
      } else if (activeSection === 'local') {
        const list = await api.listLocalComics(searchQuery);
        setFeedComics(list);
      } else if (activeSection === 'favorites' || activeSection === 'history') {
        if (user) {
          const [favs, hist] = await Promise.all([api.listFavorites(), api.listHistory()]);
          setFavorites(favs);
          setHistory(hist);
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Không thể tải danh sách truyện.');
      setFeedComics([]);
    } finally {
      setLoadingFeed(false);
    }
  }, [activeSection, searchQuery, selectedGenre, page, hinetHome, user, refreshSignal]);

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);

  const featuredList: ComicSummary[] = hinetHome?.featured || [];

  const rankingList: ComicSummary[] =
    rankTab === 'month'
      ? hinetHome?.top_month || []
      : rankTab === 'week'
        ? hinetHome?.top_week || []
        : hinetHome?.top_day || [];

  const genreList = hinetHome?.genres?.length ? hinetHome.genres : FALLBACK_GENRES;

  const sectionHeading: Record<NavSection, { title: string; subtitle: string }> = {
    hinettruyen: {
      title: searchQuery
        ? `Tìm trên HiNetTruyen: "${searchQuery}"`
        : selectedGenre
          ? `Thể loại: ${selectedGenre.name}`
          : 'HiNetTruyen - Truyện Mới Cập Nhật',
      subtitle: 'Kho truyện tiếng Việt đầy đủ chương mới, hỗ trợ AI thuyết minh & tự lướt',
    },
    mangadex: {
      title: searchQuery ? `MangaDex: "${searchQuery}"` : 'Truyện Hot Quốc Tế (AI Tự Dịch)',
      subtitle: 'AI Gemini tự động dịch Anh/Nhật/Hàn sang lời thuyết minh tiếng Việt',
    },
    local: {
      title: 'Kho Truyện Của Bạn',
      subtitle: 'Tải lên ảnh, ZIP, CBZ hoặc PDF từ máy để nghe thuyết minh mọi lúc',
    },
    favorites: {
      title: 'Truyện Đang Theo Dõi',
      subtitle: 'Danh sách các bộ truyện yêu thích được đồng bộ theo tài khoản',
    },
    history: {
      title: 'Lịch Sử Đang Nghe Dở',
      subtitle: 'Bấm để tiếp tục đúng chương và trang bạn dừng lại lần trước',
    },
  };

  const handleMobileSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSelectGenre(null);
    setPage(1);
    onSearchQuery(mobileSearch.trim());
    if (activeSection === 'favorites' || activeSection === 'history') {
      onSelectSection('hinettruyen');
    }
  };

  const handleSelectGenre = (g: GenreItem | null) => {
    setPage(1);
    onSelectGenre(g);
  };

  return (
    <div className="min-h-screen bg-surface-bg pb-[calc(5.5rem+env(safe-area-inset-bottom,0px))] pt-[calc(4rem+env(safe-area-inset-top,0px))] md:pb-8 md:pt-28">
      {/* Mobile Search Bar + Quick Category Chips */}
      <section className="flex flex-col gap-2.5 px-4 pb-1 pt-3 md:hidden">
        <form onSubmit={handleMobileSearchSubmit} className="relative w-full">
          <div className="flex h-11 w-full items-center rounded-xl bg-surface-container px-3.5 text-on-surface shadow-sm focus-within:ring-1 focus-within:ring-primary-container">
            <span className="material-symbols-outlined mr-2 shrink-0 text-[20px] text-text-secondary">
              search
            </span>
            <input
              type="text"
              value={mobileSearch}
              onChange={(e) => setMobileSearch(e.target.value)}
              placeholder="Tìm truyện trên HiNetTruyen..."
              className="w-full bg-transparent text-[16px] text-text-primary placeholder:text-outline focus:outline-none sm:text-[14px]"
            />
            {mobileSearch && (
              <button
                type="button"
                onClick={() => {
                  setMobileSearch('');
                  onSearchQuery('');
                }}
                className="p-1 text-outline"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            )}
          </div>
        </form>

        <div className="no-scrollbar -mx-4 flex items-center gap-2 overflow-x-auto px-4 py-0.5">
          {[
            { key: 'hinettruyen' as const, label: 'Việt Hóa', hot: false },
            { key: 'mangadex' as const, label: 'Quốc Tế', hot: true },
          ].map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => {
                onSelectGenre(null);
                setPage(1);
                onSearchQuery('');
                onSelectSection(chip.key);
              }}
              className={`font-label flex shrink-0 items-center gap-1 rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition active:scale-95 ${
                activeSection === chip.key && !selectedGenre
                  ? 'bg-badge-new-bg text-white shadow-sm'
                  : 'bg-surface-container text-text-primary'
              }`}
            >
              <span>{chip.label}</span>
              {chip.hot && (
                <span className="material-symbols-outlined material-symbols-filled text-[14px] text-badge-hot-bg">
                  local_fire_department
                </span>
              )}
            </button>
          ))}
          {genreList.slice(0, 6).map((g) => (
            <button
              key={g.slug}
              type="button"
              onClick={() => handleSelectGenre(g)}
              className={`font-label shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold ${
                selectedGenre?.slug === g.slug
                  ? 'bg-primary-container text-on-primary-container'
                  : 'bg-surface-container text-on-surface-variant'
              }`}
            >
              {g.name}
            </button>
          ))}
        </div>

        {/* Mobile 1-Tap Continue Listening Quick-Resume Card */}
        {history.length > 0 &&
          activeSection === 'hinettruyen' &&
          !searchQuery &&
          !selectedGenre && (
            <Link
              to={`/read/${history[0].source_type}/${encodeURIComponent(history[0].comic_id)}/${encodeURIComponent(history[0].chapter_id)}?page=${history[0].page_index}`}
              onTouchStart={() => {
                void api
                  .getChapterPages(
                    history[0].source_type,
                    history[0].comic_id,
                    history[0].chapter_id
                  )
                  .catch(() => {});
              }}
              className="mt-0.5 flex items-center gap-3 rounded-xl border border-primary-container/35 bg-surface-card p-2.5 shadow-sm transition active:scale-[0.99]"
            >
              <div className="h-12 w-9 shrink-0 overflow-hidden rounded-md bg-surface-container">
                {history[0].cover_url && (
                  <img
                    src={getMobileImageUrl(history[0].cover_url, 180, 72)}
                    alt={history[0].comic_title}
                    {...({ fetchpriority: 'high' } as Record<string, string>)}
                    className="h-full w-full object-cover"
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <span className="font-label inline-flex items-center gap-1 rounded bg-accent-green/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent-green">
                  Đang nghe dở
                </span>
                <h3 className="mt-0.5 truncate text-[13px] font-bold text-text-primary">
                  {history[0].comic_title}
                </h3>
                <p className="truncate text-[11px] text-text-secondary">
                  {history[0].chapter_title || 'Chương đang đọc'} • Trang {history[0].page_index + 1}
                </p>
              </div>
              <span className="font-label inline-flex shrink-0 items-center gap-1 rounded-lg bg-primary-container px-3 py-2 text-[11px] font-bold text-on-primary-container shadow-sm">
                <span className="material-symbols-outlined text-[16px]">play_arrow</span>
                <span>Nghe tiếp</span>
              </span>
            </Link>
          )}
      </section>

      <main className="mx-auto min-h-[calc(100vh-280px)] w-full max-w-7xl px-4 sm:px-6">
        {/* 1. AI Lazy Reader Quick Notice Banner (Desktop & Tablet) */}
        {showAnnouncement && (
          <div className="my-4 hidden w-full sm:block">
            <div className="relative flex items-center justify-between gap-3 overflow-hidden rounded-xl border border-border-subtle/70 bg-surface-card p-3 shadow-sm sm:p-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-badge-new-bg/15">
                  <span className="material-symbols-outlined material-symbols-filled text-[20px] text-primary">
                    record_voice_over
                  </span>
                </div>
                <p className="truncate text-[13px] font-medium text-on-surface">
                  <span className="mr-1 font-bold text-primary">Thuyết minh AI rảnh tay:</span>
                  Mở bất kỳ chương nào từ HiNetTruyen để tự lướt đồng bộ giọng đọc Google &amp; phụ đề tiếng Việt.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => (user ? openSettingsModal() : openAuthModal())}
                  className="font-label hidden items-center gap-1 rounded-lg bg-primary-container px-3 py-1.5 text-[12px] font-bold text-on-primary-container transition hover:bg-badge-new-bg hover:text-white sm:inline-flex"
                >
                  <span>Cài Gemini Key</span>
                  <span className="material-symbols-outlined text-[15px]">chevron_right</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowAnnouncement(false)}
                  aria-label="Đóng thông báo"
                  className="rounded p-1 text-outline hover:bg-surface-container hover:text-on-surface"
                >
                  <span className="material-symbols-outlined text-[16px]">close</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 2. Section: Truyện Đề Cử (HiNetTruyen Real Featured Carousel) */}
        {featuredList.length > 0 &&
          activeSection === 'hinettruyen' &&
          !searchQuery &&
          !selectedGenre &&
          page === 1 && (
            <section className="mb-5 w-full sm:mb-8">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-tertiary-container/20 text-tertiary">
                  <span className="material-symbols-outlined material-symbols-filled text-[20px]">
                    local_fire_department
                  </span>
                </div>
                <h2 className="text-[20px] font-bold tracking-tight text-text-primary">
                  Truyện Đề Cử
                </h2>
                <span className="font-label rounded-full bg-badge-hot-bg/20 px-2 py-0.5 text-[11px] font-bold uppercase text-secondary">
                  Hot
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label="Trước"
                  onClick={() =>
                    featuredScrollRef.current?.scrollBy({ left: -340, behavior: 'smooth' })
                  }
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-border-subtle bg-surface-card text-on-surface transition hover:bg-surface-card-hover"
                >
                  <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                </button>
                <button
                  type="button"
                  aria-label="Sau"
                  onClick={() =>
                    featuredScrollRef.current?.scrollBy({ left: 340, behavior: 'smooth' })
                  }
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-border-subtle bg-surface-card text-on-surface transition hover:bg-surface-card-hover"
                >
                  <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                </button>
              </div>
            </div>

            <div
              ref={featuredScrollRef}
              className="no-scrollbar flex snap-x snap-mandatory gap-2.5 overflow-x-auto pb-1 sm:gap-3.5"
            >
              {featuredList.slice(0, 14).map((comic, idx) => (
                <div
                  key={`feat-${comic.source_type}-${comic.id}`}
                  className="w-[138px] shrink-0 snap-start sm:w-[172px] lg:w-[192px]"
                >
                  <ComicCard
                    comic={comic}
                    compact
                    priority={idx < 3}
                    badgeOverride={
                      idx === 0
                        ? { label: 'TOP 1', cls: 'bg-badge-hot-bg text-white' }
                        : idx === 1
                          ? { label: 'MỚI', cls: 'bg-badge-new-bg text-white' }
                          : idx === 2
                            ? { label: 'HOT', cls: 'bg-tertiary-container text-white' }
                            : undefined
                    }
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 3. Main 2-Column Layout (Left Feed 8 cols | Right Sidebar 4 cols) */}
        <div className="grid w-full grid-cols-1 items-start gap-6 lg:grid-cols-12">
          {/* LEFT FEED (8 cols) */}
          <div className="flex flex-col gap-5 lg:col-span-8">
            {/* Section Header & Filter Chips */}
            <div className="flex flex-col justify-between gap-3 rounded-xl border border-border-subtle/70 bg-surface-card p-4 shadow-sm">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-container/20 text-primary">
                  <span className="material-symbols-outlined text-[22px]">
                    {activeSection === 'local'
                      ? 'folder_special'
                      : activeSection === 'favorites'
                        ? 'bookmarks'
                        : activeSection === 'history'
                          ? 'history'
                          : 'update'}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-[18px] font-bold tracking-tight text-text-primary sm:text-[20px]">
                    {sectionHeading[activeSection].title}
                  </h1>
                  <p className="truncate text-[12px] text-text-secondary sm:text-[13px]">
                    {sectionHeading[activeSection].subtitle}
                  </p>
                </div>
              </div>

              <div
                className={`flex-wrap items-center gap-1.5 border-t border-border-subtle/50 pt-3 ${
                  searchQuery || selectedGenre ? 'flex' : 'hidden md:flex'
                }`}
              >
                {[
                  { key: 'hinettruyen' as const, label: 'Việt Hóa' },
                  { key: 'mangadex' as const, label: 'Quốc Tế' },
                  ...(user?.is_admin ? [{ key: 'local' as const, label: 'Kho Admin' }] : []),
                ].map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={() => {
                      onSelectGenre(null);
                      setPage(1);
                      onSearchQuery('');
                      onSelectSection(chip.key);
                    }}
                    className={`font-label hidden whitespace-nowrap rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors md:inline-flex ${
                      activeSection === chip.key && !selectedGenre
                        ? 'bg-primary-container text-on-primary-container'
                        : 'bg-surface-container text-on-surface-variant hover:bg-surface-card-hover'
                    }`}
                  >
                    {chip.label}
                  </button>
                ))}
                {(searchQuery || selectedGenre) && (
                  <button
                    type="button"
                    onClick={() => {
                      onSelectGenre(null);
                      setPage(1);
                      onSearchQuery('');
                    }}
                    className="font-label whitespace-nowrap rounded-lg bg-badge-hot-bg/20 px-2.5 py-1.5 text-[12px] font-semibold text-secondary"
                  >
                    Xóa lọc
                  </button>
                )}
              </div>
            </div>

            {/* Feed Body */}
            {loadingFeed ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className="overflow-hidden rounded-xl border border-border-subtle/60 bg-surface-card"
                  >
                    <div className="aspect-[3/4] w-full animate-pulse bg-surface-container" />
                    <div className="space-y-2 p-3">
                      <div className="h-4 w-4/5 animate-pulse rounded bg-surface-container" />
                      <div className="h-3 w-1/2 animate-pulse rounded bg-surface-container-low" />
                    </div>
                  </div>
                ))}
              </div>
            ) : error ? (
              <div className="rounded-xl border border-badge-hot-bg/40 bg-badge-hot-bg/10 p-6 text-center text-sm text-secondary">
                <p>{error}</p>
                <button
                  type="button"
                  onClick={() => void loadFeed()}
                  className="mt-3 rounded-lg bg-surface-container px-4 py-2 text-xs font-semibold text-text-primary hover:bg-surface-container-high"
                >
                  Thử tải lại
                </button>
              </div>
            ) : activeSection === 'history' ? (
              history.length === 0 ? (
                <div className="rounded-xl border border-border-subtle bg-surface-card p-8 text-center text-sm text-text-secondary">
                  Bạn chưa nghe chương truyện nào. Hãy mở một bộ truyện bất kỳ để bắt đầu!
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {history.map((h) => (
                    <Link
                      key={h.id}
                      to={`/read/${h.source_type}/${encodeURIComponent(h.comic_id)}/${encodeURIComponent(h.chapter_id)}?page=${h.page_index}`}
                      className="flex items-center gap-3.5 rounded-xl border border-border-subtle/70 bg-surface-card p-3 transition hover:border-primary-container/50 hover:bg-surface-card-hover"
                    >
                      <div className="h-20 w-14 shrink-0 overflow-hidden rounded-lg bg-surface-container">
                        {h.cover_url && (
                          <img
                            src={resolveBackendUrl(h.cover_url)}
                            alt={h.comic_title}
                            className="h-full w-full object-cover"
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-[14px] font-bold text-text-primary">
                          {h.comic_title}
                        </h3>
                        <p className="mt-0.5 truncate text-[12px] font-medium text-accent-green">
                          {h.chapter_title || 'Chương đang đọc'} • Trang {h.page_index + 1}
                        </p>
                        <span className="font-label mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-primary">
                          <span className="material-symbols-outlined text-[15px]">play_arrow</span>
                          Nghe tiếp ngay
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )
            ) : activeSection === 'favorites' ? (
              !user ? (
                <div className="rounded-xl border border-border-subtle bg-surface-card p-10 text-center">
                  <span className="material-symbols-outlined mb-2 text-[42px] text-primary">
                    bookmarks
                  </span>
                  <h2 className="text-base font-bold text-text-primary">
                    Đăng nhập để đồng bộ Tủ truyện yêu thích
                  </h2>
                  <p className="mx-auto mt-1 max-w-md text-sm text-text-secondary">
                    Hệ thống lưu truyện theo dõi trên mọi thiết bị (Lịch sử đọc đã được tự động lưu trên máy hiện tại).
                  </p>
                  <button
                    type="button"
                    onClick={openAuthModal}
                    className="mt-5 rounded-lg bg-primary-container px-5 py-2.5 text-sm font-bold text-on-primary-container hover:bg-badge-new-bg hover:text-white"
                  >
                    Đăng nhập / Đăng ký
                  </button>
                </div>
              ) : favorites.length === 0 ? (
                <div className="rounded-xl border border-border-subtle bg-surface-card p-8 text-center text-sm text-text-secondary">
                  Bạn chưa theo dõi bộ truyện nào. Bấm nút Theo dõi trong trang truyện để lưu vào đây.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4">
                  {favorites.map((f) => (
                    <ComicCard
                      key={f.id}
                      comic={{
                        id: f.comic_id,
                        source_type: f.source_type,
                        title: f.comic_title,
                        cover_url: f.cover_url,
                        description: '',
                        latest_chapter: 'Đang theo dõi',
                        language: 'vi',
                        chapter_count: 0,
                      }}
                    />
                  ))}
                </div>
              )
            ) : feedComics.length === 0 ? (
              <div className="rounded-xl border border-border-subtle bg-surface-card p-10 text-center text-sm text-text-secondary">
                <p>Không tìm thấy truyện nào phù hợp.</p>
                {activeSection === 'local' && user?.is_admin && (
                  <button
                    type="button"
                    onClick={() => openUploadModal(null)}
                    className="mt-4 rounded-lg bg-accent-green px-4 py-2 text-xs font-bold text-white"
                  >
                    + Tải truyện lên kho
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4">
                  {feedComics.map((comic, idx) => (
                    <ComicCard
                      key={`${comic.source_type}-${comic.id}`}
                      comic={comic}
                      priority={idx < 2}
                      badgeOverride={
                        idx < 3 && activeSection === 'hinettruyen'
                          ? { label: 'HOT', cls: 'bg-badge-hot-bg text-white' }
                          : undefined
                      }
                    />
                  ))}
                </div>

                {/* Pagination bar for Vietnamese & International catalogs */}
                {(activeSection === 'hinettruyen' || activeSection === 'mangadex') && (
                  <div className="my-4 flex items-center justify-center gap-1.5">
                    <button
                      type="button"
                      disabled={page <= 1}
                      onClick={() => {
                        setPage((p) => Math.max(1, p - 1));
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      className="flex h-9 items-center gap-1 rounded-lg bg-surface-card px-3 text-xs font-semibold text-text-secondary transition hover:bg-surface-card-hover hover:text-text-primary disabled:opacity-35"
                    >
                      <span className="material-symbols-outlined text-[16px]">chevron_left</span>
                      <span>Trước</span>
                    </button>

                    {Array.from({ length: 5 }, (_, idx) => Math.max(1, page - 2) + idx).map((pNum) => (
                      <button
                        key={pNum}
                        type="button"
                        onClick={() => {
                          setPage(pNum);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                        className={`font-label h-9 w-9 rounded-lg text-xs font-bold transition ${
                          page === pNum
                            ? 'bg-primary-container text-on-primary-container'
                            : 'bg-surface-card text-on-surface hover:bg-surface-card-hover'
                        }`}
                      >
                        {pNum}
                      </button>
                    ))}

                    <button
                      type="button"
                      disabled={feedComics.length < 20}
                      onClick={() => {
                        setPage((p) => p + 1);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      className="flex h-9 items-center gap-1 rounded-lg bg-surface-card px-3 text-xs font-semibold text-text-secondary transition hover:bg-surface-card-hover hover:text-text-primary disabled:opacity-35"
                    >
                      <span>Sau</span>
                      <span className="material-symbols-outlined text-[16px]">chevron_right</span>
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* RIGHT SIDEBAR (4 cols — Real HiNetTruyen Rankings & Genres) */}
          <aside className="flex flex-col gap-6 lg:col-span-4">
            {/* Widget 1: Bảng Xếp Hạng */}
            <div className="flex flex-col gap-4 rounded-xl border border-border-subtle/70 bg-surface-card p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[22px] text-tertiary">
                    leaderboard
                  </span>
                  <h3 className="text-[15px] font-bold uppercase tracking-wider text-text-primary">
                    Bảng Xếp Hạng
                  </h3>
                </div>
                <span className="font-label text-[11px] font-bold text-primary">HiNetTruyen</span>
              </div>

              <div className="flex items-center rounded-lg bg-surface-container p-1">
                {[
                  { key: 'month' as const, label: 'Top Tháng' },
                  { key: 'week' as const, label: 'Top Tuần' },
                  { key: 'day' as const, label: 'Top Ngày' },
                ].map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setRankTab(t.key)}
                    className={`font-label flex-1 rounded-md py-1.5 text-center text-[12px] font-semibold transition-all ${
                      rankTab === t.key
                        ? 'bg-primary-container text-on-primary-container'
                        : 'text-text-secondary hover:text-on-surface'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-col gap-2.5">
                {rankingList.length === 0 ? (
                  <p className="py-4 text-center text-xs text-text-secondary">
                    Đang tải bảng xếp hạng...
                  </p>
                ) : (
                  rankingList.map((comic, idx) => {
                    const rankNum = String(idx + 1).padStart(2, '0');
                    const badgeStyle =
                      idx === 0
                        ? 'bg-badge-hot-bg text-white shadow-md'
                        : idx === 1
                          ? 'bg-badge-new-bg text-white shadow-sm'
                          : idx === 2
                            ? 'bg-tertiary-container text-white shadow-sm'
                            : 'bg-surface-container text-outline';

                    return (
                      <Link
                        key={`rank-${rankTab}-${comic.id}`}
                        to={`/comic/${comic.source_type}/${encodeURIComponent(comic.id)}`}
                        className="group flex items-center gap-3 rounded-lg p-1.5 transition-colors hover:bg-surface-card-hover"
                      >
                        <div
                          className={`font-label flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[13px] font-bold ${badgeStyle}`}
                        >
                          {rankNum}
                        </div>
                        <div className="h-14 w-11 shrink-0 overflow-hidden rounded-md bg-surface-container">
                          {comic.cover_url && (
                            <img
                              src={resolveBackendUrl(comic.cover_url)}
                              alt={comic.title}
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <h4 className="truncate text-[13px] font-bold text-text-primary transition-colors group-hover:text-primary">
                            {comic.title}
                          </h4>
                          <div className="font-label mt-1 flex items-center justify-between text-[11px] text-text-secondary">
                            <span className="truncate text-primary">
                              {comic.latest_chapter || 'Đọc ngay'}
                            </span>
                            <span className="shrink-0 uppercase text-outline">VI</span>
                          </div>
                        </div>
                      </Link>
                    );
                  })
                )}
              </div>
            </div>

            {/* Widget 2: Nghe Tiếp */}
            <div className="flex flex-col gap-4 rounded-xl border border-border-subtle/70 bg-surface-card p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[20px] text-primary">
                    bookmark
                  </span>
                  <h3 className="text-[15px] font-bold uppercase tracking-wider text-text-primary">
                    Nghe Tiếp
                  </h3>
                </div>
                <span className="font-label rounded bg-accent-green/20 px-2 py-0.5 text-[11px] font-semibold text-accent-green">
                  Đồng bộ
                </span>
              </div>

              {history.length > 0 ? (
                <div className="flex flex-col gap-2.5">
                  {history.slice(0, 3).map((h) => (
                    <div
                      key={h.id}
                      className="flex items-center gap-3 rounded-lg bg-surface-container p-2.5"
                    >
                      <div className="h-14 w-10 shrink-0 overflow-hidden rounded bg-surface-card">
                        {h.cover_url && (
                          <img
                            src={resolveBackendUrl(h.cover_url)}
                            alt={h.comic_title}
                            className="h-full w-full object-cover"
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="truncate text-[13px] font-bold text-text-primary">
                          {h.comic_title}
                        </h4>
                        <p className="truncate text-[11px] text-accent-green">
                          {h.chapter_title} • Trang {h.page_index + 1}
                        </p>
                      </div>
                      <Link
                        to={`/read/${h.source_type}/${encodeURIComponent(h.comic_id)}/${encodeURIComponent(h.chapter_id)}?page=${h.page_index}`}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-container/20 text-primary transition-colors hover:bg-primary-container hover:text-on-primary-container"
                        title="Nghe tiếp"
                      >
                        <span className="material-symbols-outlined text-[18px]">play_arrow</span>
                      </Link>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg bg-surface-container p-3.5 text-[12px] leading-relaxed text-text-secondary">
                  Chưa có truyện đang nghe dở. Hãy chọn một bộ truyện bất kỳ — hệ thống sẽ tự động lưu đúng chương và trang bạn đang xem.
                </div>
              )}

              {!user && (
                <div className="flex items-center justify-between gap-2 pt-1">
                  <p className="text-[12px] text-text-secondary">
                    Đăng nhập để lưu tủ sách và nhớ trang đang nghe dở.
                  </p>
                  <button
                    type="button"
                    onClick={openAuthModal}
                    className="font-label shrink-0 rounded-lg bg-surface-container px-3 py-1.5 text-[12px] font-semibold text-primary transition hover:bg-surface-card-hover"
                  >
                    Đăng nhập
                  </button>
                </div>
              )}
            </div>

            {/* Widget 3: Thể Loại Phổ Biến (Real HiNetTruyen Genre Slugs) */}
            <div className="flex flex-col gap-4 rounded-xl border border-border-subtle/70 bg-surface-card p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[20px] text-secondary">
                  category
                </span>
                <h3 className="text-[15px] font-bold uppercase tracking-wider text-text-primary">
                  Thể Loại Phổ Biến
                </h3>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => handleSelectGenre(null)}
                  className={`font-label rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${
                    !selectedGenre && activeSection === 'hinettruyen'
                      ? 'bg-primary-container text-on-primary-container'
                      : 'bg-surface-container text-on-surface-variant hover:bg-primary-container hover:text-on-primary-container'
                  }`}
                >
                  Tất cả
                </button>
                {genreList.slice(0, 18).map((g) => (
                  <button
                    key={g.slug}
                    type="button"
                    onClick={() => handleSelectGenre(g)}
                    className={`font-label rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${
                      selectedGenre?.slug === g.slug
                        ? 'bg-primary-container text-on-primary-container'
                        : 'bg-surface-container text-on-surface-variant hover:bg-primary-container hover:text-on-primary-container'
                    }`}
                  >
                    {g.name}
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </main>

      {/* Stitch 3-Column Dark Footer */}
      <footer className="mt-16 w-full border-t border-border-subtle/60 bg-surface-card">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
          <div className="grid grid-cols-1 gap-8 md:grid-cols-12">
            <div className="flex flex-col gap-3 md:col-span-5">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-badge-new-bg to-badge-hot-bg text-white">
                  <span className="material-symbols-outlined text-[18px]">headphones</span>
                </div>
                <span className="text-[18px] font-extrabold text-primary">LườiTruyện</span>
              </div>
              <p className="text-[13px] leading-relaxed text-text-secondary">
                Nền tảng đọc truyện tranh tự lướt đồng bộ giọng đọc thuyết minh tiếng Việt cho người lười. Kết nối kho HiNetTruyen, MangaDex và tải truyện cá nhân.
              </p>
            </div>

            <div className="flex flex-col gap-3 md:col-span-4">
              <h3 className="text-[13px] font-bold uppercase tracking-wider text-on-surface">
                Thể Loại Nổi Bật
              </h3>
              <div className="flex flex-wrap gap-2">
                {genreList.slice(0, 8).map((g) => (
                  <button
                    key={`foot-${g.slug}`}
                    type="button"
                    onClick={() => {
                      handleSelectGenre(g);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className="rounded bg-surface-container px-2.5 py-1 text-[12px] text-on-surface-variant transition hover:bg-surface-container-high hover:text-primary"
                  >
                    {g.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col justify-between gap-4 md:col-span-3">
              <p className="text-[12px] leading-relaxed text-text-secondary">
                Giao diện thiết kế theo hệ thống Prism Comic Engine tối ưu cho màn hình đêm.
              </p>
              <div className="flex items-center justify-between">
                <span className="font-label text-[11px] text-outline">© 2026 LườiTruyện AI</span>
                <button
                  type="button"
                  aria-label="Lên đầu trang"
                  onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-container text-on-surface transition hover:bg-primary-container hover:text-on-primary-container"
                >
                  <span className="material-symbols-outlined text-[20px]">keyboard_arrow_up</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
