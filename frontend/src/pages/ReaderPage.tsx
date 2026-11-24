import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, RefreshCw, Sparkles, Volume2 } from 'lucide-react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ReaderControls, type ReaderControlsHandle } from '../components/ReaderControls';
import { VideoReviewStage, type VideoReviewStageHandle } from '../components/VideoReviewStage';
import { useAuth } from '../context/AuthContext';
import { api, ApiError, resolveBackendUrl } from '../lib/api';
import { getMobileImageUrl } from '../lib/mobileImage';
import {
  loadReaderPrefs,
  saveReaderPrefs,
  upsertLocalHistory,
  type ReaderViewMode,
  type StripWidth,
} from '../lib/localPrefs';
import type {
  ChapterItem,
  ChapterPagesResponse,
  NarrationEngine,
  NarrationMode,
  PageNarrationResponse,
  SourceType,
  VoiceId,
} from '../types';

// Keep voice steady and clear up to 2x while continuous scrolling scales smoothly up to 10x.
const MAX_COMFORTABLE_VOICE_RATE = 2;
const BASE_SCROLL_PX_PER_SEC = 78;
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

function getSafeAudioRate(speed: number): number {
  return Math.min(MAX_COMFORTABLE_VOICE_RATE, Math.max(0.5, speed));
}

const ComicPageImage = memo(function ComicPageImage({
  src,
  alt,
  eager,
  onLoaded,
}: {
  src: string;
  alt: string;
  eager: boolean;
  onLoaded?: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  return (
    <div className="relative min-h-[260px] w-full bg-surface-container-lowest">
      {!loaded && !failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-container-low">
          <div className="flex flex-col items-center gap-2 text-outline">
            <Loader2 className="h-6 w-6 animate-spin text-primary/70" />
            <span className="font-label text-[11px]">Đang tải {alt}...</span>
          </div>
        </div>
      )}

      {failed ? (
        <div className="flex min-h-[300px] flex-col items-center justify-center gap-3 bg-surface-container-low p-6 text-center">
          <p className="text-xs text-text-secondary">Không thể tải {alt}.</p>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setFailed(false);
              setLoaded(false);
              setRetryKey((k) => k + 1);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-surface-container-high px-3.5 py-2 text-xs font-semibold text-primary hover:bg-primary-container hover:text-on-primary-container"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Tải lại ảnh</span>
          </button>
        </div>
      ) : (
        <img
          key={`${src}-${retryKey}`}
          src={retryKey > 0 ? `${src}${src.includes('?') ? '&' : '?'}r=${retryKey}` : src}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onLoad={() => {
            setLoaded(true);
            onLoaded?.();
          }}
          onError={() => setFailed(true)}
          className={`mx-auto block w-full select-none object-contain transition-opacity duration-300 ${
            loaded ? 'opacity-100' : 'opacity-0'
          }`}
        />
      )}
    </div>
  );
});

