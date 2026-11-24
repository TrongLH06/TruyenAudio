import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, Loader2 } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, ApiError, resolveBackendUrl } from '../lib/api';
import { loadLocalHistory } from '../lib/localPrefs';
import { getMobileImageUrl } from '../lib/mobileImage';
import type { ComicDetail, ComicSummary, HiNetHomeResponse, SourceType } from '../types';

const RANGE_SIZE = 100;

export function ComicDetailPage({ refreshSignal }: { refreshSignal: number }) {
  const { sourceType, comicId } = useParams<{ sourceType: SourceType; comicId: string }>();
  const navigate = useNavigate();
  const { user, openAuthModal, openUploadModal } = useAuth();

  const [comic, setComic] = useState<ComicDetail | null>(null);
  const [hinetHome, setHinetHome] = useState<HiNetHomeResponse | null>(null);
  const [lastReadChapterId, setLastReadChapterId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [favorited, setFavorited] = useState(false);

  // Stitch Interactive States
  const [synopsisExpanded, setSynopsisExpanded] = useState(false);
  const [chapterSearch, setChapterSearch] = useState('');
  const [sortNewestFirst, setSortNewestFirst] = useState(true);
  const [selectedRangeIdx, setSelectedRangeIdx] = useState<number>(0);
  const [rankTab, setRankTab] = useState<'month' | 'week' | 'day'>('month');
  const [copiedToast, setCopiedToast] = useState(false);

  const loadDetail = useCallback(async () => {
    if (!sourceType || !comicId) return;
    setLoading(true);
    setError('');
    setSynopsisExpanded(false);
    setChapterSearch('');
    setSelectedRangeIdx(0);

    const localHist = loadLocalHistory().find(
      (h) => h.source_type === sourceType && h.comic_id === comicId
    );
    setLastReadChapterId(localHist?.chapter_id || null);

    // Warm rankings/recommendations in background without blocking the hero/chapters render
    void api
      .getHiNetHome()
      .then((homeData) => {
        if (homeData) setHinetHome(homeData);
      })
      .catch(() => {});

    try {
      const data = await api.getComicDetail(sourceType, comicId);
      setComic(data);
      setLoading(false);

      if (user) {
        void Promise.all([
          api.listFavorites().catch(() => []),
          api.listHistory().catch(() => []),
        ]).then(([favs, hist]) => {
          setFavorited(favs.some((f) => f.source_type === sourceType && f.comic_id === comicId));
          const matchHist = hist.find((h) => h.source_type === sourceType && h.comic_id === comicId);
          setLastReadChapterId(matchHist ? matchHist.chapter_id : localHist?.chapter_id || null);
        });
      } else {
        setFavorited(false);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Không tải được chi tiết truyện.');
      setLoading(false);
    }
  }, [sourceType, comicId, user, refreshSignal]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const handleToggleFavorite = async () => {
    if (!comic) return;
    if (!user) {
      openAuthModal();
      return;
    }
    try {
      const res = await api.toggleFavorite({
        source_type: comic.source_type,
        comic_id: comic.id,
        comic_title: comic.title,
        cover_url: comic.cover_url,
      });
      setFavorited(res.favorited);
    } catch {
      // ignore
    }
  };

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedToast(true);
      window.setTimeout(() => setCopiedToast(false), 2200);
    } catch {
      // ignore
    }
  };

  const orderedChapters = useMemo(() => {
    if (!comic) return [];
    return sortNewestFirst ? [...comic.chapters].reverse() : [...comic.chapters];
  }, [comic, sortNewestFirst]);

  const chapterRanges = useMemo(() => {
    if (orderedChapters.length <= RANGE_SIZE) return [];
    const ranges: { label: string; start: number; end: number }[] = [];
    for (let i = 0; i < orderedChapters.length; i += RANGE_SIZE) {
      const slice = orderedChapters.slice(i, i + RANGE_SIZE);
      const firstLabel = slice[0]?.chapter_number || String(i + 1);
      const lastLabel = slice[slice.length - 1]?.chapter_number || String(i + slice.length);
      ranges.push({
        label: `${firstLabel} - ${lastLabel}`,
        start: i,
        end: i + slice.length,
      });
    }
    return ranges;
  }, [orderedChapters]);

  const displayedChapters = useMemo(() => {
    const q = chapterSearch.trim().toLowerCase();
    if (q) {
      const rankOf = (ch: { chapter_number: string; title: string }) => {
        const num = ch.chapter_number.toLowerCase();
        const ttl = ch.title.toLowerCase();
        if (num === q || ttl === q || ttl === `chapter ${q}` || ttl === `chương ${q}`) return 0;
        if (num.startsWith(q) || ttl.startsWith(`chapter ${q}`) || ttl.startsWith(`chương ${q}`)) return 1;
        return 2;
      };
      return orderedChapters
        .filter(
          (ch) =>
            ch.title.toLowerCase().includes(q) ||
            ch.chapter_number.toLowerCase().includes(q)
        )
        .sort((a, b) => rankOf(a) - rankOf(b));
    }
    if (chapterRanges.length > 0 && selectedRangeIdx >= 0 && selectedRangeIdx < chapterRanges.length) {
      const range = chapterRanges[selectedRangeIdx];
      return orderedChapters.slice(range.start, range.end);
    }
    return orderedChapters;
  }, [orderedChapters, chapterSearch, chapterRanges, selectedRangeIdx]);

  const rankingList: ComicSummary[] =
    rankTab === 'month'
      ? hinetHome?.top_month || []
      : rankTab === 'week'
        ? hinetHome?.top_week || []
        : hinetHome?.top_day || [];

  const similarList: ComicSummary[] = (hinetHome?.featured || [])
    .filter((c) => c.id !== comicId)
    .slice(0, 6);

  const latest3Ids = useMemo(
    () => new Set((comic?.chapters || []).slice(-3).map((c) => c.id)),
    [comic]
  );

  const prefetchChapter = useCallback(
    (chId?: string | null) => {
      if (!comic || !chId) return;
      void api.getChapterPages(comic.source_type, comic.id, chId).catch(() => {});
    },
    [comic]
  );

  if (loading) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 pt-28 text-text-secondary">
        <Loader2 className="h-7 w-7 animate-spin text-primary" />
        <span className="text-sm">Đang tải thông tin bộ truyện...</span>
      </div>
    );
  }

  if (error || !comic) {
    return (
      <div className="mx-auto max-w-3xl px-4 pb-16 pt-32 text-center">
        <p className="text-sm text-secondary">{error || 'Không tìm thấy truyện.'}</p>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mt-4 rounded-lg bg-surface-container px-4 py-2 text-sm text-text-primary hover:bg-surface-container-high"
        >
          Về trang chủ
        </button>
      </div>
    );
  }

  const firstChapter = comic.chapters[0];
  const latestChapter = comic.chapters[comic.chapters.length - 1];
  const demoSuffix = '';
  const sourceLabel =
    comic.source_type === 'local'
      ? 'Kho máy'
      : comic.source_type === 'hinettruyen'
        ? 'HiNetTruyen'
        : comic.source_type === 'otruyen'
          ? 'OTruyen'
          : 'MangaDex';

  return (
    <div className="min-h-screen bg-surface-bg pb-[calc(5.5rem+env(safe-area-inset-bottom,0px))] pt-[calc(4rem+env(safe-area-inset-top,0px))] md:pb-12 md:pt-28">
      {copiedToast && (
        <div className="fixed left-1/2 top-20 z-50 -translate-x-1/2 rounded-xl border border-border-subtle bg-surface-card/95 px-4 py-2 text-xs font-semibold text-accent-green shadow-2xl backdrop-blur-md">
          Đã sao chép liên kết truyện!
        </div>
      )}

      {/* ================= MOBILE HERO (Stitch Mobile Detail Screen) ================= */}
      <div className="relative w-full overflow-hidden bg-surface-container-lowest md:hidden">
        {comic.cover_url && (
          <div
            className="pointer-events-none absolute inset-0 scale-125 bg-cover bg-center opacity-25 blur-xl [transform:translateZ(0)]"
            style={{ backgroundImage: `url(${getMobileImageUrl(comic.cover_url, 180, 50)})` }}
          />
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-surface/40 via-surface/85 to-surface-bg" />

        <div className="relative z-10 px-4 pb-3 pt-4">
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="flex h-9 items-center gap-1.5 rounded-full bg-surface-container/90 px-3 text-xs font-semibold text-on-surface"
            >
              <span className="material-symbols-outlined text-[18px]">arrow_back</span>
              <span>Quay lại</span>
            </button>
            <button
              type="button"
              onClick={handleShare}
              aria-label="Chia sẻ truyện"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-container/90 text-on-surface-variant"
            >
              <span className="material-symbols-outlined text-[18px]">share</span>
            </button>
          </div>

          <div className="flex items-start gap-3.5">
            <div className="relative aspect-[3/4] w-28 shrink-0 overflow-hidden rounded-xl bg-surface-container-low shadow-2xl ring-1 ring-border-subtle">
              {comic.cover_url ? (
                <img
                  src={getMobileImageUrl(comic.cover_url, 420, 78)}
                  alt={comic.title}
                  {...({ fetchpriority: 'high' } as Record<string, string>)}
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-outline">
                  <BookOpen className="h-8 w-8" />
                </div>
              )}
              <div className="absolute left-1.5 top-1.5 flex flex-col items-start gap-1">
                <span className="font-label rounded bg-badge-hot-bg px-1.5 py-0.5 text-[10px] font-bold uppercase text-white shadow">
                  HOT
                </span>
                {latestChapter && (
                  <span className="font-label rounded border border-primary/30 bg-surface-bg/85 px-1.5 py-0.5 text-[10px] text-primary backdrop-blur-sm">
                    {latestChapter.chapter_number ? `Chap ${latestChapter.chapter_number}` : 'Mới'}
                  </span>
                )}
              </div>
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-surface-bg via-surface-bg/80 to-transparent p-1 text-center">
                <span className="font-label flex items-center justify-center gap-0.5 text-[10px] font-bold text-accent-green">
                  <span className="material-symbols-outlined material-symbols-filled text-[12px]">
                    check_circle
                  </span>
                  {comic.status || 'Đang ra'}
                </span>
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-start gap-1.5">
                <h1 className="line-clamp-2 text-[18px] font-extrabold leading-tight text-text-primary">
                  {comic.title}
                </h1>
                <span className="material-symbols-outlined material-symbols-filled shrink-0 text-[18px] text-primary">
                  verified
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1 text-[12px] text-on-surface-variant">
                <span className="material-symbols-outlined text-[15px] text-tertiary">
                  edit_note
                </span>
                <span className="truncate">
                  {comic.authors.length ? comic.authors.join(', ') : sourceLabel}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
                <span className="font-label rounded bg-surface-container px-2 py-0.5 font-semibold text-primary">
                  {sourceLabel}
                </span>
                <span className="font-label rounded bg-accent-green/15 px-2 py-0.5 font-semibold text-accent-green">
                  {comic.chapters.length} chương
                </span>
              </div>
            </div>
          </div>

          {/* Mobile Scrollable Tag Chips */}
          {comic.tags.length > 0 && (
            <div className="no-scrollbar mt-3 flex items-center gap-1.5 overflow-x-auto pb-1">
              {comic.tags.map((tag, i) => (
                <span
                  key={tag}
                  className={`font-label shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    i === 0
                      ? 'border border-primary/25 bg-primary/10 text-primary'
                      : i === 1
                        ? 'border border-secondary/20 bg-secondary-container/20 text-secondary'
                        : i === 2
                          ? 'border border-accent-green/25 bg-accent-green/15 text-accent-green'
                          : 'bg-surface-container-high text-on-surface-variant'
                  }`}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Mobile Primary CTAs (2-col Read First / Read Latest + Follow) */}
          <div className="mt-3 flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              {firstChapter && (
                <Link
                  to={`/read/${comic.source_type}/${encodeURIComponent(comic.id)}/${encodeURIComponent(firstChapter.id)}${demoSuffix}`}
                  state={{ comicTitle: comic.title, coverUrl: comic.cover_url }}
                  onMouseEnter={() => prefetchChapter(firstChapter.id)}
                  onFocus={() => prefetchChapter(firstChapter.id)}
                  onTouchStart={() => prefetchChapter(firstChapter.id)}
                  className="font-label flex h-11 items-center justify-center gap-1.5 rounded-xl bg-primary-container px-3 text-[12px] font-bold text-on-primary-container shadow-md transition active:scale-[0.98]"
                >
                  <span className="material-symbols-outlined material-symbols-filled text-[18px]">
                    menu_book
                  </span>
                  <span>Đọc từ đầu</span>
                </Link>
              )}
              {latestChapter && (
                <Link
                  to={`/read/${comic.source_type}/${encodeURIComponent(comic.id)}/${encodeURIComponent(latestChapter.id)}${demoSuffix}`}
                  state={{ comicTitle: comic.title, coverUrl: comic.cover_url }}
                  onMouseEnter={() => prefetchChapter(latestChapter.id)}
                  onFocus={() => prefetchChapter(latestChapter.id)}
                  onTouchStart={() => prefetchChapter(latestChapter.id)}
                  className="font-label flex h-11 items-center justify-center gap-1.5 rounded-xl border border-border-subtle bg-surface-container-high px-3 text-[12px] font-bold text-primary transition active:scale-[0.98]"
                >
                  <span className="material-symbols-outlined text-[18px]">bolt</span>
                  <span className="truncate">
                    Mới nhất {latestChapter.chapter_number ? `(${latestChapter.chapter_number})` : ''}
                  </span>
                </Link>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleToggleFavorite}
                className={`font-label flex h-10 items-center justify-center gap-1.5 rounded-xl border text-[12px] font-semibold transition active:scale-[0.98] ${
                  favorited
                    ? 'border-badge-hot-bg bg-badge-hot-bg text-white'
                    : 'border-border-subtle bg-surface-container text-on-surface'
                }`}
              >
                <span className="material-symbols-outlined material-symbols-filled text-[17px]">
                  favorite
                </span>
                <span>{favorited ? 'Đang theo dõi' : 'Theo dõi truyện'}</span>
              </button>

              {firstChapter && (
                <Link
                  to={`/read/${comic.source_type}/${encodeURIComponent(comic.id)}/${encodeURIComponent(
                    lastReadChapterId || firstChapter.id
                  )}${demoSuffix}`}
                  state={{ comicTitle: comic.title, coverUrl: comic.cover_url }}
                  onMouseEnter={() => prefetchChapter(lastReadChapterId || firstChapter.id)}
                  onFocus={() => prefetchChapter(lastReadChapterId || firstChapter.id)}
                  onTouchStart={() => prefetchChapter(lastReadChapterId || firstChapter.id)}
                  className="font-label flex h-10 items-center justify-center gap-1.5 rounded-xl border border-accent-green/35 bg-accent-green/15 text-[12px] font-semibold text-accent-green transition active:scale-[0.98]"
                >
                  <span className="material-symbols-outlined text-[17px]">headphones</span>
                  <span>{lastReadChapterId ? 'Nghe tiếp' : 'Nghe tự lướt'}</span>
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ================= MAIN CONTAINER (Desktop 12-Col + Mobile Sections) ================= */}
      <main className="mx-auto w-full max-w-7xl px-4 py-4 sm:px-6">
        {/* Desktop Breadcrumb */}
        <nav className="mb-4 hidden items-center gap-2 overflow-x-auto whitespace-nowrap text-[13px] text-on-surface-variant md:flex">
          <Link to="/" className="flex items-center gap-1 transition-colors hover:text-primary">
            <span className="material-symbols-outlined text-[16px]">home</span>
            <span>Trang chủ</span>
          </Link>
          <span className="text-[12px] text-outline">&gt;</span>
          <span className="text-text-secondary">{sourceLabel}</span>
          {comic.tags[0] && (
            <>
              <span className="text-[12px] text-outline">&gt;</span>
              <span className="text-text-secondary">{comic.tags[0]}</span>
            </>
          )}
          <span className="text-[12px] text-outline">&gt;</span>
          <span className="truncate font-bold text-primary">{comic.title}</span>
        </nav>

        <div className="grid w-full grid-cols-1 gap-8 lg:grid-cols-12">
          {/* LEFT COLUMN (8 cols) */}
          <div className="flex min-w-0 flex-col gap-6 lg:col-span-8">
            {/* Desktop 4.1 COMIC HERO CARD (Stitch Desktop Detail Screen) */}
            <section className="relative hidden overflow-hidden rounded-xl border border-border-subtle bg-surface-card p-6 shadow-2xl md:block">
              <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-primary-container/10 blur-3xl" />

              <div className="relative z-10 flex flex-row gap-5">
                {/* Large 3:4 Poster */}
                <div className="flex w-44 shrink-0 flex-col items-center xl:w-48">
                  <div className="group relative aspect-[3/4] w-full overflow-hidden rounded-xl border border-border-subtle bg-surface-container-high shadow-2xl">
                    {comic.cover_url ? (
                      <img
                        src={resolveBackendUrl(comic.cover_url)}
                        alt={comic.title}
                        decoding="async"
                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-outline">
                        <BookOpen className="h-12 w-12" />
                      </div>
                    )}
                    <div className="absolute left-2.5 top-2.5 flex flex-col gap-1.5">
                      <span className="font-label rounded bg-badge-hot-bg px-2.5 py-0.5 text-[11px] font-black uppercase tracking-wider text-white shadow-md">
                        HOT
                      </span>
                      {latestChapter && (
                        <span className="font-label rounded bg-badge-new-bg px-2.5 py-0.5 text-[11px] font-black uppercase tracking-wider text-white shadow-md">
                          {latestChapter.chapter_number
                            ? `CHƯƠNG ${latestChapter.chapter_number}`
                            : sourceLabel}
                        </span>
                      )}
                    </div>
                    <div className="font-label absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-surface-bg via-surface-bg/80 to-transparent p-3 pt-6 text-[12px] text-on-surface">
                      <span className="flex items-center gap-1 font-semibold">
                        <span className="material-symbols-outlined text-[15px] text-primary">
                          headphones
                        </span>
                        AI Voice
                      </span>
                      <span className="font-semibold text-accent-green">
                        {comic.chapters.length} chap
                      </span>
                    </div>
                  </div>
                </div>

                {/* Metadata Matrix */}
                <div className="flex min-w-0 flex-1 flex-col justify-between">
                  <div>
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <h1 className="text-[28px] font-extrabold leading-tight tracking-tight text-text-primary">
                        {comic.title}
                      </h1>
                      <span
                        className="material-symbols-outlined material-symbols-filled text-[24px] text-primary-container"
                        title="Hỗ trợ thuyết minh AI tự lướt"
                      >
                        verified
                      </span>
                    </div>

                    {comic.updated_at && (
                      <div className="mb-4 flex items-center gap-2">
                        <span className="font-label rounded border border-border-subtle bg-surface-container px-2.5 py-0.5 text-[11px] text-text-secondary">
                          {comic.updated_at}
                        </span>
                      </div>
                    )}

                    {/* 2-Column Metadata Grid */}
                    <div className="mb-5 grid grid-cols-1 gap-x-4 gap-y-2.5 text-[13px] sm:grid-cols-2">
                      <div className="flex items-center gap-2">
                        <span className="flex w-24 shrink-0 items-center gap-1.5 text-outline">
                          <span className="material-symbols-outlined text-[16px]">edit_note</span>
                          Tác giả:
                        </span>
                        <span className="truncate font-bold text-primary">
                          {comic.authors.length ? comic.authors.join(', ') : 'Đang cập nhật'}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="flex w-24 shrink-0 items-center gap-1.5 text-outline">
                          <span className="material-symbols-outlined text-[16px]">sync</span>
                          Tình trạng:
                        </span>
                        <span className="flex items-center gap-1.5 font-bold text-accent-green">
                          <span className="h-2 w-2 animate-pulse rounded-full bg-accent-green" />
                          {comic.status || 'Đang tiến hành'}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="flex w-24 shrink-0 items-center gap-1.5 text-outline">
                          <span className="material-symbols-outlined text-[16px]">dns</span>
                          Nguồn kho:
                        </span>
                        <span className="font-bold text-on-surface">{sourceLabel}</span>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="flex w-24 shrink-0 items-center gap-1.5 text-outline">
                          <span className="material-symbols-outlined text-[16px]">
                            record_voice_over
                          </span>
                          Chế độ AI:
                        </span>
                        <span className="font-bold text-tertiary">Kể chuyện &amp; Sát thoại</span>
                      </div>
                    </div>

                    {/* Genre Pills */}
                    {comic.tags.length > 0 && (
                      <div className="mb-5 flex flex-wrap gap-1.5">
                        {comic.tags.map((tag, i) => (
                          <span
                            key={tag}
                            className={`rounded px-2.5 py-1 text-[12px] font-semibold ${
                              i === 0
                                ? 'bg-badge-new-bg/15 text-primary'
                                : i === 1
                                  ? 'bg-secondary-container/20 text-secondary'
                                  : i === 2
                                    ? 'bg-tertiary-container/20 text-tertiary'
                                    : 'border border-border-subtle bg-surface-container text-on-surface-variant'
                            }`}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Primary Action CTA Buttons (single crisp row on desktop) */}
                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    {firstChapter && (
                      <Link
                        to={`/read/${comic.source_type}/${encodeURIComponent(comic.id)}/${encodeURIComponent(firstChapter.id)}${demoSuffix}`}
                        state={{ comicTitle: comic.title, coverUrl: comic.cover_url }}
                        onMouseEnter={() => prefetchChapter(firstChapter.id)}
                        onFocus={() => prefetchChapter(firstChapter.id)}
                        className="flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-primary-container px-3.5 py-2 text-[13px] font-extrabold text-on-primary-container shadow-lg shadow-primary-container/25 transition hover:bg-badge-new-bg hover:text-white"
                      >
                        <span className="material-symbols-outlined text-[18px]">auto_stories</span>
                        <span>Đọc từ đầu</span>
                      </Link>
                    )}

                    {latestChapter && latestChapter.id !== firstChapter?.id && (
                      <Link
                        to={`/read/${comic.source_type}/${encodeURIComponent(comic.id)}/${encodeURIComponent(latestChapter.id)}${demoSuffix}`}
                        state={{ comicTitle: comic.title, coverUrl: comic.cover_url }}
                        onMouseEnter={() => prefetchChapter(latestChapter.id)}
                        onFocus={() => prefetchChapter(latestChapter.id)}
                        className="flex items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-[13px] font-bold text-primary transition hover:bg-surface-container-high"
                      >
                        <span className="material-symbols-outlined text-[17px]">bolt</span>
                        <span>
                          Mới nhất
                          {latestChapter.chapter_number ? ` (${latestChapter.chapter_number})` : ''}
                        </span>
                      </Link>
                    )}

                    <button
                      type="button"
                      onClick={handleToggleFavorite}
                      className={`flex items-center justify-center gap-1 whitespace-nowrap rounded-lg border px-3 py-2 text-[13px] font-semibold transition ${
                        favorited
                          ? 'border-badge-hot-bg bg-badge-hot-bg text-white shadow-md shadow-badge-hot-bg/30'
                          : 'border-badge-hot-bg/35 bg-badge-hot-bg/15 text-secondary hover:bg-badge-hot-bg hover:text-white'
                      }`}
                    >
                      <span
                        className={`material-symbols-outlined text-[16px] ${
                          favorited ? 'material-symbols-filled' : ''
                        }`}
                      >
                        favorite
                      </span>
                      <span>{favorited ? 'Đang theo dõi' : 'Theo dõi'}</span>
                    </button>

                    {comic.source_type === 'local' && user?.is_admin && (
                      <button
                        type="button"
                        onClick={() => openUploadModal({ id: comic.id, title: comic.title })}
                        className="flex items-center gap-1 whitespace-nowrap rounded-lg border border-accent-green/40 bg-accent-green/15 px-3 py-2 text-[13px] font-semibold text-accent-green hover:bg-accent-green/25"
                      >
                        <span className="material-symbols-outlined text-[17px]">add</span>
                        <span>Thêm chương</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={handleShare}
                      title="Sao chép liên kết truyện"
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-surface-container text-outline transition hover:bg-surface-container-high hover:text-on-surface"
                    >
                      <span className="material-symbols-outlined text-[18px]">share</span>
                    </button>
                  </div>
                </div>
              </div>
            </section>

            {/* 4.2 TÓM TẮT NỘI DUNG CÓ NÚT XEM THÊM */}
            {comic.description && (
              <section className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface-card p-5 shadow-md sm:p-6">
                <div className="flex items-center gap-2 text-[17px] font-bold text-primary sm:text-[19px]">
                  <span className="material-symbols-outlined text-[21px]">auto_awesome</span>
                  <h2>Nội dung truyện {comic.title}</h2>
                </div>

                <div
                  className={`relative overflow-hidden text-[14px] leading-relaxed text-text-secondary transition-all duration-300 ${
                    synopsisExpanded ? 'max-h-[2000px]' : 'max-h-28'
                  }`}
                >
                  <p className="whitespace-pre-line">{comic.description}</p>
                  {!synopsisExpanded && comic.description.length > 220 && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-surface-card to-transparent" />
                  )}
                </div>

                {comic.description.length > 220 && (
                  <button
                    type="button"
                    onClick={() => setSynopsisExpanded((v) => !v)}
                    className="flex items-center gap-1 self-center rounded-lg border border-border-subtle bg-surface-container px-4 py-1.5 text-[13px] font-semibold text-primary transition hover:bg-surface-container-high"
                  >
                    <span>{synopsisExpanded ? 'Thu gọn nội dung' : 'Xem thêm nội dung'}</span>
                    <span className="material-symbols-outlined text-[18px]">
                      {synopsisExpanded ? 'expand_less' : 'expand_more'}
                    </span>
                  </button>
                )}
              </section>
            )}

            {/* 4.3 DANH SÁCH CHƯƠNG (3-Column Table Desktop + Cards Mobile + Live Search + Sort) */}
            <section className="flex flex-col gap-4 rounded-xl border border-border-subtle bg-surface-card p-4 shadow-md sm:p-6">
              <div className="flex flex-col items-start justify-between gap-3 pb-1 sm:flex-row sm:items-center">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[22px] text-primary">
                    format_list_bulleted
                  </span>
                  <h2 className="text-[18px] font-bold text-text-primary sm:text-[20px]">
                    Danh Sách Chương{' '}
                    <span className="text-[14px] font-normal text-outline">
                      ({comic.chapters.length} chương)
                    </span>
                  </h2>
                </div>

                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <div className="relative flex flex-1 items-center rounded-lg border border-border-subtle bg-surface-container sm:w-52">
                    <span className="material-symbols-outlined ml-2.5 text-[18px] text-outline">
                      filter_alt
                    </span>
                    <input
                      type="text"
                      value={chapterSearch}
                      onChange={(e) => setChapterSearch(e.target.value)}
                      placeholder="Tìm số chương..."
                      className="w-full bg-transparent px-2.5 py-1.5 text-[16px] text-on-surface placeholder:text-outline focus:outline-none sm:text-[13px]"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSortNewestFirst((v) => !v);
                      setSelectedRangeIdx(0);
                    }}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-border-subtle bg-surface-container px-3 py-1.5 text-[13px] font-semibold text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
                  >
                    <span className="material-symbols-outlined text-[16px]">swap_vert</span>
                    <span>{sortNewestFirst ? 'Mới nhất' : 'Cũ nhất'}</span>
                  </button>
                </div>
              </div>

              {/* Stitch Chapter Range Tabs (for long series > 100 chapters) */}
              {chapterRanges.length > 0 && !chapterSearch.trim() && (
                <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto pb-1">
                  <span className="font-label mr-1 shrink-0 text-[11px] font-bold uppercase text-outline">
                    Tập chương:
                  </span>
                  {chapterRanges.map((r, idx) => (
                    <button
                      key={r.label}
                      type="button"
                      onClick={() => setSelectedRangeIdx(idx)}
                      className={`font-label shrink-0 rounded-md px-2.5 py-1 text-[11px] font-bold transition ${
                        selectedRangeIdx === idx
                          ? 'bg-primary-container text-on-primary-container shadow-sm'
                          : 'border border-border-subtle bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Desktop 3-Column Table Header */}
              <div className="font-label hidden grid-cols-12 rounded-lg border border-border-subtle/50 bg-surface-container px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-text-secondary sm:grid">
                <div className="col-span-7">Số Chương</div>
                <div className="col-span-3">Cập Nhật</div>
                <div className="col-span-2 text-right">Lượt Xem</div>
              </div>

              {/* Chapter Rows */}
              {displayedChapters.length === 0 ? (
                <div className="py-8 text-center text-sm text-text-secondary">
                  Không tìm thấy chương nào phù hợp.
                </div>
              ) : (
                <div className="flex max-h-[560px] flex-col gap-1.5 overflow-y-auto pr-1">
                  {displayedChapters.map((ch, idx) => {
                    const isNew = latest3Ids.has(ch.id);
                    const isLastRead = lastReadChapterId === ch.id;
                    return (
                      <Link
                        key={ch.id}
                        to={`/read/${comic.source_type}/${encodeURIComponent(comic.id)}/${encodeURIComponent(ch.id)}${demoSuffix}`}
                        state={{ comicTitle: comic.title, coverUrl: comic.cover_url }}
                        onMouseEnter={() => prefetchChapter(ch.id)}
                        onTouchStart={() => prefetchChapter(ch.id)}
                        className={`chapter-row-contain group grid grid-cols-12 items-center rounded-lg px-3.5 py-2.5 text-[13px] transition-colors hover:bg-surface-card-hover sm:px-4 ${
                          idx % 2 === 0 ? 'bg-surface-container-low' : 'bg-surface-container/50'
                        }`}
                      >
                        <div className="col-span-10 flex min-w-0 items-center gap-2 sm:col-span-7">
                          <span
                            className={`truncate font-semibold transition-colors group-hover:text-primary ${
                              isLastRead ? 'text-accent-green' : 'text-text-primary'
                            }`}
                          >
                            {ch.title}
                          </span>
                          {isNew && (
                            <span className="font-label shrink-0 rounded bg-badge-hot-bg px-1.5 py-0.5 text-[10px] font-extrabold uppercase text-white">
                              MỚI
                            </span>
                          )}
                          {isLastRead && (
                            <span className="font-label shrink-0 rounded bg-accent-green/20 px-1.5 py-0.5 text-[10px] font-bold text-accent-green">
                              Đang nghe
                            </span>
                          )}
                        </div>

                        <div className="hidden text-text-secondary sm:col-span-3 sm:block">
                          {ch.updated_at || (ch.page_count ? `${ch.page_count} trang` : 'Mới cập nhật')}
                        </div>

                        <div className="font-label col-span-2 flex items-center justify-end gap-1 text-right text-text-secondary">
                          <span className="hidden sm:inline">{ch.views || '—'}</span>
                          <span className="material-symbols-outlined text-[18px] text-outline sm:hidden">
                            chevron_right
                          </span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Mobile Horizontal Similar Comics Slider */}
            {similarList.length > 0 && (
              <section className="rounded-xl border border-border-subtle/70 bg-surface-card p-4 lg:hidden">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[20px] text-tertiary">
                      recommend
                    </span>
                    <h3 className="text-[16px] font-bold text-text-primary">Truyện Đề Cử</h3>
                  </div>
                  <Link to="/" className="font-label text-[12px] font-semibold text-primary">
                    Xem tất cả
                  </Link>
                </div>
                <div className="no-scrollbar flex gap-3 overflow-x-auto pb-1">
                  {similarList.map((item) => (
                    <Link
                      key={`mob-sim-${item.id}`}
                      to={`/comic/${item.source_type}/${encodeURIComponent(item.id)}`}
                      className="group flex w-28 shrink-0 flex-col"
                    >
                      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl border border-border-subtle bg-surface-container">
                        {item.cover_url && (
                          <img
                            src={getMobileImageUrl(item.cover_url, 240, 74)}
                            alt={item.title}
                            loading="lazy"
                            className="h-full w-full object-cover transition group-hover:scale-105"
                          />
                        )}
                      </div>
                      <span className="mt-1.5 line-clamp-2 text-[12px] font-semibold leading-snug text-text-primary group-hover:text-primary">
                        {item.title}
                      </span>
                      <span className="font-label mt-0.5 truncate text-[11px] text-text-secondary">
                        {item.latest_chapter}
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* RIGHT SIDEBAR (4 cols — Stitch Detail Desktop Sidebar) */}
          <aside className="hidden flex-col gap-6 lg:col-span-4 lg:flex">
            {/* 4.5 BẢNG XẾP HẠNG TOP COMICS */}
            <div className="flex flex-col gap-4 rounded-xl border border-border-subtle bg-surface-card p-5 shadow-md">
              <div className="flex items-center gap-2 text-[17px] font-bold text-on-surface">
                <span className="material-symbols-outlined material-symbols-filled text-[22px] text-amber-400">
                  military_tech
                </span>
                <h3>Bảng Xếp Hạng</h3>
              </div>

              <div className="font-label grid grid-cols-3 gap-1 rounded-lg border border-border-subtle/50 bg-surface-container p-1 text-center text-[12px]">
                {[
                  { key: 'month' as const, label: 'Top Tháng' },
                  { key: 'week' as const, label: 'Top Tuần' },
                  { key: 'day' as const, label: 'Top Ngày' },
                ].map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setRankTab(t.key)}
                    className={`rounded py-1.5 transition-all ${
                      rankTab === t.key
                        ? 'bg-primary-container font-extrabold text-on-primary-container shadow-sm'
                        : 'font-semibold text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-col gap-2.5">
                {rankingList.slice(0, 6).map((item, idx) => {
                  const isCurrent = item.id === comic.id;
                  const rankBadge =
                    idx === 0
                      ? 'bg-gradient-to-tr from-amber-600 to-amber-300 text-on-primary'
                      : idx === 1
                        ? 'bg-gradient-to-tr from-slate-400 to-slate-200 text-surface-bg'
                        : idx === 2
                          ? 'bg-gradient-to-tr from-amber-800 to-amber-600 text-white'
                          : 'bg-surface-container text-text-secondary border border-border-subtle';

                  return (
                    <Link
                      key={`det-rank-${rankTab}-${item.id}`}
                      to={`/comic/${item.source_type}/${encodeURIComponent(item.id)}`}
                      className={`group flex items-center gap-3 rounded-lg border p-2 transition-colors hover:bg-surface-card-hover ${
                        isCurrent
                          ? 'border-primary/40 bg-surface-container/70'
                          : 'border-transparent hover:border-border-subtle'
                      }`}
                    >
                      <span
                        className={`font-label flex h-7 w-7 shrink-0 items-center justify-center rounded text-[13px] font-black shadow-sm ${rankBadge}`}
                      >
                        {String(idx + 1).padStart(2, '0')}
                      </span>
                      <div className="h-14 w-11 shrink-0 overflow-hidden rounded border border-border-subtle bg-surface-container">
                        {item.cover_url && (
                          <img
                            src={resolveBackendUrl(item.cover_url)}
                            alt={item.title}
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform group-hover:scale-105"
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4
                          className={`truncate text-[13px] font-bold transition-colors group-hover:text-primary ${
                            isCurrent ? 'text-primary' : 'text-on-surface'
                          }`}
                        >
                          {item.title}
                        </h4>
                        <p className="truncate text-[12px] text-text-secondary">
                          {item.latest_chapter || 'Đọc ngay'}
                        </p>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>

            {/* 4.6 ĐỀ CỬ NỔI BẬT */}
            {similarList.length > 0 && (
              <div className="flex flex-col gap-4 rounded-xl border border-border-subtle bg-surface-card p-5 shadow-md">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[17px] font-bold text-on-surface">
                    <span className="material-symbols-outlined text-[21px] text-tertiary">
                      recommend
                    </span>
                    <h3>Đề Cử Cho Bạn</h3>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {similarList.slice(0, 4).map((item) => (
                    <Link
                      key={`desk-sim-${item.id}`}
                      to={`/comic/${item.source_type}/${encodeURIComponent(item.id)}`}
                      className="group flex flex-col overflow-hidden rounded-lg border border-border-subtle/70 bg-surface-container-low transition hover:border-primary/40"
                    >
                      <div className="relative aspect-[2/3] w-full overflow-hidden bg-surface-container">
                        {item.cover_url && (
                          <img
                            src={resolveBackendUrl(item.cover_url)}
                            alt={item.title}
                            loading="lazy"
                            className="h-full w-full object-cover transition group-hover:scale-105"
                          />
                        )}
                      </div>
                      <div className="p-2">
                        <h4 className="line-clamp-1 text-[12px] font-bold text-text-primary group-hover:text-primary">
                          {item.title}
                        </h4>
                        <span className="font-label text-[11px] text-text-secondary">
                          {item.latest_chapter}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}
