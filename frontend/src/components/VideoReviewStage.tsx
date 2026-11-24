import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Loader2, Maximize2, Minimize2, Play, Volume2 } from 'lucide-react';
import { getMobileImageUrl } from '../lib/mobileImage';
import type { NarrationEngine, NarrationMode } from '../types';

export interface VideoReviewStageHandle {
  setProgress: (sceneFrac: number, overallPct: number) => void;
}

interface VideoReviewStageProps {
  pages: string[];
  activePage: number;
  isPlaying: boolean;
  isLoadingAudio: boolean;
  isSyncingNext: boolean;
  subtitleText: string;
  showSubtitles: boolean;
  mode: NarrationMode;
  engine?: NarrationEngine;
  demoMode: boolean;
  chapterTitle: string;
  comicTitle: string;
  onTogglePlay: () => void;
  onSelectPage: (idx: number) => void;
  onPrevScene?: () => void;
  onNextScene?: () => void;
}

export const VideoReviewStage = memo(
  forwardRef<VideoReviewStageHandle, VideoReviewStageProps>(function VideoReviewStage(
    {
      pages,
      activePage,
      isPlaying,
      isLoadingAudio,
      isSyncingNext,
      subtitleText,
      showSubtitles,
      mode,
      engine = 'ocr',
      demoMode,
      chapterTitle,
      comicTitle,
      onTogglePlay,
      onSelectPage,
      onPrevScene,
      onNextScene,
    },
    ref
  ) {
    const stageRef = useRef<HTMLDivElement | null>(null);
    const imgRef = useRef<HTMLImageElement | null>(null);
    const stageProgressBarRef = useRef<HTMLDivElement | null>(null);
    const activeSceneBtnRef = useRef<HTMLButtonElement | null>(null);
    const touchStartRef = useRef<{ x: number; y: number } | null>(null);
    const lastSwipeAtRef = useRef(0);

    const stageHeightRef = useRef(540);
    const imgHeightRef = useRef(540);
    const lastSceneFracRef = useRef(0);
    const [isFullscreen, setIsFullscreen] = useState(false);

    // Crossfade transition between scenes + mobile WebP resized display URLs
    const currentUrl = pages[activePage] || '';
    const displayUrl = getMobileImageUrl(currentUrl, 720, 74);
    const backdropUrl = displayUrl;
    const [loadedUrl, setLoadedUrl] = useState('');
    const imgLoaded = Boolean(displayUrl && loadedUrl === displayUrl);
    const [prevUrl, setPrevUrl] = useState<string | null>(null);
    const prevDisplayUrl = prevUrl ? getMobileImageUrl(prevUrl, 720, 74) : null;
    const [fadingIn, setFadingIn] = useState(false);
    const lastUrlRef = useRef(currentUrl);

    const applySceneTransform = (sceneFrac: number) => {
      const clamped = Math.min(1, Math.max(0, sceneFrac));
      lastSceneFracRef.current = clamped;
      const img = imgRef.current;
      if (!img) return;
      const stH = stageHeightRef.current || 540;
      const imH = imgHeightRef.current || stH;
      const overflowPx = Math.max(0, imH - stH);

      if (overflowPx > 12) {
        img.style.transformOrigin = 'top center';
        img.style.transform = `translate3d(0, ${(-clamped * overflowPx).toFixed(2)}px, 0)`;
      } else {
        const centerY = Math.max(0, (stH - imH) / 2);
        const zoom = 1 + clamped * 0.055;
        img.style.transformOrigin = 'center center';
        img.style.transform = `translate3d(0, ${centerY.toFixed(2)}px, 0) scale(${zoom.toFixed(4)})`;
      }
    };

    const applyProgressBar = (overallPct: number) => {
      if (!stageProgressBarRef.current) return;
      const frac = Math.min(1, Math.max(0, overallPct / 100));
      stageProgressBarRef.current.style.transform = `scaleX(${frac.toFixed(4)})`;
    };

    useImperativeHandle(
      ref,
      () => ({
        setProgress: (sceneFrac: number, overallPct: number) => {
          applySceneTransform(sceneFrac);
          applyProgressBar(overallPct);
        },
      }),
      []
    );

    useEffect(() => {
      imgHeightRef.current = stageHeightRef.current || 540;
      lastSceneFracRef.current = 0;
      applySceneTransform(0);
      if (currentUrl && lastUrlRef.current && currentUrl !== lastUrlRef.current) {
        setPrevUrl(lastUrlRef.current);
        setFadingIn(true);
        const t = window.setTimeout(() => {
          setPrevUrl(null);
          setFadingIn(false);
        }, 380);
        lastUrlRef.current = currentUrl;
        return () => window.clearTimeout(t);
      }
      lastUrlRef.current = currentUrl;
    }, [currentUrl, activePage, pages.length]);

    useEffect(() => {
      if (displayUrl && imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
        setLoadedUrl(displayUrl);
      }
    }, [displayUrl]);

    // Defer preloading upcoming images until active frame finishes loading (or 350ms max)
    useEffect(() => {
      const preloadCount = typeof window !== 'undefined' && window.innerWidth < 640 ? 3 : 5;
      const upcoming = pages.slice(activePage + 1, activePage + 1 + preloadCount);
      if (upcoming.length === 0) return;

      let fired = false;
      const runPreload = () => {
        if (fired) return;
        fired = true;
        upcoming.forEach((src) => {
          const img = new Image();
          img.src = getMobileImageUrl(src, 720, 74);
        });
      };

      if (imgLoaded) {
        runPreload();
        return;
      }
      const timer = window.setTimeout(runPreload, 350);
      return () => window.clearTimeout(timer);
    }, [pages, activePage, imgLoaded]);

    // Auto-scroll active scene button smoothly into view inside the horizontal scene strip
    useEffect(() => {
      activeSceneBtnRef.current?.scrollIntoView({
        behavior: 'smooth',
        inline: 'center',
        block: 'nearest',
      });
    }, [activePage]);

    // Observe stage & foreground image dimensions without triggering React state updates
    useEffect(() => {
      const measure = () => {
        if (stageRef.current) {
          stageHeightRef.current = stageRef.current.clientHeight || 540;
        }
        if (imgRef.current) {
          imgHeightRef.current = imgRef.current.clientHeight || stageHeightRef.current;
        }
        applySceneTransform(lastSceneFracRef.current);
      };
      measure();
      const ro = new ResizeObserver(measure);
      if (stageRef.current) ro.observe(stageRef.current);
      if (imgRef.current) ro.observe(imgRef.current);
      return () => ro.disconnect();
    }, [currentUrl, isFullscreen]);

    useEffect(() => {
      const onFsChange = () => {
        setIsFullscreen(Boolean(document.fullscreenElement));
      };
      document.addEventListener('fullscreenchange', onFsChange);
      return () => document.removeEventListener('fullscreenchange', onFsChange);
    }, []);

    const toggleFullscreen = (e: React.MouseEvent) => {
      e.stopPropagation();
      const el = stageRef.current;
      if (!el) return;
      if (!document.fullscreenElement) {
        void el.requestFullscreen?.().catch(() => {});
      } else {
        void document.exitFullscreen?.().catch(() => {});
      }
    };

    return (
      <div className="mx-auto w-full max-w-5xl px-2 pt-3 sm:px-4 sm:pt-5">
        {/* 16:9 Cinema Review Stage with Blurred Pillarbox Backdrop */}
        <div
          ref={stageRef}
          onTouchStart={(e) => {
            if (e.touches.length === 1) {
              touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            }
          }}
          onTouchEnd={(e) => {
            const start = touchStartRef.current;
            touchStartRef.current = null;
            if (!start || e.changedTouches.length === 0) return;
            const dx = e.changedTouches[0].clientX - start.x;
            const dy = e.changedTouches[0].clientY - start.y;
            if (Math.abs(dx) >= 50 && Math.abs(dy) < 48) {
              lastSwipeAtRef.current = Date.now();
              if (dx < 0) onNextScene?.();
              else onPrevScene?.();
            }
          }}
          onClick={() => {
            if (Date.now() - lastSwipeAtRef.current < 350) return;
            onTogglePlay();
          }}
          role="region"
          aria-label="Khung xem Video Review 16:9"
          className={`group relative w-full cursor-pointer select-none overflow-hidden bg-black shadow-[0_24px_60px_rgba(0,0,0,0.75)] ring-1 ring-border-subtle/70 ${
            isFullscreen
              ? 'h-screen rounded-none'
              : 'h-[56dvh] min-h-[340px] max-h-[540px] rounded-2xl sm:h-auto sm:min-h-0 sm:max-h-none sm:aspect-video'
          }`}
        >
          {/* Blurred Pillarbox Background isolated onto its own GPU layer */}
          {backdropUrl && (
            <img
              src={backdropUrl}
              alt=""
              aria-hidden="true"
              decoding="async"
              {...({ fetchpriority: 'low' } as Record<string, string>)}
              style={{ contain: 'strict' }}
              className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-50 blur-xl brightness-[0.42] transition-opacity duration-500 will-change-[opacity] [transform:translateZ(0)] sm:blur-2xl"
            />
          )}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/70" />

          {/* Outgoing scene for smooth crossfade */}
          {prevDisplayUrl && (
            <div
              className={`pointer-events-none absolute inset-0 flex justify-center overflow-hidden transition-opacity duration-300 ${
                fadingIn ? 'opacity-0' : 'opacity-100'
              }`}
            >
              <img
                src={prevDisplayUrl}
                alt=""
                aria-hidden="true"
                decoding="async"
                className="h-auto w-[96%] max-w-[560px] object-contain sm:w-[58%]"
              />
            </div>
          )}

          {/* Active Foreground Panel with GPU-accelerated Pan / Ken Burns */}
          <div className="relative z-10 flex h-full w-full justify-center overflow-hidden">
            <div
              className={`relative h-full w-[96%] max-w-[560px] transition-opacity duration-300 sm:w-[58%] ${
                isFullscreen ? 'max-w-[680px]' : ''
              }`}
            >
              {!imgLoaded && displayUrl && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 animate-pulse rounded-sm bg-surface-container/75"
                />
              )}
              {displayUrl && (
                <img
                  ref={imgRef}
                  key={displayUrl}
                  src={displayUrl}
                  alt={`Trang ${activePage + 1}`}
                  decoding="async"
                  {...({ fetchpriority: 'high' } as Record<string, string>)}
                  onLoad={() => {
                    setLoadedUrl(displayUrl);
                    if (imgRef.current) {
                      imgHeightRef.current = imgRef.current.clientHeight || stageHeightRef.current;
                      applySceneTransform(lastSceneFracRef.current);
                    }
                  }}
                  onError={() => {
                    setLoadedUrl(displayUrl);
                  }}
                  style={{ transform: 'translate3d(0, 0, 0)', willChange: 'transform' }}
                  className="block h-auto w-full rounded-sm shadow-[0_0_40px_rgba(0,0,0,0.85)]"
                />
              )}
            </div>
          </div>

          {/* Top Info Overlay (title + live sync badge + fullscreen button) */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-2 bg-gradient-to-b from-black/80 via-black/35 to-transparent px-3.5 py-3 transition-opacity duration-200 sm:px-5"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-label inline-flex shrink-0 items-center gap-1.5 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur-md">
                <span
                  className={`h-2 w-2 rounded-full ${
                    isSyncingNext
                      ? 'animate-pulse bg-tertiary'
                      : isPlaying
                        ? 'animate-pulse bg-accent-green'
                        : 'bg-outline'
                  }`}
                />
                <span>
                  Cảnh {activePage + 1}/{pages.length}
                </span>
              </span>
              <span className="truncate text-[11px] font-semibold text-white/90 sm:text-xs">
                {comicTitle}
                <span className="hidden sm:inline"> • {chapterTitle}</span>
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <span className="font-label hidden rounded-full bg-black/60 px-2.5 py-1 text-[10px] font-semibold text-white/85 backdrop-blur-md md:inline-flex md:items-center md:gap-1">
                <Volume2 className="h-3 w-3 text-accent-green" />
                {isSyncingNext
                  ? 'Đang tải cảnh kế...'
                  : engine === 'ocr'
                    ? 'OCR • Giọng Google'
                    : mode === 'storytelling'
                      ? 'Review kể chuyện'
                      : 'Đọc sát thoại'}
                {demoMode ? ' (Thử)' : ''}
              </span>

              <button
                type="button"
                onClick={toggleFullscreen}
                title={isFullscreen ? 'Thoát toàn màn hình' : 'Xem toàn màn hình'}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/60 text-white backdrop-blur-md transition hover:bg-primary-container hover:text-on-primary-container"
              >
                {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* Center Play / Loading Overlay when paused or buffering first scene */}
          {(!isPlaying || isLoadingAudio) && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/25">
              <div className="flex flex-col items-center gap-2.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePlay();
                  }}
                  aria-label="Phát Video Review"
                  className="pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary-container/95 text-on-primary-container shadow-[0_0_30px_rgba(0,140,238,0.55)] backdrop-blur-md transition-transform hover:scale-105 active:scale-95"
                >
                  {isLoadingAudio ? (
                    <Loader2 className="h-7 w-7 animate-spin" />
                  ) : (
                    <Play className="ml-0.5 h-7 w-7 fill-current" />
                  )}
                </button>
                {isLoadingAudio && (
                  <span className="font-label rounded-full bg-black/75 px-3 py-1 text-[11px] font-semibold text-white shadow-lg backdrop-blur-md">
                    {engine === 'ocr'
                      ? 'Đang quét chữ & tạo giọng Google...'
                      : 'AI đang đọc tranh & tạo giọng...'}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* YouTube-style CC Subtitle Box inside bottom of frame */}
          {showSubtitles && subtitleText && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="pointer-events-none absolute inset-x-0 bottom-3.5 z-20 flex justify-center px-3 sm:bottom-6 sm:px-8"
            >
              <div className="no-scrollbar pointer-events-auto max-h-[96px] max-w-2xl overflow-y-auto rounded-lg bg-black/82 px-3.5 py-2 text-center shadow-xl backdrop-blur-sm sm:max-h-[120px] sm:px-4">
                <p className="text-xs font-medium leading-relaxed text-white sm:text-[15px]">
                  {subtitleText}
                </p>
              </div>
            </div>
          )}

          {/* Thin GPU-composited Progress Bar along bottom edge of stage */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-1 overflow-hidden bg-white/15">
            <div
              ref={stageProgressBarRef}
              className="h-full w-full origin-left bg-gradient-to-r from-badge-new-bg via-primary to-accent-green will-change-transform"
              style={{ transform: 'scaleX(0)' }}
            />
          </div>
        </div>

        {/* Compact Chapter Scene Selector Bar below stage */}
        <div className="mt-3 rounded-xl border border-border-subtle/70 bg-surface-card/90 p-3">
          <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-text-secondary">
            <span className="font-label truncate font-bold uppercase tracking-wider text-text-primary">
              Cảnh trong {chapterTitle}
            </span>
            <span className="font-label shrink-0 sm:hidden">
              Vuốt trái/phải đổi cảnh • {activePage + 1}/{pages.length}
            </span>
            <span className="font-label hidden shrink-0 sm:inline">
              Bấm số cảnh để tua nhanh • {activePage + 1}/{pages.length}
            </span>
          </div>
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1">
            {pages.map((_, idx) => {
              const active = idx === activePage;
              return (
                <button
                  key={idx}
                  ref={active ? activeSceneBtnRef : undefined}
                  type="button"
                  onClick={() => onSelectPage(idx)}
                  className={`font-label min-h-[38px] min-w-[38px] shrink-0 rounded-lg px-2 py-1.5 text-xs font-bold transition active:scale-95 ${
                    active
                      ? 'bg-primary-container text-on-primary-container shadow-sm ring-1 ring-primary'
                      : idx < activePage
                        ? 'bg-surface-container-high/80 text-primary hover:bg-surface-container-high'
                        : 'bg-surface-container text-text-secondary hover:bg-surface-container-high hover:text-text-primary'
                  }`}
                >
                  {idx + 1}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  })
);