export function ReaderPage() {
  const { sourceType, comicId, chapterId } = useParams<{
    sourceType: SourceType;
    comicId: string;
    chapterId: string;
  }>();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, openAuthModal, openSettingsModal } = useAuth();

  const initialPrefs = useRef(loadReaderPrefs()).current;

  const navState = (location.state as { comicTitle?: string; coverUrl?: string } | null) || null;
  const [comicTitle, setComicTitle] = useState(navState?.comicTitle || '');
  const [coverUrl, setCoverUrl] = useState(navState?.coverUrl || '');
  const [allChapters, setAllChapters] = useState<ChapterItem[]>([]);
  const [favorited, setFavorited] = useState(false);

  const [chapter, setChapter] = useState<ChapterPagesResponse | null>(null);
  const [loadingChapter, setLoadingChapter] = useState(true);
  const [chapterError, setChapterError] = useState('');

  // Display controls (persisted)
  const [stripWidth, setStripWidth] = useState<StripWidth>(initialPrefs.stripWidth);
  const [viewMode, setViewMode] = useState<ReaderViewMode>(initialPrefs.viewMode);
  const [theaterMode, setTheaterMode] = useState(false);
  const [immersiveHideTop, setImmersiveHideTop] = useState(false);

  // Playback & Lazy Reader states (persisted)
  const initialPage = Math.max(0, Number(searchParams.get('page') || 0));
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [narratingPage, setNarratingPage] = useState(initialPage);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPausedMidPage, setIsPausedMidPage] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [isSyncingNext, setIsSyncingNext] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(initialPrefs.playbackRate);
  const [mode, setMode] = useState<NarrationMode>(initialPrefs.mode);
  const [engine, setEngine] = useState<NarrationEngine>(initialPrefs.engine);
  const [voice, setVoice] = useState<VoiceId>(initialPrefs.voice);
  const [demoMode, setDemoMode] = useState(searchParams.get('demo') === '1');
  const [autoScroll, setAutoScroll] = useState(initialPrefs.autoScroll);
  const [showSubtitles, setShowSubtitles] = useState(initialPrefs.showSubtitles);
  const [subtitleText, setSubtitleText] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [needsKeyPrompt, setNeedsKeyPrompt] = useState(false);

  // Sleep timer
  const [sleepMinutesSelected, setSleepMinutesSelected] = useState(0);
  const [sleepSecondsLeft, setSleepSecondsLeft] = useState<number | null>(null);

  // Refs for continuous 60fps smooth top-to-bottom scrolling & zero-reflow metrics cache
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const videoStageRef = useRef<VideoReviewStageHandle | null>(null);
  const controlsRef = useRef<ReaderControlsHandle | null>(null);
  const pageMetricsRef = useRef<{
    stripStartY: number;
    stripMaxY: number;
    items: Array<{ top: number; height: number; bottom: number }>;
  }>({ stripStartY: 0, stripMaxY: 0, items: [] });
  const metricsTimerRef = useRef<number | null>(null);
  const nextChapterPrefetchedRef = useRef(false);
  const deckARef = useRef<HTMLAudioElement | null>(null);
  const deckBRef = useRef<HTMLAudioElement | null>(null);
  const activeDeckIdxRef = useRef<0 | 1>(0);
  const standbyPreparedRef = useRef<{
    memKey: string;
    audioUrl: string;
    deckIdx: 0 | 1;
  } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stallTimerRef = useRef<number | null>(null);
  const stallFallbackTimerRef = useRef<number | null>(null);
  const audioUnlockedRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const fadeRafRef = useRef<number | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const scrollYFloatRef = useRef(0);
  const scrollVelocityRef = useRef(BASE_SCROLL_PX_PER_SEC);
  const pageAnchorStartRef = useRef<number | null>(null);
  const sceneProgressRef = useRef(0);
  const sceneAdvanceTriggeredRef = useRef(false);
  const viewModeRef = useRef<ReaderViewMode>(viewMode);
  const totalPagesRef = useRef(0);
  const narratingPageRef = useRef(initialPage);
  const currentPageRef = useRef(initialPage);
  const voiceStartedAtRef = useRef(0);
  const audioWaitingRef = useRef(false);
  const fastCatchupInFlightRef = useRef(false);
  const activeSessionConfigRef = useRef<{
    useDemo: boolean;
    useMode: NarrationMode;
    useEngine: NarrationEngine;
    useVoice: VoiceId;
  }>({
    useDemo: false,
    useMode: initialPrefs.mode,
    useEngine: initialPrefs.engine,
    useVoice: initialPrefs.voice,
  });
  const speakPageRef = useRef<
    | ((
        mySession: number,
        pageIdx: number,
        useDemo: boolean,
        useMode: NarrationMode,
        useEngine: NarrationEngine,
        useVoice: VoiceId,
        isFirstInSession: boolean
      ) => Promise<void>)
    | null
  >(null);
  const playSessionRef = useRef(0);
  const isPlayingRef = useRef(false);
  const autoScrollRef = useRef(autoScroll);
  const playbackRateRef = useRef(playbackRate);
  const engineRef = useRef<NarrationEngine>(engine);
  const voiceRef = useRef<VoiceId>(voice);
  const narrationCacheRef = useRef<Map<string, PageNarrationResponse>>(new Map());
  const inFlightNarrationRef = useRef<Map<string, Promise<PageNarrationResponse>>>(new Map());
  const fallbackNotifiedRef = useRef(false);
  const translatedNotifiedRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);

  // Mid-page resume context (keeps exact audio position & session settings)
  const activePlaybackRef = useRef<{
    pageIdx: number;
    useDemo: boolean;
    useMode: NarrationMode;
    useEngine: NarrationEngine;
    useVoice: VoiceId;
    usingAudio: boolean;
    durationMs: number;
    remainingMs: number;
    onComplete: () => void;
  } | null>(null);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    autoScrollRef.current = autoScroll;
    saveReaderPrefs({ autoScroll });
  }, [autoScroll]);

  useEffect(() => {
    saveReaderPrefs({ showSubtitles });
  }, [showSubtitles]);

  useEffect(() => {
    saveReaderPrefs({ stripWidth });
  }, [stripWidth]);

  useEffect(() => {
    viewModeRef.current = viewMode;
    saveReaderPrefs({ viewMode });
  }, [viewMode]);

  useEffect(() => {
    totalPagesRef.current = chapter?.pages.length || 0;
  }, [chapter]);

  // Background prefetch next chapter pages once past 60% of current chapter
  useEffect(() => {
    if (!chapter || !sourceType || !comicId || !chapter.next_chapter_id) return;
    if (nextChapterPrefetchedRef.current) return;
    if (chapter.pages.length > 0 && currentPage >= Math.floor(chapter.pages.length * 0.6)) {
      nextChapterPrefetchedRef.current = true;
      void api.getChapterPages(sourceType, comicId, chapter.next_chapter_id).catch(() => {});
    }
  }, [chapter, sourceType, comicId, currentPage]);

  useEffect(() => {
    saveReaderPrefs({ mode });
  }, [mode]);

  useEffect(() => {
    engineRef.current = engine;
    saveReaderPrefs({ engine });
  }, [engine]);

  useEffect(() => {
    voiceRef.current = voice;
    saveReaderPrefs({ voice });
  }, [voice]);

  useEffect(() => {
    playbackRateRef.current = playbackRate;
    saveReaderPrefs({ playbackRate });
    if (audioRef.current) {
      audioRef.current.playbackRate = getSafeAudioRate(playbackRate);
      (audioRef.current as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    }
  }, [playbackRate]);

  const getDeck = useCallback((idx: 0 | 1): HTMLAudioElement => {
    const targetRef = idx === 0 ? deckARef : deckBRef;
    if (!targetRef.current) {
      const a = new Audio();
      a.preload = 'auto';
      (a as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
      targetRef.current = a;
    }
    return targetRef.current;
  }, []);

  const clearAudioDeck = useCallback((a: HTMLAudioElement | null) => {
    if (!a) return;
    a.pause();
    a.onended = null;
    a.onerror = null;
    a.onwaiting = null;
    a.onstalled = null;
    a.onplaying = null;
    a.ontimeupdate = null;
    a.volume = 1;
  }, []);

  const clearStallTimers = useCallback(() => {
    if (stallTimerRef.current !== null) {
      window.clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
    if (stallFallbackTimerRef.current !== null) {
      window.clearTimeout(stallFallbackTimerRef.current);
      stallFallbackTimerRef.current = null;
    }
  }, []);

  // Synchronously prime BOTH dual audio decks inside user tap gesture so mobile autoplay never blocks swaps
  const unlockAudio = useCallback(() => {
    if (audioUnlockedRef.current && deckARef.current && deckBRef.current) return;
    const decks: HTMLAudioElement[] = [getDeck(0), getDeck(1)];
    audioRef.current = getDeck(activeDeckIdxRef.current);
    Promise.all(
      decks.map((deck) => {
        try {
          deck.muted = false;
          deck.volume = 1;
          deck.src = SILENT_WAV_DATA_URI;
          const p = deck.play();
          if (p && typeof p.then === 'function') {
            return p
              .then(() => {
                deck.pause();
                deck.currentTime = 0;
                return true;
              })
              .catch(() => false);
          }
        } catch {
          // ignore
        }
        return Promise.resolve(false);
      })
    ).then((results) => {
      if (results.every(Boolean)) {
        audioUnlockedRef.current = true;
      }
    });
  }, [getDeck]);

  const showToast = useCallback((msg: string, ms = 3000) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  // Smooth 180ms audio volume ramp to eliminate harsh clicks/pops when starting or crossfading
  const fadeAudioVolume = useCallback(
    (audio: HTMLAudioElement, fromVol: number, toVol: number, durationMs = 180): Promise<void> => {
      if (fadeRafRef.current !== null) {
        cancelAnimationFrame(fadeRafRef.current);
        fadeRafRef.current = null;
      }
      return new Promise((resolve) => {
        const start = performance.now();
        audio.volume = Math.min(1, Math.max(0, fromVol));
        const step = (now: number) => {
          const t = Math.min(1, (now - start) / Math.max(1, durationMs));
          audio.volume = Math.min(1, Math.max(0, fromVol + (toVol - fromVol) * t));
          if (t < 1) {
            fadeRafRef.current = requestAnimationFrame(step);
          } else {
            fadeRafRef.current = null;
            resolve();
          }
        };
        fadeRafRef.current = requestAnimationFrame(step);
      });
    },
    []
  );

  // Precompute all page positions outside the 60fps RAF loop (zero layout thrashing!)
  const recomputePageMetrics = useCallback(() => {
    const pages = pageRefs.current;
    if (!pages.length) {
      pageMetricsRef.current = { stripStartY: 0, stripMaxY: 0, items: [] };
      return;
    }
    const scrollYNow = window.scrollY;
    const headerOffset = 68;
    const items: Array<{ top: number; height: number; bottom: number }> = [];
    for (let i = 0; i < pages.length; i += 1) {
      const el = pages[i];
      if (!el) {
        const prevBottom = items.length > 0 ? items[items.length - 1].bottom : 0;
        items.push({ top: prevBottom, height: 1100, bottom: prevBottom + 1100 });
        continue;
      }
      const top = el.getBoundingClientRect().top + scrollYNow;
      const height = el.offsetHeight || 1100;
      items.push({ top, height, bottom: top + height });
    }
    const stripStartY = items.length > 0 ? Math.max(0, items[0].top - headerOffset) : 0;
    const last = items[items.length - 1];
    const stripMaxY = last
      ? Math.max(stripStartY, last.bottom - window.innerHeight + 170)
      : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

    pageMetricsRef.current = { stripStartY, stripMaxY, items };
  }, []);

  const scheduleRecomputeMetrics = useCallback(() => {
    if (metricsTimerRef.current !== null) return;
    metricsTimerRef.current = window.setTimeout(() => {
      metricsTimerRef.current = null;
      recomputePageMetrics();
    }, 80);
  }, [recomputePageMetrics]);

  // Recompute cached page vertical metrics on scroll layout changes / resize
  useEffect(() => {
    if (!chapter || loadingChapter || viewMode !== 'scroll') return;
    const t = window.setTimeout(recomputePageMetrics, 80);
    window.addEventListener('resize', scheduleRecomputeMetrics);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', scheduleRecomputeMetrics);
      if (metricsTimerRef.current !== null) {
        window.clearTimeout(metricsTimerRef.current);
        metricsTimerRef.current = null;
      }
    };
  }, [chapter, loadingChapter, viewMode, stripWidth, recomputePageMetrics, scheduleRecomputeMetrics]);

  // Exact seamless vertical anchors read directly from cached metrics (0 DOM reads per frame)
  const getPageAnchors = useCallback((pageIdx: number) => {
    const metrics = pageMetricsRef.current;
    if (metrics.items.length > 0) {
      const { stripStartY, stripMaxY, items } = metrics;
      const curr = items[pageIdx];
      const next = items[pageIdx + 1];
      if (!curr) {
        return { startY: stripStartY, endY: stripMaxY, stripStartY, stripMaxY };
      }
      const headerOffset = 68;
      const rawStart = Math.max(stripStartY, curr.top - headerOffset);
      const rawEnd = next
        ? Math.max(rawStart + 60, next.top - headerOffset)
        : Math.max(rawStart + 60, stripMaxY);
      return {
        startY: Math.min(rawStart, stripMaxY),
        endY: Math.min(rawEnd, stripMaxY),
        stripStartY,
        stripMaxY,
      };
    }

    const pages = pageRefs.current;
    const headerOffset = 68;
    const firstEl = pages[0];
    const lastEl = pages[pages.length - 1];

    const stripStartY = firstEl
      ? Math.max(0, firstEl.getBoundingClientRect().top + window.scrollY - headerOffset)
      : 0;
    const stripMaxY = lastEl
      ? Math.max(
          stripStartY,
          lastEl.getBoundingClientRect().top + window.scrollY + lastEl.offsetHeight - window.innerHeight + 170
        )
      : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

    const currEl = pages[pageIdx];
    const nextEl = pages[pageIdx + 1];
    if (!currEl) {
      return { startY: stripStartY, endY: stripMaxY, stripStartY, stripMaxY };
    }
    const rawStart = Math.max(stripStartY, currEl.getBoundingClientRect().top + window.scrollY - headerOffset);
    const rawEnd = nextEl
      ? Math.max(rawStart + 60, nextEl.getBoundingClientRect().top + window.scrollY - headerOffset)
      : Math.max(rawStart + 60, stripMaxY);

    return {
      startY: Math.min(rawStart, stripMaxY),
      endY: Math.min(rawEnd, stripMaxY),
      stripStartY,
      stripMaxY,
    };
  }, []);

  // Binary search over cached metrics: O(log N) & 0 DOM reads per frame
  const getVisiblePageIndex = useCallback((scrollPos?: number): number => {
    const refY = (scrollPos ?? window.scrollY) + window.innerHeight * 0.35;
    const items = pageMetricsRef.current.items;
    if (items.length > 0) {
      let lo = 0;
      let hi = items.length - 1;
      let ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (items[mid].top <= refY) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return ans;
    }

    const pages = pageRefs.current;
    if (!pages.length) return currentPageRef.current;
    let found = 0;
    for (let i = 0; i < pages.length; i += 1) {
      const el = pages[i];
      if (!el) continue;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const bottom = top + el.offsetHeight;
      if (refY >= top && refY <= bottom) {
        return i;
      }
      if (refY > bottom) {
        found = i;
      }
    }
    return found;
  }, []);

  // Full hard stop (clears resume state — used on explicit page/chapter/mode change)
  const stopPlayback = useCallback(() => {
    playSessionRef.current += 1;
    activePlaybackRef.current = null;
    standbyPreparedRef.current = null;
    audioWaitingRef.current = false;
    fastCatchupInFlightRef.current = false;
    pageAnchorStartRef.current = null;
    setIsPlaying(false);
    setIsPausedMidPage(false);
    setIsLoadingAudio(false);
    setIsSyncingNext(false);
    controlsRef.current?.setProgress(0);
    clearStallTimers();
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (fadeRafRef.current !== null) {
      cancelAnimationFrame(fadeRafRef.current);
      fadeRafRef.current = null;
    }
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    clearAudioDeck(deckARef.current);
    clearAudioDeck(deckBRef.current);
    clearAudioDeck(audioRef.current);
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, [clearAudioDeck, clearStallTimers]);

  // Soft pause (keeps exact audio position & current scrollY for seamless Resume!)
  const pausePlayback = useCallback(() => {
    if (!isPlayingRef.current) return;
    playSessionRef.current += 1;
    audioWaitingRef.current = false;
    fastCatchupInFlightRef.current = false;
    setIsPlaying(false);
    setIsSyncingNext(false);
    clearStallTimers();
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (fadeRafRef.current !== null) {
      cancelAnimationFrame(fadeRafRef.current);
      fadeRafRef.current = null;
    }
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    if (audioRef.current && activePlaybackRef.current?.usingAudio) {
      deckARef.current?.pause();
      deckBRef.current?.pause();
      audioRef.current.pause();
      setIsPausedMidPage(true);
    } else if (activePlaybackRef.current) {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.pause();
      }
      setIsPausedMidPage(true);
    }
  }, [clearStallTimers]);

  // Single unbroken 60fps loop with 0 React setState calls per frame (imperative GPU updates)
  const startContinuousScrollLoop = useCallback(
    (mySession: number) => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      if (viewModeRef.current === 'scroll' && pageMetricsRef.current.items.length === 0) {
        recomputePageMetrics();
      }

      scrollYFloatRef.current = window.scrollY;
      scrollVelocityRef.current = BASE_SCROLL_PX_PER_SEC * playbackRateRef.current;
      let lastTick = performance.now();

      const tick = (now: number) => {
        if (playSessionRef.current !== mySession) return;

        const dtSec = Math.max(0, Math.min(0.08, (now - lastTick) / 1000));
        lastTick = now;

        const speed = playbackRateRef.current;
        const audio = audioRef.current;
        const hasAudioProgress = Boolean(
          audio &&
            !audio.paused &&
            audio.duration &&
            Number.isFinite(audio.duration) &&
            audio.duration > 0
        );

        // Mode 1: 16:9 Video Review Cinema Stage (GPU-accelerated smooth pan/zoom synced to voice)
        if (viewModeRef.current === 'video') {
          if (speed <= MAX_COMFORTABLE_VOICE_RATE && hasAudioProgress && audio) {
            const targetFrac = Math.min(1, Math.max(0, audio.currentTime / audio.duration));
            sceneProgressRef.current +=
              (targetFrac - sceneProgressRef.current) * Math.min(1, dtSec * 12);
          } else if (!audioWaitingRef.current) {
            const baseSec =
              hasAudioProgress && audio
                ? audio.duration
                : Math.max(3, (activePlaybackRef.current?.durationMs || 7000) / 1000);
            sceneProgressRef.current = Math.min(1, sceneProgressRef.current + (dtSec * speed) / baseSec);
            if (
              speed > MAX_COMFORTABLE_VOICE_RATE &&
              sceneProgressRef.current >= 1 &&
              !sceneAdvanceTriggeredRef.current &&
              activePlaybackRef.current
            ) {
              sceneAdvanceTriggeredRef.current = true;
              activePlaybackRef.current.onComplete();
            }
          }

          const total = Math.max(1, totalPagesRef.current);
          const pct = Math.min(100, ((narratingPageRef.current + sceneProgressRef.current) / total) * 100);
          videoStageRef.current?.setProgress(sceneProgressRef.current, pct);
          controlsRef.current?.setProgress(pct);
          rafRef.current = requestAnimationFrame(tick);
          return;
        }

        // Mode 2: Continuous Vertical Webtoon Scroll (PD-tracked smooth glide)
        const p = narratingPageRef.current;
        const { startY, endY, stripStartY, stripMaxY } = getPageAnchors(p);
        const baseV = BASE_SCROLL_PX_PER_SEC * speed;
        let targetVelocity = baseV;

        if (speed <= MAX_COMFORTABLE_VOICE_RATE) {
          if (audioWaitingRef.current) {
            // Gently coast while waiting on an uncached page instead of freezing abruptly
            targetVelocity = 20 * speed;
          } else if (hasAudioProgress && audio) {
            // Smooth PD tracker: maps audio progress [0..1] continuously across [effectiveStartY..endY]
            const effectiveStart =
              pageAnchorStartRef.current !== null
                ? Math.min(endY - 60, Math.max(startY, pageAnchorStartRef.current))
                : startY;
            const spanPx = Math.max(60, endY - effectiveStart);
            const audioFrac = Math.min(1, Math.max(0, audio.currentTime / audio.duration));
            const effectiveAudioSec = Math.max(1.5, audio.duration / getSafeAudioRate(speed));

            const feedForwardVel = spanPx / effectiveAudioSec;
            const desiredY = effectiveStart + spanPx * audioFrac;
            const errorPx = desiredY - scrollYFloatRef.current;

            // Never scroll backward (min 10 px/s); smoothly catch up or ease to match exact panel position
            targetVelocity = Math.min(650, Math.max(10, feedForwardVel + errorPx * 1.45));
          } else if (activePlaybackRef.current) {
            // Silent panel (audio_url === null) or browser SpeechSynthesis fallback: track time progress smoothly
            const effectiveStart =
              pageAnchorStartRef.current !== null
                ? Math.min(endY - 60, Math.max(startY, pageAnchorStartRef.current))
                : startY;
            const spanPx = Math.max(60, endY - effectiveStart);
            const effectiveDurSec = Math.max(
              1.6,
              (activePlaybackRef.current.durationMs || 2600) / Math.max(0.75, speed) / 1000
            );
            const elapsedSec = Math.max(0, (now - voiceStartedAtRef.current) / 1000);
            const timeFrac = Math.min(1, elapsedSec / effectiveDurSec);

            const feedForwardVel = spanPx / effectiveDurSec;
            const desiredY = effectiveStart + spanPx * timeFrac;
            const errorPx = desiredY - scrollYFloatRef.current;
            targetVelocity = Math.min(650, Math.max(12, feedForwardVel + errorPx * 1.45));
          }
        } else {
          // Fast cruise (2.5x..10x): steady rapid glide + smooth viewport-locked voice catch-up
          targetVelocity = baseV;
        }

        // Critically-damped velocity smoothing so transitions across different image heights feel effortless
        scrollVelocityRef.current += (targetVelocity - scrollVelocityRef.current) * Math.min(1, dtSec * 4.2);

        if (autoScrollRef.current) {
          scrollYFloatRef.current = Math.min(
            stripMaxY,
            scrollYFloatRef.current + scrollVelocityRef.current * dtSec
          );
          window.scrollTo({ top: scrollYFloatRef.current, behavior: 'auto' });

          if (stripMaxY > stripStartY) {
            const chapterPct = ((scrollYFloatRef.current - stripStartY) / (stripMaxY - stripStartY)) * 100;
            controlsRef.current?.setProgress(Math.min(100, Math.max(0, chapterPct)));
          }

          const visIdx = getVisiblePageIndex(scrollYFloatRef.current);
          if (visIdx !== currentPageRef.current) {
            currentPageRef.current = visIdx;
            setCurrentPage(visIdx);
          }

          // During fast cruise (> 2x), smoothly sync voice to the newly reached image if >= 2 pages ahead
          if (
            speed > MAX_COMFORTABLE_VOICE_RATE &&
            !audioWaitingRef.current &&
            !fastCatchupInFlightRef.current &&
            visIdx >= narratingPageRef.current + 2 &&
            now - voiceStartedAtRef.current >= 2400 &&
            speakPageRef.current
          ) {
            fastCatchupInFlightRef.current = true;
            const { useDemo, useMode, useEngine, useVoice } = activeSessionConfigRef.current;
            const targetPage = visIdx;
            void speakPageRef.current(
              mySession,
              targetPage,
              useDemo,
              useMode,
              useEngine,
              useVoice,
              false
            ).finally(() => {
              fastCatchupInFlightRef.current = false;
            });
          }
        } else if (hasAudioProgress && audio) {
          controlsRef.current?.setProgress(Math.min(100, (audio.currentTime / audio.duration) * 100));
        }

        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);
    },
    [getPageAnchors, getVisiblePageIndex, recomputePageMetrics]
  );

  // Resume from mid-page pause (continues from exact scrollY & audio.currentTime with gentle fade-in)
  const resumePlayback = useCallback(async () => {
    const ctx = activePlaybackRef.current;
    if (!ctx) return false;

    const mySession = playSessionRef.current + 1;
    playSessionRef.current = mySession;
    setIsPlaying(true);
    setIsPausedMidPage(false);

    const guardedComplete = () => {
      if (playSessionRef.current !== mySession) return;
      ctx.onComplete();
    };

    if (ctx.usingAudio && audioRef.current) {
      try {
        audioRef.current.muted = false;
        audioRef.current.playbackRate = getSafeAudioRate(playbackRateRef.current);
        audioRef.current.onended = guardedComplete;
        audioRef.current.volume = 0;
        await audioRef.current.play();
        void fadeAudioVolume(audioRef.current, 0, 1, 160);
        startContinuousScrollLoop(mySession);
        return true;
      } catch {
        return false;
      }
    } else {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.resume();
      }
      startContinuousScrollLoop(mySession);
      fallbackTimerRef.current = window.setTimeout(
        guardedComplete,
        Math.max(1200, ctx.remainingMs / getSafeAudioRate(playbackRateRef.current))
      );
      return true;
    }
  }, [fadeAudioVolume, startContinuousScrollLoop]);

  // Load chapter pages immediately; load comic metadata & favorite status in parallel without blocking render
  useEffect(() => {
    if (!sourceType || !comicId || !chapterId) return;
    let cancelled = false;
    stopPlayback();
    setLoadingChapter(true);
    setChapterError('');
    narrationCacheRef.current.clear();
    inFlightNarrationRef.current.clear();
    fallbackNotifiedRef.current = false;
    translatedNotifiedRef.current = false;
    nextChapterPrefetchedRef.current = false;
    pageRefs.current = [];
    pageMetricsRef.current = { stripStartY: 0, stripMaxY: 0, items: [] };

    const load = async () => {
      try {
        const data = await api.getChapterPages(sourceType, comicId, chapterId);
        if (cancelled) return;
        setChapter(data);
        const startIdx = Math.min(
          Math.max(0, Number(searchParams.get('page') || 0)),
          Math.max(0, data.pages.length - 1)
        );
        setCurrentPage(startIdx);
        setLoadingChapter(false);

        const metaTasks: Promise<void>[] = [
          api
            .getComicDetail(sourceType, comicId)
            .then((detail) => {
              if (cancelled) return;
              setComicTitle(detail.title);
              setCoverUrl(detail.cover_url);
              setAllChapters(detail.chapters);
            })
            .catch(() => {
              if (!cancelled && !navState?.comicTitle) setComicTitle(comicId);
            }),
        ];
        if (user) {
          metaTasks.push(
            api
              .listFavorites()
              .then((favs) => {
                if (cancelled) return;
                setFavorited(favs.some((f) => f.source_type === sourceType && f.comic_id === comicId));
              })
              .catch(() => {
                // ignore
              })
          );
        }
        void Promise.allSettled(metaTasks);
      } catch (err) {
        if (cancelled) return;
        setChapterError(err instanceof ApiError ? err.message : 'Không tải được trang chương.');
        setLoadingChapter(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
      stopPlayback();
    };
  }, [sourceType, comicId, chapterId]);

  // Scroll to saved initial page if > 0 after chapter loads
  useEffect(() => {
    if (!loadingChapter && chapter && initialPage > 0) {
      const t = window.setTimeout(() => {
        const el = pageRefs.current[initialPage];
        if (el) {
          const top = Math.max(0, el.getBoundingClientRect().top + window.scrollY - 68);
          window.scrollTo({ top, behavior: 'auto' });
        }
      }, 250);
      return () => window.clearTimeout(t);
    }
  }, [loadingChapter, chapter, initialPage]);

  // Auto-detect active visible page when user scrolls manually (scroll mode only)
  useEffect(() => {
    if (!chapter || loadingChapter || viewMode !== 'scroll') return;
    let ready = false;
    const readyTimer = window.setTimeout(() => {
      ready = true;
    }, 350);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!ready || isPlayingRef.current) return;
        let bestIdx = -1;
        let bestRatio = 0;
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > bestRatio) {
            const idxAttr = entry.target.getAttribute('data-page-idx');
            if (idxAttr !== null) {
              bestRatio = entry.intersectionRatio;
              bestIdx = Number(idxAttr);
            }
          }
        }
        if (bestIdx >= 0) {
          setCurrentPage((prev) => {
            if (prev !== bestIdx && activePlaybackRef.current?.pageIdx !== bestIdx) {
              setIsPausedMidPage(false);
            }
            return bestIdx;
          });
        }
      },
      { rootMargin: '-25% 0px -45% 0px', threshold: [0.1, 0.35, 0.6] }
    );

    pageRefs.current.forEach((el) => {
      if (el) observer.observe(el);
    });
    return () => {
      window.clearTimeout(readyTimer);
      observer.disconnect();
    };
  }, [chapter, loadingChapter, viewMode]);

  // Save reading history (both localStorage for guests + API for logged-in users)
  useEffect(() => {
    if (!chapter || !sourceType || !comicId || !chapterId) return;
    const timer = window.setTimeout(() => {
      const entry = {
        source_type: sourceType,
        comic_id: comicId,
        comic_title: comicTitle || comicId,
        cover_url: coverUrl,
        chapter_id: chapterId,
        chapter_title: chapter.chapter_title,
        page_index: currentPage,
      };
      upsertLocalHistory(entry);
      if (user) {
        void api.saveHistory(entry).catch(() => {});
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [user, chapter, sourceType, comicId, chapterId, comicTitle, coverUrl, currentPage]);

  // Sleep Timer countdown
  useEffect(() => {
    if (sleepSecondsLeft === null) return;
    if (sleepSecondsLeft <= 0) {
      pausePlayback();
      setSleepSecondsLeft(null);
      setSleepMinutesSelected(0);
      showToast('Đã hết giờ hẹn tắt. Chúc bạn ngủ ngon!', 5000);
      return;
    }
    const id = window.setInterval(() => {
      setSleepSecondsLeft((prev) => (prev !== null ? Math.max(0, prev - 1) : null));
    }, 1000);
    return () => window.clearInterval(id);
  }, [sleepSecondsLeft, pausePlayback, showToast]);

  // Soft-pause on manual wheel / touch outside controls bar (only in vertical scroll mode)
  useEffect(() => {
    const handleManualInteract = (e: Event) => {
      if (!isPlayingRef.current) return;
      if (viewModeRef.current === 'video') return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-reader-control="true"]')) return;
      pausePlayback();
      showToast('Đã tạm dừng do bạn chạm/lướt màn hình. Bấm "Tiếp tục" để chạy tiếp.');
    };

    window.addEventListener('wheel', handleManualInteract, { passive: true });
    window.addEventListener('touchstart', handleManualInteract, { passive: true });
    return () => {
      window.removeEventListener('wheel', handleManualInteract);
      window.removeEventListener('touchstart', handleManualInteract);
    };
  }, [pausePlayback, showToast]);

  const scrollToPageTop = useCallback((idx: number) => {
    const el = pageRefs.current[idx];
    if (!el) return;
    const top = Math.max(0, el.getBoundingClientRect().top + window.scrollY - 68);
    window.scrollTo({ top, behavior: 'smooth' });
  }, []);

  // Fetch and cache up to 2-5 pages in ONE OCR/AI call + Google/Neural voice
  const ensurePageNarration = useCallback(
    async (
      pageIdx: number,
      useDemo: boolean,
      useMode: NarrationMode,
      useEngine: NarrationEngine,
      useVoice: VoiceId,
      batchLimit = 5
    ): Promise<PageNarrationResponse> => {
      if (!chapter || !sourceType || !comicId || !chapterId) {
        throw new Error('Chapter not loaded');
      }
      const memKey = `${pageIdx}|${useMode}|${useEngine}|${useDemo}|${useVoice}`;
      const cached = narrationCacheRef.current.get(memKey);
      if (cached) return cached;

      const existing = inFlightNarrationRef.current.get(memKey);
      if (existing) return existing;

      const BATCH_SIZE = Math.max(1, Math.min(5, batchLimit));
      const batchPages: { page_index: number; image_url: string }[] = [];
      const batchKeys: string[] = [];
      for (let i = pageIdx; i < Math.min(chapter.pages.length, pageIdx + BATCH_SIZE); i += 1) {
        const k = `${i}|${useMode}|${useEngine}|${useDemo}|${useVoice}`;
        if (!narrationCacheRef.current.has(k) && !inFlightNarrationRef.current.has(k)) {
          batchPages.push({ page_index: i, image_url: chapter.pages[i] });
          batchKeys.push(k);
        }
      }

      if (batchPages.length === 0) {
        // Fallback safety if pageIdx raced into cache
        const nowCached = narrationCacheRef.current.get(memKey);
        if (nowCached) return nowCached;
        const nowInFlight = inFlightNarrationRef.current.get(memKey);
        if (nowInFlight) return nowInFlight;
        batchPages.push({ page_index: pageIdx, image_url: chapter.pages[pageIdx] });
        batchKeys.push(memKey);
      }

      const rawPrevScript =
        narrationCacheRef.current.get(`${pageIdx - 1}|${useMode}|${useEngine}|${useDemo}|${useVoice}`)
          ?.script_text ||
        narrationCacheRef.current.get(`${pageIdx - 1}|${useMode}|${useEngine}|${useDemo}|hoaimy`)
          ?.script_text ||
        '';
      const prevScript = rawPrevScript.length > 380 ? rawPrevScript.slice(-380) : rawPrevScript;

      const batchMapPromise = api
        .narrateBatch({
          source_type: sourceType,
          comic_id: comicId,
          chapter_id: chapterId,
          mode: useMode,
          engine: useEngine,
          voice: useVoice,
          demo_mode: useDemo,
          allow_fallback: true,
          comic_title: comicTitle,
          previous_context: prevScript,
          pages: batchPages,
        })
        .then((res) => {
          const itemMap = new Map<number, PageNarrationResponse>();
          let anyTranslated = false;
          for (const item of res.items) {
            const k = `${item.page_index}|${useMode}|${useEngine}|${useDemo}|${useVoice}`;
            narrationCacheRef.current.set(k, item);
            itemMap.set(item.page_index, item);
            if (item.translated) anyTranslated = true;
          }

          if (anyTranslated && !translatedNotifiedRef.current) {
            translatedNotifiedRef.current = true;
            showToast(
              'Phát hiện truyện ngoại ngữ — đã tự động dịch bằng AI sang tiếng Việt.',
              4000
            );
          }

          if (res.fallback_used && !fallbackNotifiedRef.current) {
            fallbackNotifiedRef.current = true;
            showToast(
              'AI đang tạm quá tải/hết lượt hôm nay — đang tiếp tục bằng giọng đọc dự phòng để không gián đoạn.',
              4500
            );
          }
          return itemMap;
        })
        .finally(() => {
          for (const k of batchKeys) {
            inFlightNarrationRef.current.delete(k);
          }
        });

      for (const p of batchPages) {
        const k = `${p.page_index}|${useMode}|${useEngine}|${useDemo}|${useVoice}`;
        const itemPromise = batchMapPromise.then((map) => {
          const found = map.get(p.page_index);
          if (!found) {
            throw new Error(`Thiếu dữ liệu thuyết minh cho trang ${p.page_index + 1}`);
          }
          return found;
        });
        inFlightNarrationRef.current.set(k, itemPromise);
      }

      const targetPromise = inFlightNarrationRef.current.get(memKey);
      if (targetPromise) return targetPromise;

      return batchMapPromise.then((map) => {
        const found = map.get(pageIdx);
        if (!found) throw new Error('Không lấy được thuyết minh cho trang hiện tại');
        return found;
      });
    },
    [chapter, sourceType, comicId, chapterId, comicTitle, showToast]
  );

  // Viewport-synced, gapless dual-deck voice narration queue inside an active session
  const speakPageInSession = useCallback(
    async (
      mySession: number,
      pageIdx: number,
      useDemo: boolean,
      useMode: NarrationMode,
      useEngine: NarrationEngine,
      useVoice: VoiceId,
      isFirstInSession: boolean
    ) => {
      if (!chapter || !sourceType || !comicId || !chapterId) return;
      if (pageIdx < 0 || pageIdx >= chapter.pages.length) return;
      if (playSessionRef.current !== mySession) return;

      const memKey = `${pageIdx}|${useMode}|${useEngine}|${useDemo}|${useVoice}`;
      const alreadyCached = narrationCacheRef.current.has(memKey);
      if (isFirstInSession && !alreadyCached) {
        setIsLoadingAudio(true);
      }
      if (!alreadyCached) {
        audioWaitingRef.current = true;
        setIsSyncingNext(true);
      }

      let narration: PageNarrationResponse;
      try {
        narration = await ensurePageNarration(
          pageIdx,
          useDemo,
          useMode,
          useEngine,
          useVoice,
          isFirstInSession ? 2 : 5
        );
      } catch (err) {
        audioWaitingRef.current = false;
        setIsSyncingNext(false);
        if (playSessionRef.current !== mySession) return;

        const isAuthOrKeyMissing = err instanceof ApiError && (err.status === 400 || err.status === 401);
        if (!isAuthOrKeyMissing) {
          if (!fallbackNotifiedRef.current) {
            fallbackNotifiedRef.current = true;
            showToast('Kết nối tạm gián đoạn — giữ nhịp lướt mượt bằng giọng dự phòng.', 4000);
          }
          narration = {
            page_index: pageIdx,
            mode: useMode,
            engine: useEngine,
            voice: useVoice,
            script_text: `Đang lướt qua trang số ${pageIdx + 1}. Kết nối tạm gián đoạn nên ứng dụng giữ nhịp lướt mượt để bạn tiếp tục xem tranh.`,
            audio_url: null,
            duration_ms: 6500,
            cached: false,
            used_demo: true,
            translated: false,
          };
        } else {
          stopPlayback();
          const msg = err instanceof ApiError ? err.message : 'Không thể tạo thuyết minh cho trang này.';
          showToast(msg, 5000);
          if (err instanceof ApiError && (err.status === 400 || err.status === 401 || err.status === 429)) {
            setNeedsKeyPrompt(true);
          }
          return;
        }
      }

      audioWaitingRef.current = false;
      setIsSyncingNext(false);
      if (playSessionRef.current !== mySession) return;

      // If this page was returned before its background MP3 finished rendering, fetch its ready MP3 URL now
      if (!narration.audio_url && narration.script_text?.trim() && chapter.pages[pageIdx]) {
        try {
          const refreshed = await api.narratePage({
            source_type: sourceType,
            comic_id: comicId,
            chapter_id: chapterId,
            page_index: pageIdx,
            image_url: chapter.pages[pageIdx],
            mode: useMode,
            engine: useEngine,
            voice: useVoice,
            demo_mode: useDemo,
            allow_fallback: true,
            comic_title: comicTitle,
          });
          narration = refreshed;
          narrationCacheRef.current.set(memKey, refreshed);
        } catch {
          // Keep current narration with speechSynthesis fallback
        }
        if (playSessionRef.current !== mySession) return;
      }

      // Proactive Next-Page Pre-Buffer onto Standby Audio Deck + Earlier Batch Lookahead (+3)
      if (pageIdx + 1 < chapter.pages.length) {
        const nextIdx = pageIdx + 1;
        const nextKey = `${nextIdx}|${useMode}|${useEngine}|${useDemo}|${useVoice}`;
        void (async () => {
          let nextItem = narrationCacheRef.current.get(nextKey);
          for (const waitMs of [700, 1800, 3000]) {
            if (!nextItem || nextItem.audio_url || !nextItem.script_text?.trim() || !chapter.pages[nextIdx]) {
              break;
            }
            await new Promise((r) => window.setTimeout(r, waitMs));
            if (playSessionRef.current !== mySession) return;
            try {
              const fetched = await api.narratePage({
                source_type: sourceType,
                comic_id: comicId,
                chapter_id: chapterId,
                page_index: nextIdx,
                image_url: chapter.pages[nextIdx],
                mode: useMode,
                engine: useEngine,
                voice: useVoice,
                demo_mode: useDemo,
                allow_fallback: true,
                comic_title: comicTitle,
              });
              narrationCacheRef.current.set(nextKey, fetched);
              nextItem = fetched;
            } catch {
              break;
            }
          }
          if (playSessionRef.current !== mySession || !nextItem?.audio_url) return;
          if (
            standbyPreparedRef.current?.memKey === nextKey &&
            standbyPreparedRef.current.audioUrl === nextItem.audio_url
          ) {
            return;
          }
          const standbyIdx: 0 | 1 = activeDeckIdxRef.current === 0 ? 1 : 0;
          const standby = getDeck(standbyIdx);
          standby.pause();
          standby.src = resolveBackendUrl(nextItem.audio_url);
          standby.currentTime = 0;
          standby.playbackRate = getSafeAudioRate(playbackRateRef.current);
          (standby as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
          standby.load();
          standbyPreparedRef.current = {
            memKey: nextKey,
            audioUrl: nextItem.audio_url,
            deckIdx: standbyIdx,
          };
        })();
      }
      for (let offset = 1; offset <= 3; offset += 1) {
        const targetIdx = pageIdx + offset;
        if (targetIdx >= chapter.pages.length) break;
        const kTarget = `${targetIdx}|${useMode}|${useEngine}|${useDemo}|${useVoice}`;
        if (!narrationCacheRef.current.has(kTarget) && !inFlightNarrationRef.current.has(kTarget)) {
          void ensurePageNarration(targetIdx, useDemo, useMode, useEngine, useVoice, 5).catch(() => {});
          break;
        }
      }

      // Snappy fade-out if replacing an earlier playing audio clip (e.g. fast-cruise catch-up)
      if (audioRef.current && !audioRef.current.paused && audioRef.current.currentTime > 0.1) {
        audioRef.current.onended = null;
        await fadeAudioVolume(audioRef.current, audioRef.current.volume, 0, 80);
        if (playSessionRef.current !== mySession) return;
        audioRef.current.pause();
      }

      if (isFirstInSession) {
        pageAnchorStartRef.current = window.scrollY;
      } else {
        const { startY, endY } = getPageAnchors(pageIdx);
        pageAnchorStartRef.current =
          scrollYFloatRef.current >= startY - 140 && scrollYFloatRef.current < endY - 60
            ? scrollYFloatRef.current
            : startY;
      }
      sceneProgressRef.current = 0;
      sceneAdvanceTriggeredRef.current = false;
      const initPct = chapter.pages.length > 0 ? (pageIdx / chapter.pages.length) * 100 : 0;
      videoStageRef.current?.setProgress(0, initPct);
      controlsRef.current?.setProgress(initPct);
      narratingPageRef.current = pageIdx;
      voiceStartedAtRef.current = performance.now();
      setNarratingPage(pageIdx);
      if (viewModeRef.current === 'video') {
        currentPageRef.current = pageIdx;
        setCurrentPage(pageIdx);
      }
      setIsLoadingAudio(false);
      setIsPlaying(true);
      setIsPausedMidPage(false);
      setSubtitleText(narration.script_text);

      // Start the single unbroken PD-tracked continuous scroll loop once (never restarted between pages!)
      if (rafRef.current === null) {
        startContinuousScrollLoop(mySession);
      }

      const performAdvance = () => {
        clearStallTimers();
        if (fallbackTimerRef.current !== null) {
          window.clearTimeout(fallbackTimerRef.current);
          fallbackTimerRef.current = null;
        }
        activePlaybackRef.current = null;

        if (pageIdx >= chapter.pages.length - 1) {
          if (chapter.next_chapter_id) {
            showToast('Hết chương! Đang tự chuyển sang chương tiếp theo...', 2400);
            const nextId = chapter.next_chapter_id;
            const navSession = playSessionRef.current;
            window.setTimeout(() => {
              if (playSessionRef.current !== navSession) return;
              navigate(
                `/read/${sourceType}/${encodeURIComponent(comicId)}/${encodeURIComponent(nextId)}?autoplay=1${
                  useDemo ? '&demo=1' : ''
                }`,
                { state: { comicTitle, coverUrl } }
              );
            }, 1500);
          } else {
            stopPlayback();
            showToast('Bạn đã nghe hết chương cuối cùng.', 4000);
          }
          return;
        }

        // Seamless next page: sequential in video mode & normal speeds; catch up to viewport in fast scroll mode
        let nextIdx = pageIdx + 1;
        if (
          viewModeRef.current === 'scroll' &&
          autoScrollRef.current &&
          playbackRateRef.current > MAX_COMFORTABLE_VOICE_RATE
        ) {
          const visIdx = getVisiblePageIndex();
          if (visIdx > nextIdx) {
            nextIdx = Math.min(chapter.pages.length - 1, visIdx);
          }
        }
        void speakPageInSession(mySession, nextIdx, useDemo, useMode, useEngine, useVoice, false);
      };

      const advanceAfterPage = () => {
        if (playSessionRef.current !== mySession) return;
        performAdvance();
      };

      const startFallbackSpeech = (text: string, durationMs: number) => {
        if (text.trim() && 'speechSynthesis' in window) {
          window.speechSynthesis.cancel();
          const utter = new SpeechSynthesisUtterance(text);
          utter.lang = 'vi-VN';
          utter.rate = getSafeAudioRate(playbackRateRef.current);
          window.speechSynthesis.speak(utter);
        } else if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
        }
        activePlaybackRef.current = {
          pageIdx,
          useDemo,
          useMode,
          useEngine,
          useVoice,
          usingAudio: false,
          durationMs,
          remainingMs: durationMs,
          onComplete: performAdvance,
        };
        if (fallbackTimerRef.current !== null) {
          window.clearTimeout(fallbackTimerRef.current);
        }
        fallbackTimerRef.current = window.setTimeout(
          advanceAfterPage,
          Math.max(2000, durationMs / getSafeAudioRate(playbackRateRef.current))
        );
      };

      if (narration.audio_url) {
        const prepped = standbyPreparedRef.current;
        let audio: HTMLAudioElement;
        if (prepped && prepped.memKey === memKey && prepped.audioUrl === narration.audio_url) {
          const prevActive = audioRef.current;
          const targetDeck = getDeck(prepped.deckIdx);
          if (prevActive && prevActive !== targetDeck) {
            clearAudioDeck(prevActive);
          }
          activeDeckIdxRef.current = prepped.deckIdx;
          standbyPreparedRef.current = null;
          audio = targetDeck;
        } else {
          standbyPreparedRef.current = null;
          audio = getDeck(activeDeckIdxRef.current);
          clearAudioDeck(audio);
          audio.src = resolveBackendUrl(narration.audio_url);
        }

        audioRef.current = audio;
        clearStallTimers();
        audio.muted = false;
        audio.currentTime = 0;
        audio.playbackRate = getSafeAudioRate(playbackRateRef.current);
        (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
        audio.volume = 0;
        audio.onended = advanceAfterPage;
        audio.onerror = () => {
          clearStallTimers();
          if (playSessionRef.current !== mySession) return;
          startFallbackSpeech(narration.script_text, narration.duration_ms);
        };

        const armStallWatchdog = () => {
          if (stallTimerRef.current !== null || playSessionRef.current !== mySession) return;
          stallTimerRef.current = window.setTimeout(() => {
            stallTimerRef.current = null;
            if (playSessionRef.current !== mySession || !isPlayingRef.current) return;
            void audio.play().catch(() => {});
            stallFallbackTimerRef.current = window.setTimeout(() => {
              stallFallbackTimerRef.current = null;
              if (playSessionRef.current !== mySession || !isPlayingRef.current) return;
              if (audio.paused || audio.readyState < 3) {
                clearAudioDeck(audio);
                startFallbackSpeech(narration.script_text, narration.duration_ms);
              }
            }, 4000);
          }, 7500);
        };
        audio.onwaiting = armStallWatchdog;
        audio.onstalled = armStallWatchdog;
        audio.onplaying = () => clearStallTimers();
        audio.ontimeupdate = () => {
          if (audio.currentTime > 0) clearStallTimers();
        };

        try {
          await audio.play();
          audioUnlockedRef.current = true;
          void fadeAudioVolume(audio, 0, 1, 80);
          activePlaybackRef.current = {
            pageIdx,
            useDemo,
            useMode,
            useEngine,
            useVoice,
            usingAudio: true,
            durationMs: narration.duration_ms,
            remainingMs: narration.duration_ms,
            onComplete: performAdvance,
          };
        } catch {
          clearStallTimers();
          if (playSessionRef.current !== mySession) return;
          startFallbackSpeech(narration.script_text, narration.duration_ms);
          showToast('Trình duyệt chặn tự phát MP3 — bấm Tạm dừng rồi Tiếp tục để bật tiếng.', 3500);
        }
      } else {
        startFallbackSpeech(narration.script_text, narration.duration_ms);
      }
    },
    [
      chapter,
      sourceType,
      comicId,
      chapterId,
      comicTitle,
      coverUrl,
      ensurePageNarration,
      fadeAudioVolume,
      getDeck,
      clearAudioDeck,
      clearStallTimers,
      startContinuousScrollLoop,
      getVisiblePageIndex,
      stopPlayback,
      showToast,
      navigate,
    ]
  );

  useEffect(() => {
    speakPageRef.current = speakPageInSession;
  }, [speakPageInSession]);

  // Start a fresh continuous playback session from a given page (only jumps scroll if explicitly requested)
  const playPage = useCallback(
    async (
      pageIdx: number,
      overrideDemo?: boolean,
      overrideMode?: NarrationMode,
      jumpToPage = false,
      overrideVoice?: VoiceId,
      overrideEngine?: NarrationEngine
    ) => {
      if (!chapter || !sourceType || !comicId || !chapterId) return;
      if (pageIdx < 0 || pageIdx >= chapter.pages.length) return;

      const useDemo = overrideDemo ?? demoMode;
      const useMode = overrideMode ?? mode;
      const useEngine = overrideEngine ?? engineRef.current;
      const useVoice = overrideVoice ?? voiceRef.current;

      stopPlayback();
      const mySession = playSessionRef.current;
      activeSessionConfigRef.current = { useDemo, useMode, useEngine, useVoice };
      setNeedsKeyPrompt(false);

      if (jumpToPage) {
        currentPageRef.current = pageIdx;
        setCurrentPage(pageIdx);
        const pageEl = pageRefs.current[pageIdx];
        if (pageEl) {
          const rectTop = pageEl.getBoundingClientRect().top + window.scrollY;
          window.scrollTo({ top: Math.max(0, rectTop - 68), behavior: 'auto' });
        }
      }

      await speakPageInSession(mySession, pageIdx, useDemo, useMode, useEngine, useVoice, true);
    },
    [chapter, sourceType, comicId, chapterId, demoMode, mode, stopPlayback, speakPageInSession]
  );

  // Autoplay when auto-advancing from previous chapter
  useEffect(() => {
    if (!loadingChapter && chapter && chapter.pages.length > 0 && searchParams.get('autoplay') === '1') {
      const timer = window.setTimeout(() => {
        void playPage(0);
      }, 500);
      return () => window.clearTimeout(timer);
    }
  }, [loadingChapter, chapter]);

  // Pre-warm current page OCR + Google TTS audio in 0-AI mode so tapping Play on mobile/desktop starts immediately
  useEffect(() => {
    if (loadingChapter || !chapter || chapter.pages.length === 0) return;
    if (searchParams.get('autoplay') === '1' || activePlaybackRef.current) return;
    if (engineRef.current !== 'ocr') return;
    const startIdx = Math.min(Math.max(0, currentPageRef.current), chapter.pages.length - 1);
    const timer = window.setTimeout(() => {
      if (activePlaybackRef.current) return;
      void ensurePageNarration(startIdx, demoMode, mode, 'ocr', voiceRef.current, 2)
        .then((res) => {
          if (res?.audio_url) {
            void fetch(resolveBackendUrl(res.audio_url)).catch(() => {});
          }
        })
        .catch(() => {});
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loadingChapter, chapter, demoMode, mode, ensurePageNarration, searchParams]);

  const handleTogglePlay = useCallback(async () => {
    if (isPlayingRef.current) {
      pausePlayback();
      return;
    }
    const startIdx = viewModeRef.current === 'video' ? currentPageRef.current : getVisiblePageIndex();
    if (activePlaybackRef.current && activePlaybackRef.current.pageIdx === startIdx) {
      const ok = await resumePlayback();
      if (ok) return;
    }
    unlockAudio();
    void playPage(startIdx, undefined, undefined, false);
  }, [getVisiblePageIndex, pausePlayback, resumePlayback, unlockAudio, playPage]);

  const goToPage = useCallback(
    (targetIdx: number) => {
      if (!chapter || !chapter.pages.length) return;
      const idx = Math.min(chapter.pages.length - 1, Math.max(0, targetIdx));
      if (isPlayingRef.current) {
        unlockAudio();
        void playPage(idx, undefined, undefined, viewModeRef.current === 'scroll');
        return;
      }
      stopPlayback();
      currentPageRef.current = idx;
      narratingPageRef.current = idx;
      sceneProgressRef.current = 0;
      setCurrentPage(idx);
      setNarratingPage(idx);
      const pct = (idx / chapter.pages.length) * 100;
      videoStageRef.current?.setProgress(0, pct);
      controlsRef.current?.setProgress(pct);
      if (viewModeRef.current === 'scroll') {
        scrollToPageTop(idx);
      }
    },
    [chapter, unlockAudio, playPage, stopPlayback, scrollToPageTop]
  );

  // Screen Wake Lock so mobile phones never lock mid-chapter while playing
  const wakeLockRef = useRef<{ release: () => Promise<void>; released?: boolean } | null>(null);
  useEffect(() => {
    type WakeLockNav = Navigator & {
      wakeLock?: {
        request: (type: 'screen') => Promise<{ release: () => Promise<void>; released?: boolean }>;
      };
    };
    const wl = (navigator as WakeLockNav).wakeLock;
    if (!wl) return;

    let cancelled = false;
    const acquire = () => {
      if (cancelled || !isPlayingRef.current || document.visibilityState !== 'visible') return;
      if (wakeLockRef.current && !wakeLockRef.current.released) return;
      wl.request('screen')
        .then((sentinel) => {
          if (cancelled || !isPlayingRef.current) {
            void sentinel.release().catch(() => {});
            return;
          }
          wakeLockRef.current = sentinel;
        })
        .catch(() => {});
    };

    const release = () => {
      const cur = wakeLockRef.current;
      wakeLockRef.current = null;
      if (cur && !cur.released) {
        void cur.release().catch(() => {});
      }
    };

    if (isPlaying) {
      acquire();
      document.addEventListener('visibilitychange', acquire);
      return () => {
        cancelled = true;
        document.removeEventListener('visibilitychange', acquire);
        release();
      };
    }

    release();
    return () => {
      cancelled = true;
    };
  }, [isPlaying]);

  // Mobile Lock-Screen & Headphone Media Session controls
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.playbackState = isPlaying ? 'playing' : 'paused';
    if (typeof MediaMetadata !== 'undefined' && chapter) {
      ms.metadata = new MediaMetadata({
        title: comicTitle || 'Lười Truyện',
        artist: chapter.chapter_title,
        album: 'Lười Truyện AI',
        artwork: coverUrl ? [{ src: resolveBackendUrl(coverUrl) }] : [],
      });
    }
    try {
      ms.setActionHandler('play', () => {
        if (!isPlayingRef.current) void handleTogglePlay();
      });
      ms.setActionHandler('pause', () => {
        if (isPlayingRef.current) pausePlayback();
      });
      ms.setActionHandler('previoustrack', () => {
        goToPage(currentPageRef.current - 1);
      });
      ms.setActionHandler('nexttrack', () => {
        goToPage(currentPageRef.current + 1);
      });
    } catch {
      // Unsupported action in older browsers
    }
  }, [comicTitle, coverUrl, chapter, isPlaying, handleTogglePlay, pausePlayback, goToPage]);

  useEffect(() => {
    return () => {
      if (!('mediaSession' in navigator)) return;
      const ms = navigator.mediaSession;
      ms.playbackState = 'none';
      (['play', 'pause', 'previoustrack', 'nexttrack'] as const).forEach((action) => {
        try {
          ms.setActionHandler(action, null);
        } catch {
          // ignore
        }
      });
    };
  }, []);

  // Keyboard shortcuts (Space: play/pause, Left/Right: prev/next page, A/D: prev/next chapter)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        void handleTogglePlay();
      } else if (e.code === 'ArrowLeft' && chapter) {
        goToPage(currentPageRef.current - 1);
      } else if (e.code === 'ArrowRight' && chapter) {
        goToPage(currentPageRef.current + 1);
      } else if (e.code === 'KeyA' && chapter?.prev_chapter_id) {
        navigate(
          `/read/${sourceType}/${encodeURIComponent(comicId || '')}/${encodeURIComponent(chapter.prev_chapter_id)}`,
          { state: { comicTitle, coverUrl } }
        );
      } else if (e.code === 'KeyD' && chapter?.next_chapter_id) {
        navigate(
          `/read/${sourceType}/${encodeURIComponent(comicId || '')}/${encodeURIComponent(chapter.next_chapter_id)}`,
          { state: { comicTitle, coverUrl } }
        );
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    handleTogglePlay,
    chapter,
    goToPage,
    sourceType,
    comicId,
    comicTitle,
    coverUrl,
    navigate,
  ]);

  const handleToggleFavorite = async () => {
    if (!sourceType || !comicId) return;
    if (!user) {
      openAuthModal();
      return;
    }
    try {
      const res = await api.toggleFavorite({
        source_type: sourceType,
        comic_id: comicId,
        comic_title: comicTitle || comicId,
        cover_url: coverUrl,
      });
      setFavorited(res.favorited);
      showToast(res.favorited ? 'Đã thêm vào danh sách theo dõi' : 'Đã bỏ theo dõi', 1800);
    } catch {
      // ignore
    }
  };

  const handleSelectSpeed = (speed: number) => {
    setPlaybackRate(speed);
    showToast(
      speed > MAX_COMFORTABLE_VOICE_RATE
        ? `Tốc độ lướt: ${speed}x (giọng giữ đều ${MAX_COMFORTABLE_VOICE_RATE}x)`
        : `Tốc độ lướt & đọc: ${speed}x`,
      1800
    );
  };

  const handleToggleMode = () => {
    if (engine === 'ocr') {
      setEngine('ai');
      engineRef.current = 'ai';
      setMode('storytelling');
      setDemoMode(false);
      activePlaybackRef.current = null;
      standbyPreparedRef.current = null;
      setIsPausedMidPage(false);
      setNeedsKeyPrompt(false);
      showToast('Đã chuyển sang: Kể chuyện AI (Gemini)', 2200);
      if (isPlaying) {
        unlockAudio();
        void playPage(currentPage, false, 'storytelling', false, undefined, 'ai');
      } else {
        setSubtitleText('');
      }
      return;
    }

    const nextMode: NarrationMode = mode === 'storytelling' ? 'dialogue' : 'storytelling';
    setMode(nextMode);
    activePlaybackRef.current = null;
    standbyPreparedRef.current = null;
    setIsPausedMidPage(false);
    showToast(
      nextMode === 'storytelling'
        ? 'Đã chuyển sang: Thuyết minh kể chuyện'
        : 'Đã chuyển sang: Đọc sát thoại',
      2000
    );
    if (isPlaying) {
      unlockAudio();
      void playPage(currentPage, demoMode, nextMode, false, undefined, 'ai');
    } else {
      setSubtitleText('');
    }
  };

  const handleToggleVoice = () => {
    const nextVoice: VoiceId = voice === 'hoaimy' ? 'namminh' : 'hoaimy';
    setVoice(nextVoice);
    voiceRef.current = nextVoice;
    activePlaybackRef.current = null;
    standbyPreparedRef.current = null;
    setIsPausedMidPage(false);
    showToast(
      nextVoice === 'hoaimy'
        ? 'Đã chuyển giọng đọc: Nữ (Hoài My)'
        : 'Đã chuyển giọng đọc: Nam (Nam Minh)',
      2000
    );
    if (isPlaying) {
      unlockAudio();
      void playPage(currentPage, demoMode, mode, false, nextVoice, engineRef.current);
    } else {
      setSubtitleText('');
    }
  };

  const handleToggleEngine = () => {
    const nextEngine: NarrationEngine = engine === 'ocr' ? 'ai' : 'ocr';
    setEngine(nextEngine);
    engineRef.current = nextEngine;
    setDemoMode(false);
    activePlaybackRef.current = null;
    standbyPreparedRef.current = null;
    setIsPausedMidPage(false);
    setNeedsKeyPrompt(false);
    showToast(
      nextEngine === 'ocr'
        ? 'Đã chuyển sang: Đọc OCR + Giọng Google (0 AI)'
        : 'Đã chuyển sang: Kể chuyện AI (Gemini)',
      2200
    );
    if (isPlaying) {
      unlockAudio();
      void playPage(currentPage, false, mode, false, undefined, nextEngine);
    } else {
      setSubtitleText('');
    }
  };

  const handleSelectSleepMinutes = (minutes: number) => {
    setSleepMinutesSelected(minutes);
    if (minutes === 0) {
      setSleepSecondsLeft(null);
      showToast('Đã tắt hẹn giờ ngủ', 1800);
    } else {
      setSleepSecondsLeft(minutes * 60);
      showToast(`Hẹn giờ tự tắt sau ${minutes} phút`, 2200);
    }
  };

  const widthClass =
    stripWidth === 'narrow'
      ? 'max-w-[740px]'
      : stripWidth === 'full'
        ? 'max-w-full px-0'
        : 'max-w-[880px]';

  if (loadingChapter) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-surface-bg text-text-secondary">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="text-sm">Đang tải các trang truyện...</span>
      </div>
    );
  }

  if (chapterError || !chapter) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-surface-bg px-4 text-center">
        <p className="text-sm text-secondary">{chapterError || 'Không tìm thấy chương truyện.'}</p>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="mt-4 rounded-lg bg-surface-container px-4 py-2 text-sm text-text-primary"
        >
          Quay lại
        </button>
      </div>
    );
  }

  return (
    <div
      className={`min-h-screen pb-[calc(9.5rem+env(safe-area-inset-bottom,0px))] pt-[calc(4rem+env(safe-area-inset-top,0px))] transition-colors sm:pb-44 ${
        theaterMode ? 'bg-black' : 'bg-surface-bg'
      }`}
    >
      {/* Stitch Reader Fixed Top Header (smooth hide/show on tap) */}
      <header
        data-reader-control="true"
        className={`pt-safe fixed left-0 right-0 top-0 z-40 border-b border-border-subtle/70 bg-surface/90 shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur-xl transition-transform duration-200 ${
          immersiveHideTop ? '-translate-y-full' : 'translate-y-0'
        }`}
      >
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-1.5 px-2.5 sm:gap-2 sm:px-6">
          {/* Left: Back (Mobile) / Brand + Breadcrumb (Desktop) */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:flex-initial sm:gap-3">
            <Link
              to={`/comic/${sourceType}/${encodeURIComponent(comicId || '')}`}
              title="Quay lại thông tin truyện"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-container text-on-surface sm:hidden"
            >
              <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            </Link>

            <Link to="/" className="hidden shrink-0 items-center gap-2 sm:flex">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-badge-new-bg to-badge-hot-bg text-white">
                <span className="material-symbols-outlined text-[18px]">headphones</span>
              </div>
              <span className="hidden text-[16px] font-extrabold text-primary xl:inline">
                LườiTruyện
              </span>
            </Link>

            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-[13px] text-on-surface-variant sm:flex-initial">
              <span className="hidden text-outline-variant sm:inline">/</span>
              <Link
                to={`/comic/${sourceType}/${encodeURIComponent(comicId || '')}`}
                className="w-full truncate font-semibold text-on-surface hover:text-primary sm:w-auto sm:max-w-[210px]"
              >
                {comicTitle || 'Truyện tranh'}
              </Link>
              <span className="material-symbols-outlined hidden text-[14px] text-outline-variant sm:inline">
                chevron_right
              </span>
              <span className="hidden truncate font-semibold text-primary sm:inline">
                {chapter.chapter_title}
              </span>
            </div>
          </div>

          {/* Right: Chapter Selector + Follow + View Mode + Theater + Width */}
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <div className="flex items-center rounded-lg bg-surface-container p-0.5">
              <button
                type="button"
                disabled={!chapter.prev_chapter_id}
                onClick={() =>
                  chapter.prev_chapter_id &&
                  navigate(
                    `/read/${sourceType}/${encodeURIComponent(comicId || '')}/${encodeURIComponent(chapter.prev_chapter_id)}`,
                    { state: { comicTitle, coverUrl } }
                  )
                }
                title="Chương trước"
                className="hidden rounded p-1 text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface disabled:opacity-30 sm:inline-flex sm:p-1.5"
              >
                <span className="material-symbols-outlined text-[17px] sm:text-[18px]">navigate_before</span>
              </button>

              {allChapters.length > 1 ? (
                <select
                  aria-label="Chọn chương"
                  value={chapter.chapter_id}
                  onChange={(e) =>
                    navigate(
                      `/read/${sourceType}/${encodeURIComponent(comicId || '')}/${encodeURIComponent(e.target.value)}`,
                      { state: { comicTitle, coverUrl } }
                    )
                  }
                  className="font-label max-w-[78px] cursor-pointer truncate rounded bg-surface-card px-1.5 py-1 text-[11px] font-semibold text-text-primary focus:outline-none sm:max-w-[160px] sm:px-2 sm:text-[12px]"
                >
                  {allChapters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="font-label px-1.5 text-[11px] font-semibold text-primary sm:px-2 sm:text-[12px]">
                  {currentPage + 1}/{chapter.pages.length}
                </span>
              )}

              <button
                type="button"
                disabled={!chapter.next_chapter_id}
                onClick={() =>
                  chapter.next_chapter_id &&
                  navigate(
                    `/read/${sourceType}/${encodeURIComponent(comicId || '')}/${encodeURIComponent(chapter.next_chapter_id)}`,
                    { state: { comicTitle, coverUrl } }
                  )
                }
                title="Chương kế tiếp"
                className="hidden rounded p-1 text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface disabled:opacity-30 sm:inline-flex sm:p-1.5"
              >
                <span className="material-symbols-outlined text-[17px] sm:text-[18px]">navigate_next</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleToggleFavorite}
              className={`font-label hidden items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition sm:flex ${
                favorited
                  ? 'bg-badge-hot-bg text-white shadow-[0_2px_10px_rgba(255,51,102,0.35)]'
                  : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
              }`}
            >
              <span
                className={`material-symbols-outlined text-[15px] ${
                  favorited ? 'material-symbols-filled' : ''
                }`}
              >
                favorite
              </span>
              <span className="hidden lg:inline">{favorited ? 'Đang theo dõi' : 'Theo dõi'}</span>
            </button>

            {/* View Mode Toggle: Video 16:9 vs Vertical Scroll */}
            <div
              className="flex items-center rounded-lg bg-surface-container p-0.5"
              role="group"
              aria-label="Chế độ xem"
            >
              <button
                type="button"
                onClick={() => {
                  setViewMode('video');
                  showToast('Đã chuyển sang chế độ Xem Video 16:9', 1800);
                }}
                title="Chế độ Xem Video 16:9 (giống Review YouTube)"
                className={`font-label flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-bold transition sm:px-2 ${
                  viewMode === 'video'
                    ? 'bg-primary-container text-on-primary-container shadow-sm'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                <span className="material-symbols-outlined text-[15px]">smart_display</span>
                <span className="hidden sm:inline">Video</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const targetPage = currentPageRef.current;
                  setViewMode('scroll');
                  showToast('Đã chuyển sang chế độ Cuộn dọc', 1800);
                  window.setTimeout(() => {
                    const el = pageRefs.current[targetPage];
                    if (el) {
                      const top = Math.max(0, el.getBoundingClientRect().top + window.scrollY - 68);
                      window.scrollTo({ top, behavior: 'auto' });
                    }
                  }, 60);
                }}
                title="Chế độ Cuộn dọc liên tục"
                className={`font-label flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-bold transition sm:px-2 ${
                  viewMode === 'scroll'
                    ? 'bg-primary-container text-on-primary-container shadow-sm'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                <span className="material-symbols-outlined text-[15px]">view_day</span>
                <span className="hidden sm:inline">Cuộn</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => setTheaterMode((v) => !v)}
              title="Chế độ rạp phim (tắt đèn)"
              className={`hidden rounded-lg p-2 transition md:flex ${
                theaterMode
                  ? 'bg-primary-container text-on-primary-container'
                  : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">nightlight</span>
            </button>

            {viewMode === 'scroll' && (
              <div className="hidden items-center rounded-lg bg-surface-container p-0.5 lg:flex">
                {(
                  [
                    { id: 'narrow' as const, icon: 'width_normal', label: 'Khung 740px' },
                    { id: 'default' as const, icon: 'photo_size_select_large', label: 'Chuẩn 880px' },
                    { id: 'full' as const, icon: 'fullscreen', label: 'Tràn màn hình' },
                  ] as const
                ).map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    title={w.label}
                    onClick={() => setStripWidth(w.id)}
                    className={`rounded p-1.5 transition ${
                      stripWidth === w.id
                        ? 'bg-surface-card text-primary'
                        : 'text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[17px]">{w.icon}</span>
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => (user ? openSettingsModal() : openAuthModal())}
              title={user ? 'Cài đặt Gemini API Key' : 'Đăng nhập'}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-on-primary shadow-sm"
            >
              <span className="material-symbols-outlined text-[18px]">
                {user ? 'key' : 'person'}
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* Shortcuts & Live AI Status Strip (Desktop only) */}
      <section className="hidden w-full border-b border-border-subtle/50 bg-surface-card px-4 py-2 md:block">
        <div className="mx-auto flex max-w-4xl items-center justify-between text-[11px] text-on-surface-variant">
          <div className="font-label flex items-center gap-2 overflow-hidden whitespace-nowrap">
            <span className="material-symbols-outlined text-[15px] text-badge-new-bg">
              tips_and_updates
            </span>
            <span>Phím tắt:</span>
            <kbd className="rounded bg-surface-container-high px-1.5 py-0.5 font-mono text-[10px] text-primary">
              Space
            </kbd>{' '}
            Tự lướt / Dừng
            <span className="text-outline-variant">•</span>
            <kbd className="rounded bg-surface-container-high px-1.5 py-0.5 font-mono text-[10px] text-primary">
              ◄ / ►
            </kbd>{' '}
            Đổi trang
            <span className="hidden text-outline-variant sm:inline">•</span>
            <kbd className="hidden rounded bg-surface-container-high px-1.5 py-0.5 font-mono text-[10px] text-primary sm:inline">
              A / D
            </kbd>
            <span className="hidden sm:inline">Đổi chương</span>
          </div>
          <div className="font-label hidden items-center gap-2 md:flex">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent-green" />
            <span className="text-text-secondary">
              {viewMode === 'video'
                ? 'Bấm vào khung Video để phát/dừng • Tự động chuyển cảnh mượt theo giọng đọc'
                : 'Chạm vào tranh để ẩn/hiện thanh trên'}
            </span>
          </div>
        </div>
      </section>

      {/* API Key helper banner when AI call needs key */}
      {needsKeyPrompt && (
        <div data-reader-control="true" className="mx-auto mt-4 max-w-2xl px-4">
          <div className="flex flex-col gap-3 rounded-xl border border-tertiary-container/50 bg-tertiary-container/15 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs leading-relaxed text-on-surface">
              <strong className="block text-sm text-tertiary">
                Cần Gemini API Key để AI đọc ảnh thật
              </strong>
              Dán key miễn phí từ Google AI Studio trong Cài đặt, hoặc bật Chế độ đọc thử để nghe ngay giọng Google + tự lướt.
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  if (!user) openAuthModal();
                  else openSettingsModal();
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary-container px-3.5 py-2 text-xs font-bold text-on-primary-container hover:bg-badge-new-bg hover:text-white"
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>{user ? 'Cài API Key' : 'Đăng nhập'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  unlockAudio();
                  setEngine('ocr');
                  engineRef.current = 'ocr';
                  setDemoMode(false);
                  setNeedsKeyPrompt(false);
                  void playPage(currentPage, false, mode, false, undefined, 'ocr');
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent-green px-3.5 py-2 text-xs font-bold text-white hover:brightness-110"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>Dùng OCR + Giọng Google (0 AI)</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content: 16:9 Video Review Stage OR Continuous Vertical Strip */}
      <main className="flex w-full flex-col items-center py-3 sm:py-5">
        {viewMode === 'video' ? (
          <VideoReviewStage
            ref={videoStageRef}
            pages={chapter.pages}
            activePage={currentPage}
            isPlaying={isPlaying}
            isLoadingAudio={isLoadingAudio}
            isSyncingNext={isSyncingNext}
            subtitleText={subtitleText}
            showSubtitles={showSubtitles}
            mode={mode}
            engine={engine}
            demoMode={demoMode}
            chapterTitle={chapter.chapter_title}
            comicTitle={comicTitle || 'Truyện tranh'}
            onTogglePlay={() => void handleTogglePlay()}
            onSelectPage={goToPage}
            onPrevScene={() => goToPage(currentPageRef.current - 1)}
            onNextScene={() => goToPage(currentPageRef.current + 1)}
          />
        ) : (
          <div className={`flex w-full flex-col px-0 transition-all duration-300 ${widthClass}`}>
            {chapter.pages.map((imgUrl, idx) => {
              const isActive = idx === currentPage;
              return (
                <div
                  key={`${chapter.chapter_id}-${idx}`}
                  data-page-idx={idx}
                  ref={(el) => {
                    pageRefs.current[idx] = el;
                  }}
                  onClick={() => {
                    if (!isPlayingRef.current) setCurrentPage(idx);
                    setImmersiveHideTop((v) => !v);
                  }}
                  className="comic-page-contain relative w-full cursor-pointer overflow-hidden bg-surface-container-lowest"
                >
                  <ComicPageImage
                    src={getMobileImageUrl(imgUrl, 900, 80)}
                    alt={`Trang ${idx + 1}`}
                    eager={idx <= currentPage + 6}
                    onLoaded={scheduleRecomputeMetrics}
                  />
                  <div className="font-label absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-surface-container-lowest/80 px-3 py-1 text-[11px] font-bold text-text-primary shadow-lg backdrop-blur-md">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        isActive && isPlaying ? 'animate-ping bg-accent-green' : 'bg-primary-container'
                      }`}
                    />
                    <span>
                      Trang {String(idx + 1).padStart(2, '0')} / {String(chapter.pages.length).padStart(2, '0')}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* End-of-Chapter Completion Card */}
        <section className="mx-auto mt-10 w-full max-w-4xl px-4">
          <div className="flex flex-col gap-5 rounded-2xl border border-border-subtle bg-surface-card p-6 shadow-xl">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
              <div>
                <div className="font-label mb-2 inline-flex items-center gap-1.5 rounded-full bg-accent-green/15 px-3 py-1 text-[11px] font-bold text-accent-green">
                  <span className="material-symbols-outlined text-[15px]">check_circle</span>
                  Hoàn thành {chapter.chapter_title}
                </div>
                <h2 className="text-xl font-bold text-text-primary">{comicTitle}</h2>
              </div>

              <button
                type="button"
                onClick={handleToggleFavorite}
                className="inline-flex items-center gap-2 rounded-xl bg-badge-hot-bg px-4 py-2.5 text-sm font-bold text-white shadow-md transition hover:opacity-95"
              >
                <span className="material-symbols-outlined material-symbols-filled text-[18px]">
                  favorite
                </span>
                <span>{favorited ? 'Đã theo dõi' : 'Theo dõi truyện'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
              {chapter.prev_chapter_id ? (
                <Link
                  to={`/read/${sourceType}/${encodeURIComponent(comicId || '')}/${encodeURIComponent(chapter.prev_chapter_id)}`}
                  state={{ comicTitle, coverUrl }}
                  className="group flex items-center gap-3 rounded-xl bg-surface-container p-4 transition hover:bg-surface-card-hover"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-container-high text-on-surface group-hover:bg-primary-container group-hover:text-on-primary-container">
                    <span className="material-symbols-outlined text-[20px]">arrow_back</span>
                  </div>
                  <div>
                    <span className="font-label text-[11px] uppercase text-text-secondary">
                      Chương trước
                    </span>
                    <div className="text-sm font-bold text-text-primary group-hover:text-primary">
                      Quay lại chương trước
                    </div>
                  </div>
                </Link>
              ) : (
                <div className="rounded-xl bg-surface-container/40 p-4 text-xs text-outline">
                  Đây là chương đầu tiên.
                </div>
              )}

              {chapter.next_chapter_id ? (
                <Link
                  to={`/read/${sourceType}/${encodeURIComponent(comicId || '')}/${encodeURIComponent(chapter.next_chapter_id)}`}
                  state={{ comicTitle, coverUrl }}
                  className="group flex items-center justify-between rounded-xl bg-primary-container p-4 text-on-primary-container shadow-lg transition hover:bg-badge-new-bg hover:text-white"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/20">
                      <span className="material-symbols-outlined text-[20px]">arrow_forward</span>
                    </div>
                    <div>
                      <span className="font-label text-[11px] uppercase opacity-80">Đọc tiếp</span>
                      <div className="text-sm font-bold">Sang chương kế tiếp</div>
                    </div>
                  </div>
                  <span className="material-symbols-outlined text-[22px] transition-transform group-hover:translate-x-1">
                    chevron_right
                  </span>
                </Link>
              ) : (
                <Link
                  to={`/comic/${sourceType}/${encodeURIComponent(comicId || '')}`}
                  className="flex items-center justify-center rounded-xl border border-border-subtle bg-surface-container p-4 text-sm font-semibold text-primary hover:bg-surface-card-hover"
                >
                  Về danh sách chương
                </Link>
              )}
            </div>
          </div>
        </section>
      </main>

      {/* Right Floating Quick-Action Rail (Desktop — vertical scroll mode only) */}
      {viewMode === 'scroll' && (
        <aside
          data-reader-control="true"
          className={`fixed bottom-32 right-5 z-30 hidden flex-col items-center gap-2 transition-opacity duration-200 lg:flex ${
            immersiveHideTop ? 'opacity-25 hover:opacity-100' : 'opacity-100'
          }`}
        >
        <div className="font-label flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-card/90 px-3 py-1.5 text-[11px] text-text-secondary shadow-xl backdrop-blur-md">
          <span className="material-symbols-outlined text-[15px] text-primary">photo_library</span>
          <span className="font-bold text-text-primary">{currentPage + 1}</span>
          <span>/</span>
          <span>{chapter.pages.length}</span>
        </div>
        <div className="flex flex-col gap-1 rounded-2xl border border-border-subtle bg-surface-card/90 p-1.5 shadow-xl backdrop-blur-md">
          <button
            type="button"
            title="Lên đầu trang"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-on-surface-variant transition hover:bg-surface-container-high hover:text-text-primary"
          >
            <span className="material-symbols-outlined text-[20px]">vertical_align_top</span>
          </button>
          <button
            type="button"
            title="Trang trước"
            disabled={currentPage <= 0}
            onClick={() => {
              const p = Math.max(0, currentPage - 1);
              setCurrentPage(p);
              scrollToPageTop(p);
            }}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-on-surface-variant transition hover:bg-surface-container-high hover:text-text-primary disabled:opacity-30"
          >
            <span className="material-symbols-outlined text-[20px]">arrow_upward</span>
          </button>
          <button
            type="button"
            title="Trang sau"
            disabled={currentPage >= chapter.pages.length - 1}
            onClick={() => {
              const n = Math.min(chapter.pages.length - 1, currentPage + 1);
              setCurrentPage(n);
              scrollToPageTop(n);
            }}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-on-surface-variant transition hover:bg-surface-container-high hover:text-text-primary disabled:opacity-30"
          >
            <span className="material-symbols-outlined text-[20px]">arrow_downward</span>
          </button>
        </div>
      </aside>
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          data-reader-control="true"
          className="fixed bottom-[calc(8.75rem+env(safe-area-inset-bottom,0px))] left-1/2 z-50 w-[min(92vw,28rem)] -translate-x-1/2 rounded-xl border border-border-subtle bg-surface-card/95 px-4 py-2.5 text-center text-xs font-semibold text-text-primary shadow-2xl backdrop-blur-md sm:bottom-auto sm:top-[calc(5rem+env(safe-area-inset-top,0px))] sm:w-auto sm:text-sm"
        >
          {toast}
        </div>
      )}

      {/* Floating Subtitle Box (vertical scroll mode — video mode renders YouTube-style CC inside stage) */}
      {viewMode === 'scroll' && showSubtitles && subtitleText && (
        <div
          data-reader-control="true"
          className="pointer-events-none fixed inset-x-0 bottom-[calc(108px+env(safe-area-inset-bottom,0px))] z-30 flex justify-center px-3 sm:px-6"
        >
          <div className="pointer-events-auto max-h-28 w-full max-w-2xl overflow-y-auto rounded-xl border border-border-subtle bg-surface-container-lowest/92 px-4 py-2.5 shadow-2xl backdrop-blur-lg">
            <div className="font-label mb-1 flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-wider text-primary">
              <div className="flex items-center gap-1.5">
                <Volume2 className="h-3 w-3 text-accent-green" />
                <span>
                  Đang đọc Trang {narratingPage + 1}/{chapter.pages.length} •{' '}
                  {engine === 'ocr'
                    ? 'OCR • Giọng Google'
                    : mode === 'storytelling'
                      ? 'Kể chuyện AI'
                      : 'Sát thoại AI'}
                  {demoMode ? ' (Đọc thử)' : ''}
                </span>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-container px-2 py-0.5 text-[9px] font-semibold normal-case text-text-secondary">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    isSyncingNext
                      ? 'animate-pulse bg-tertiary'
                      : isPlaying
                        ? 'animate-pulse bg-accent-green'
                        : 'bg-outline'
                  }`}
                />
                {isSyncingNext ? 'Đang đồng bộ...' : isPlaying ? 'Đồng bộ mượt' : 'Tạm dừng'}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-text-primary sm:text-sm">{subtitleText}</p>
          </div>
        </div>
      )}

      {/* Bottom Lazy Reader Player Controls */}
      <ReaderControls
        ref={controlsRef}
        isPlaying={isPlaying}
        isPausedMidPage={isPausedMidPage}
        isLoadingAudio={isLoadingAudio}
        currentPage={currentPage}
        totalPages={chapter.pages.length}
        playbackRate={playbackRate}
        mode={mode}
        engine={engine}
        voice={voice}
        demoMode={demoMode}
        autoScroll={autoScroll}
        showSubtitles={showSubtitles}
        viewMode={viewMode}
        sleepSecondsLeft={sleepSecondsLeft}
        sleepMinutesSelected={sleepMinutesSelected}
        onTogglePlay={() => void handleTogglePlay()}
        onPrevPage={() => goToPage(currentPage - 1)}
        onNextPage={() => goToPage(currentPage + 1)}
        onSelectSpeed={handleSelectSpeed}
        onToggleMode={handleToggleMode}
        onToggleEngine={handleToggleEngine}
        onToggleVoice={handleToggleVoice}
        onToggleAutoScroll={() => setAutoScroll((v) => !v)}
        onToggleSubtitles={() => setShowSubtitles((v) => !v)}
        onSelectSleepMinutes={handleSelectSleepMinutes}
      />
    </div>
  );
}
