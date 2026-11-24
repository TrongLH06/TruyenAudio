import { memo } from 'react';
import { BookOpen } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { getMobileImageUrl } from '../lib/mobileImage';
import type { ComicSummary } from '../types';

const SOURCE_BADGE: Record<
  ComicSummary['source_type'],
  { label: string; cls: string }
> = {
  local: { label: 'KHO MÁY', cls: 'bg-accent-green text-white' },
  hinettruyen: { label: 'NETTRUYEN', cls: 'bg-badge-new-bg text-white' },
  otruyen: { label: 'HOT', cls: 'bg-badge-hot-bg text-white' },
  mangadex: { label: 'QUỐC TẾ', cls: 'bg-tertiary-container text-white' },
};

export const ComicCard = memo(function ComicCard({
  comic,
  badgeOverride,
  compact = false,
  priority = false,
}: {
  comic: ComicSummary;
  badgeOverride?: { label: string; cls: string };
  compact?: boolean;
  priority?: boolean;
}) {
  const badge = badgeOverride || SOURCE_BADGE[comic.source_type];
  const coverSrc = getMobileImageUrl(comic.cover_url, 360, 76);

  const handlePrefetch = () => {
    void api.getComicDetail(comic.source_type, comic.id).catch(() => {});
  };

  return (
    <Link
      to={`/comic/${comic.source_type}/${encodeURIComponent(comic.id)}`}
      onMouseEnter={handlePrefetch}
      onFocus={handlePrefetch}
      onTouchStart={handlePrefetch}
      className={`${
        compact ? '' : 'comic-card-contain '
      }group flex flex-col overflow-hidden rounded-xl border border-border-subtle/70 bg-surface-card shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary-container/50 hover:bg-surface-card-hover hover:shadow-xl active:scale-[0.98]`}
    >
      <div
        className={`relative w-full overflow-hidden bg-surface-container-high ${
          compact ? 'aspect-[2/3]' : 'aspect-[3/4]'
        }`}
      >
        {comic.cover_url ? (
          <img
            src={coverSrc}
            alt={comic.title}
            loading={priority ? 'eager' : 'lazy'}
            {...({ fetchpriority: priority ? 'high' : 'auto' } as Record<string, string>)}
            decoding="async"
            className="h-full w-full object-cover object-center transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-outline">
            <BookOpen className="h-10 w-10" />
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-surface-bg/95 via-transparent to-black/35" />

        <span
          className={`font-label absolute left-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider shadow ${badge.cls}`}
        >
          {badge.label}
        </span>

        {compact ? (
          <div className="absolute bottom-2 left-2 right-2 flex flex-col">
            <span className="font-label truncate text-[11px] font-semibold text-primary drop-shadow">
              {comic.latest_chapter || (comic.chapter_count ? `${comic.chapter_count} chương` : 'Đọc ngay')}
            </span>
            <span className="text-[10px] text-text-secondary">
              {comic.source_type === 'local' ? 'Nghe AI tự lướt' : comic.language.toUpperCase()}
            </span>
          </div>
        ) : (
          <div className="font-label absolute bottom-2 left-2 right-2 flex items-center justify-between text-[11px] text-text-secondary">
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-[13px] text-primary">headphones</span>
              <span>AI Voice</span>
            </span>
            <span className="rounded bg-black/50 px-1.5 py-0.5 text-[10px] uppercase text-on-surface-variant">
              {comic.language || 'VI'}
            </span>
          </div>
        )}
      </div>

      <div
        className={
          compact
            ? 'p-2 sm:p-2.5'
            : 'flex flex-1 flex-col justify-between gap-1.5 p-2.5 sm:gap-2 sm:p-3'
        }
      >
        <h3
          className={`font-bold leading-snug text-text-primary transition-colors group-hover:text-primary ${
            compact ? 'line-clamp-1 text-[13px]' : 'line-clamp-2 text-[14px]'
          }`}
        >
          {comic.title}
        </h3>

        {!compact && (
          <div className="flex items-center justify-between border-t border-border-subtle/50 pt-2 text-[12px]">
            <span className="font-label truncate font-semibold text-primary">
              {comic.latest_chapter ||
                (comic.chapter_count > 0 ? `${comic.chapter_count} chương` : 'Xem chương')}
            </span>
            <span className="shrink-0 text-[11px] text-outline">
              {comic.source_type === 'local' ? 'Cục bộ' : 'Online'}
            </span>
          </div>
        )}
      </div>
    </Link>
  );
});
