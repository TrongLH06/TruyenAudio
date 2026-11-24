import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import type { GenreItem } from '../types';

export type NavSection = 'hinettruyen' | 'mangadex' | 'local' | 'favorites' | 'history';

interface NavbarProps {
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  onSelectGenre: (genre: GenreItem | null) => void;
  onQuickSearch: (keyword: string) => void;
}

const HOT_KEYWORDS = ['Tu Tiên', 'Trọng Sinh', 'Hệ Thống', 'Võ Luyện', 'Đại Phản Phái'];
const QUICK_GENRES: GenreItem[] = [
  { name: 'Action', slug: 'action-95' },
  { name: 'Chuyển Sinh', slug: 'chuyen-sinh-2130' },
  { name: 'Cổ Đại', slug: 'co-dai-207' },
  { name: 'Fantasy', slug: 'fantasy-105' },
  { name: 'Drama', slug: 'drama-103' },
  { name: 'Comedy', slug: 'comedy-99' },
  { name: 'Adventure', slug: 'adventure' },
  { name: 'Đam Mỹ', slug: 'dam-my' },
];

export function Navbar({
  activeSection,
  onSelectSection,
  onSelectGenre,
  onQuickSearch,
}: NavbarProps) {
  const { user, openAuthModal, openSettingsModal, openUploadModal, logout } = useAuth();
  const [searchTerm, setSearchTerm] = useState('');
  const [genreMenuOpen, setGenreMenuOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const goSection = (sec: NavSection) => {
    onSelectSection(sec);
    if (location.pathname !== '/') {
      navigate('/');
    }
  };

  const handleSubmitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onQuickSearch(searchTerm.trim());
    if (location.pathname !== '/') {
      navigate('/');
    }
  };

  const handleHotTag = (kw: string) => {
    setSearchTerm(kw);
    onQuickSearch(kw);
    if (location.pathname !== '/') {
      navigate('/');
    }
  };

  return (
    <>
      {/* Desktop & Mobile Top Fixed Header (Stitch 2-Tier Prism Layout) */}
      <header className="pt-safe fixed left-0 top-0 z-50 w-full bg-surface-container-lowest/90 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.65)] backdrop-blur-xl">
        {/* Tier 1: Brand + Global Search + Actions */}
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          {/* Brand Logo */}
          <Link
            to="/"
            onClick={() => onSelectSection('hinettruyen')}
            className="flex shrink-0 items-center gap-2.5"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-badge-new-bg via-primary-container to-badge-hot-bg text-white shadow-md shadow-badge-new-bg/25">
              <span className="material-symbols-outlined material-symbols-filled text-[22px]">
                headphones
              </span>
            </div>
            <div className="leading-tight">
              <span className="block text-[18px] font-extrabold tracking-tight text-primary">
                LườiTruyện
              </span>
              <span className="font-label hidden text-[10px] uppercase tracking-wider text-text-secondary sm:block">
                AI Auto-Scroll
              </span>
            </div>
          </Link>

          {/* Desktop Global Search Bar + Hot Keywords */}
          <div className="hidden max-w-xl flex-1 md:block">
            <form onSubmit={handleSubmitSearch} className="relative flex items-center">
              <div className="flex w-full items-center rounded-lg bg-surface-container transition-all focus-within:ring-2 focus-within:ring-primary-container">
                <span className="material-symbols-outlined ml-3 shrink-0 text-[20px] text-outline">
                  search
                </span>
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Tìm truyện, tác giả, thể loại..."
                  className="w-full bg-transparent px-3 py-2 text-[13px] text-on-surface placeholder:text-outline focus:outline-none"
                />
                <button
                  type="submit"
                  className="flex shrink-0 items-center gap-1 rounded-r-lg bg-primary-container px-4 py-2 text-[14px] font-semibold text-on-primary-container transition-colors hover:bg-badge-new-bg hover:text-white"
                >
                  <span>Tìm</span>
                </button>
              </div>
            </form>
            <div className="mt-1 hidden items-center gap-2 px-1 lg:flex">
              <span className="font-label text-[11px] font-bold uppercase tracking-wider text-text-secondary">
                Hot:
              </span>
              {HOT_KEYWORDS.map((kw) => (
                <button
                  key={kw}
                  type="button"
                  onClick={() => handleHotTag(kw)}
                  className="font-label text-[11px] font-semibold text-outline transition-colors hover:text-primary"
                >
                  {kw}
                </button>
              ))}
            </div>
          </div>

          {/* Right Action Controls */}
          <div className="flex shrink-0 items-center gap-2">
            {user?.is_admin && (
              <button
                type="button"
                onClick={() => openUploadModal(null)}
                className="flex items-center gap-1.5 rounded-lg bg-accent-green/20 px-3 py-2 text-[13px] font-bold text-accent-green transition-colors hover:bg-accent-green hover:text-white"
                title="Tải ảnh / ZIP / CBZ / PDF lên kho truyện (Admin)"
              >
                <span className="material-symbols-outlined text-[18px]">cloud_upload</span>
                <span className="hidden sm:inline">Tải lên</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => goSection('history')}
              className="hidden items-center gap-1.5 rounded-lg bg-surface-container px-3 py-2 text-[13px] text-on-surface transition-colors hover:bg-surface-container-high xl:flex"
            >
              <span className="material-symbols-outlined text-[18px] text-primary">history</span>
              <span>Lịch sử</span>
            </button>

            {user ? (
              <>
                <button
                  type="button"
                  onClick={openSettingsModal}
                  className="flex items-center gap-1.5 rounded-lg bg-surface-container px-2.5 py-2 text-[12px] font-semibold text-on-surface transition-colors hover:bg-surface-container-high"
                  title="Cài đặt Gemini API Key cá nhân"
                >
                  <span
                    className={`material-symbols-outlined text-[18px] ${
                      user.has_custom_api_key ? 'text-accent-green' : 'text-tertiary'
                    }`}
                  >
                    key
                  </span>
                  <span className="font-label hidden lg:inline">
                    {user.has_custom_api_key
                      ? 'BYOK'
                      : `AI ${Math.max(0, user.daily_free_limit - user.daily_free_used)}/${user.daily_free_limit}`}
                  </span>
                </button>

                <div className="flex items-center gap-2 rounded-lg bg-surface-container py-1 pl-2 pr-1.5">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-[12px] font-bold uppercase text-on-primary">
                    {user.username.slice(0, 1)}
                  </div>
                  <span className="hidden max-w-[100px] truncate text-[13px] font-semibold text-on-surface sm:inline">
                    {user.username}
                  </span>
                  {user.is_admin && (
                    <span className="font-label hidden rounded bg-badge-hot-bg px-1.5 py-0.5 text-[9px] font-extrabold uppercase text-white sm:inline">
                      ADMIN
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={logout}
                    title="Đăng xuất"
                    className="flex h-7 w-7 items-center justify-center rounded text-outline transition-colors hover:bg-surface-container-high hover:text-badge-hot-bg"
                  >
                    <span className="material-symbols-outlined text-[17px]">logout</span>
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                onClick={openAuthModal}
                className="flex items-center gap-2 rounded-lg bg-surface-container px-3 py-1.5 text-on-surface transition-colors hover:bg-surface-container-high"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary">
                  <span className="material-symbols-outlined text-[18px] text-on-primary">
                    person
                  </span>
                </div>
                <span className="hidden text-[13px] font-semibold sm:inline">
                  Đăng nhập / Đăng ký
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Tier 2: Desktop Category Navigation Strip */}
        <div className="hidden h-12 border-t border-border-subtle/60 bg-surface-card md:block">
          <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-6">
            <nav className="flex items-center gap-1 py-1">
              {[
                { key: 'hinettruyen' as const, label: 'Trang Chủ', hot: false },
                { key: 'mangadex' as const, label: 'Hot Quốc Tế', hot: true },
                ...(user?.is_admin ? [{ key: 'local' as const, label: 'Kho Admin', hot: false }] : []),
                { key: 'favorites' as const, label: 'Theo Dõi', hot: false },
                { key: 'history' as const, label: 'Lịch Sử', hot: false },
              ].map((item) => {
                const isActive = location.pathname === '/' && activeSection === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => goSection(item.key)}
                    className={`relative whitespace-nowrap rounded-lg px-3.5 py-1.5 text-[14px] font-semibold transition-colors ${
                      isActive
                        ? 'bg-primary-container text-on-primary-container'
                        : 'text-on-surface-variant hover:bg-surface-card-hover hover:text-on-surface'
                    }`}
                  >
                    <span>{item.label}</span>
                    {item.hot && (
                      <span className="font-label ml-1.5 inline-block rounded-full bg-badge-hot-bg px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase leading-none text-white">
                        AI Dịch
                      </span>
                    )}
                  </button>
                );
              })}

              {/* Stitch Thể Loại Dropdown */}
              <div
                className="relative"
                onMouseEnter={() => setGenreMenuOpen(true)}
                onMouseLeave={() => setGenreMenuOpen(false)}
              >
                <button
                  type="button"
                  onClick={() => setGenreMenuOpen((v) => !v)}
                  className="flex items-center gap-1 whitespace-nowrap rounded-lg px-3.5 py-1.5 text-[14px] font-semibold text-on-surface-variant transition-colors hover:bg-surface-card-hover hover:text-primary"
                >
                  <span>Thể Loại</span>
                  <span className="material-symbols-outlined text-[16px]">expand_more</span>
                </button>
                {genreMenuOpen && (
                  <div className="absolute left-0 top-full z-50 grid w-64 grid-cols-2 gap-1.5 rounded-xl border border-border-subtle bg-surface-card p-3 shadow-2xl">
                    {QUICK_GENRES.map((g) => (
                      <button
                        key={g.slug}
                        type="button"
                        onClick={() => {
                          setGenreMenuOpen(false);
                          onSelectGenre(g);
                          if (location.pathname !== '/') navigate('/');
                        }}
                        className="rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-on-surface transition hover:bg-surface-container hover:text-primary"
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </nav>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => (user ? openSettingsModal() : openAuthModal())}
                className="flex items-center gap-1.5 rounded-full bg-badge-new-bg/15 px-3.5 py-1.5 text-[13px] font-semibold text-primary transition-colors hover:bg-badge-new-bg/25"
              >
                <span className="material-symbols-outlined text-[16px]">key</span>
                <span>Cài Gemini AI Key</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Mobile Bottom Tab Bar (Stitch mobile_tab shell) */}
      <nav className="pb-safe fixed bottom-0 left-0 z-40 w-full border-t border-border-subtle/70 bg-surface/95 shadow-[0_-4px_16px_rgba(0,0,0,0.45)] backdrop-blur-xl md:hidden">
        <div className="flex h-14 items-center justify-around px-1">
          {[
            { key: 'hinettruyen' as const, label: 'Trang chủ', icon: 'home' },
            { key: 'mangadex' as const, label: 'Quốc tế', icon: 'local_fire_department' },
            ...(user?.is_admin
              ? [{ key: 'local' as const, label: 'Kho máy', icon: 'folder_special' }]
              : []),
            { key: 'favorites' as const, label: 'Theo dõi', icon: 'bookmarks' },
            { key: 'history' as const, label: 'Lịch sử', icon: 'history' },
          ].map((tab) => {
            const active = location.pathname === '/' && activeSection === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => goSection(tab.key)}
                className={`flex h-12 min-w-[52px] flex-col items-center justify-center gap-0.5 transition-all active:scale-95 ${
                  active ? 'font-bold text-primary' : 'text-on-surface-variant'
                }`}
              >
                <span
                  className={`material-symbols-outlined text-[21px] ${
                    active ? 'material-symbols-filled' : ''
                  }`}
                >
                  {tab.icon}
                </span>
                <span className="font-label text-[10px]">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}
