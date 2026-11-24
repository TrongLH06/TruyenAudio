import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Loader2,
  Mic,
  Moon,
  Pause,
  Play,
  ScrollText,
  Sparkles,
  Subtitles,
  X,
} from 'lucide-react';
import type { NarrationEngine, NarrationMode, VoiceId } from '../types';

export const SPEED_ROWS: number[][] = [
  [0.5, 1, 1.5, 2, 2.5],
  [3, 3.5, 4, 4.5, 5],
  [5.5, 6, 6.5, 7, 7.5],
  [8, 8.5, 9, 9.5, 10],
];

const TIMER_OPTIONS = [0, 15, 30, 60];

export interface ReaderControlsHandle {
  setProgress: (pct: number) => void;
}

interface ReaderControlsProps {
  isPlaying: boolean;
  isPausedMidPage: boolean;
  isLoadingAudio: boolean;
  currentPage: number;
  totalPages: number;
  playbackRate: number;
  mode: NarrationMode;
  engine: NarrationEngine;
  voice: VoiceId;
  demoMode: boolean;
  autoScroll: boolean;
  showSubtitles: boolean;
  viewMode?: 'video' | 'scroll';
  sleepSecondsLeft: number | null;
  sleepMinutesSelected: number;
  onTogglePlay: () => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onSelectSpeed: (speed: number) => void;
  onToggleMode: () => void;
  onToggleEngine: () => void;
  onToggleVoice: () => void;
  onToggleDemoMode?: () => void;
  onToggleAutoScroll: () => void;
  onToggleSubtitles: () => void;
  onSelectSleepMinutes: (minutes: number) => void;
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const ReaderControls = memo(
  forwardRef<ReaderControlsHandle, ReaderControlsProps>(function ReaderControls(
    {
      isPlaying,
      isPausedMidPage,
      isLoadingAudio,
      currentPage,
      totalPages,
      playbackRate,
      mode,
      engine,
      voice,
      autoScroll,
      showSubtitles,
      viewMode = 'video',
      sleepSecondsLeft,
      sleepMinutesSelected,
      onTogglePlay,
      onPrevPage,
      onNextPage,
      onSelectSpeed,
      onToggleMode,
      onToggleEngine,
      onToggleVoice,
      onToggleAutoScroll,
      onToggleSubtitles,
      onSelectSleepMinutes,
    },
    ref
  ) {
    const [speedTableOpen, setSpeedTableOpen] = useState(false);
    const speedBoxRef = useRef<HTMLDivElement | null>(null);
    const progressFillRef = useRef<HTMLDivElement | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        setProgress: (pct: number) => {
          if (!progressFillRef.current) return;
          const frac = Math.min(1, Math.max(0, pct / 100));
          progressFillRef.current.style.transform = `scaleX(${frac.toFixed(4)})`;
        },
      }),
      []
    );

    useEffect(() => {
      if (!speedTableOpen) return;
      const handleOutside = (e: Event) => {
        if (speedBoxRef.current && !speedBoxRef.current.contains(e.target as Node)) {
          setSpeedTableOpen(false);
        }
      };
      const handleEsc = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setSpeedTableOpen(false);
      };
      document.addEventListener('pointerdown', handleOutside);
      window.addEventListener('keydown', handleEsc);
      return () => {
        document.removeEventListener('pointerdown', handleOutside);
        window.removeEventListener('keydown', handleEsc);
      };
    }, [speedTableOpen]);

    const cycleSleep = () => {
      const idx = TIMER_OPTIONS.indexOf(sleepMinutesSelected);
      const next = TIMER_OPTIONS[(idx + 1) % TIMER_OPTIONS.length];
      onSelectSleepMinutes(next);
    };

    return (
      <div
        data-reader-control="true"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border-subtle/80 bg-surface-card/95 shadow-[0_-8px_30px_rgba(0,0,0,0.65)] backdrop-blur-xl"
      >
        {/* Live synchronized GPU-composited progress bar */}
        <div className="h-[3px] w-full overflow-hidden bg-surface-container">
          <div
            ref={progressFillRef}
            className="h-full w-full origin-left bg-gradient-to-r from-badge-new-bg via-primary to-accent-green will-change-transform"
            style={{ transform: 'scaleX(0)' }}
          />
        </div>

      <div className="mx-auto flex max-w-3xl flex-col gap-2 px-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom,0px))] pt-2.5 sm:px-6">
        {/* Main playback row */}
        <div className="flex items-center justify-between gap-1 sm:gap-2">
          <div className="flex items-center gap-1 sm:gap-1.5">
            <button
              type="button"
              onClick={onPrevPage}
              disabled={currentPage <= 0}
              aria-label="Trang trước"
              className="flex h-10 w-9 items-center justify-center rounded-lg border border-border-subtle bg-surface-container text-on-surface transition hover:bg-surface-container-high active:scale-95 disabled:opacity-35 sm:w-10"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={onTogglePlay}
              disabled={isLoadingAudio}
              className="inline-flex h-10 min-w-[82px] shrink-0 whitespace-nowrap items-center justify-center gap-1 rounded-lg bg-primary-container px-2 text-xs font-bold text-on-primary-container shadow-lg shadow-badge-new-bg/25 transition hover:bg-badge-new-bg hover:text-white active:scale-[0.98] disabled:opacity-70 sm:min-w-[124px] sm:gap-1.5 sm:px-4 sm:text-sm"
            >
              {isLoadingAudio ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Đang đọc...</span>
                </>
              ) : isPlaying ? (
                <>
                  <Pause className="h-4 w-4" />
                  <span>Tạm dừng</span>
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 fill-current" />
                  <span>{isPausedMidPage ? 'Tiếp tục' : 'Tự lướt'}</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onNextPage}
              disabled={currentPage >= totalPages - 1}
              aria-label="Trang tiếp"
              className="flex h-10 w-9 items-center justify-center rounded-lg border border-border-subtle bg-surface-container text-on-surface transition hover:bg-surface-container-high active:scale-95 disabled:opacity-35 sm:w-10"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Speed Table Popover & Mode quick pills */}
          <div className="flex items-center gap-1 sm:gap-1.5">
            <div ref={speedBoxRef} className="relative">
              <button
                type="button"
                onClick={() => setSpeedTableOpen((v) => !v)}
                aria-expanded={speedTableOpen}
                aria-label="Chọn tốc độ lướt từ 0.5x đến 10x"
                title="Mở bảng chọn tốc độ lướt (0.5x – 10x)"
                className={`font-label inline-flex h-10 items-center gap-1 rounded-lg border px-2 text-[11px] font-bold transition active:scale-95 sm:px-2.5 sm:text-xs ${
                  speedTableOpen
                    ? 'border-primary bg-primary-container text-on-primary-container'
                    : 'border-border-subtle bg-surface-container text-primary hover:bg-surface-container-high'
                }`}
              >
                <Gauge className="h-3.5 w-3.5" />
                <span>{playbackRate}x</span>
                <ChevronDown
                  className={`hidden h-3 w-3 transition-transform min-[390px]:block ${
                    speedTableOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {speedTableOpen && (
                <div
                  role="dialog"
                  aria-label="Bảng chọn tốc độ lướt"
                  className="fixed inset-x-3 bottom-[calc(106px+env(safe-area-inset-bottom,0px))] z-50 mx-auto max-w-[330px] rounded-xl border border-border-subtle bg-surface-card/98 p-3 shadow-2xl backdrop-blur-xl sm:absolute sm:inset-x-auto sm:bottom-12 sm:right-0 sm:mx-0 sm:w-[330px]"
                >
                  <div className="mb-2 flex items-center justify-between border-b border-border-subtle/70 pb-2">
                    <div className="flex items-center gap-1.5">
                      <Gauge className="h-4 w-4 text-primary" />
                      <span className="text-xs font-bold text-text-primary">
                        Tốc độ lướt (0.5x – 10x)
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-label rounded bg-primary-container/25 px-1.5 py-0.5 text-[11px] font-bold text-primary">
                        {playbackRate}x
                      </span>
                      <button
                        type="button"
                        onClick={() => setSpeedTableOpen(false)}
                        aria-label="Đóng bảng tốc độ"
                        className="rounded p-0.5 text-text-secondary hover:bg-surface-container-high hover:text-text-primary"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <table className="w-full border-separate border-spacing-1">
                    <tbody>
                      {SPEED_ROWS.map((row, rowIdx) => (
                        <tr key={rowIdx}>
                          {row.map((val) => {
                            const active = playbackRate === val;
                            return (
                              <td key={val} className="p-0">
                                <button
                                  type="button"
                                  onClick={() => {
                                    onSelectSpeed(val);
                                    setSpeedTableOpen(false);
                                  }}
                                  className={`font-label w-full rounded-lg py-1.5 text-center text-xs font-bold transition ${
                                    active
                                      ? 'bg-primary-container text-on-primary-container shadow-sm ring-1 ring-primary'
                                      : 'bg-surface-container text-on-surface hover:bg-surface-container-high hover:text-primary'
                                  }`}
                                >
                                  {val}x
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <p className="mt-2 text-[10px] leading-snug text-text-secondary">
                    0.5x–2x: lướt mượt đồng bộ nhịp giọng đọc. 2.5x–10x: lướt liên tục tốc độ cao, giọng giữ đều 2x không bị cắt ngang.
                  </p>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={onToggleMode}
              title={
                engine === 'ocr'
                  ? 'Đang đọc chữ OCR trực tiếp — bấm để chuyển sang AI kể chuyện'
                  : 'Đổi giữa Thuyết minh kể chuyện và Đọc sát thoại'
              }
              className="inline-flex h-10 shrink-0 whitespace-nowrap items-center gap-1 rounded-lg border border-badge-new-bg/35 bg-badge-new-bg/15 px-2 text-[11px] font-semibold text-primary transition hover:bg-badge-new-bg/25 active:scale-95 sm:px-2.5 sm:text-xs"
            >
              <Sparkles className="hidden h-3.5 w-3.5 min-[390px]:block" />
              <span>
                {engine === 'ocr'
                  ? 'Đọc OCR'
                  : mode === 'storytelling'
                    ? 'Kể chuyện'
                    : 'Sát thoại'}
              </span>
            </button>
          </div>
        </div>

        {/* Utility row: Auto-scroll (scroll mode), Subtitles, Neural Voice, Sleep Timer, Demo toggle */}
        <div className="font-label no-scrollbar flex flex-nowrap items-center justify-between gap-1 overflow-x-auto text-[11px] sm:gap-1.5">
          <div className="flex shrink-0 flex-nowrap items-center gap-1 sm:gap-1.5">
            {viewMode === 'scroll' && (
              <button
                type="button"
                onClick={onToggleAutoScroll}
                className={`inline-flex shrink-0 whitespace-nowrap items-center gap-1 rounded-full border px-2 py-1 font-semibold transition active:scale-95 sm:px-2.5 ${
                  autoScroll
                    ? 'border-accent-green/40 bg-accent-green/15 text-accent-green'
                    : 'border-border-subtle bg-surface-container text-text-secondary'
                }`}
              >
                <ScrollText className="h-3.5 w-3.5" />
                <span className="sm:hidden">Cuộn</span>
                <span className="hidden sm:inline">Cuộn: {autoScroll ? 'Bật' : 'Tắt'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={onToggleSubtitles}
              className={`inline-flex shrink-0 whitespace-nowrap items-center gap-1 rounded-full border px-2 py-1 font-semibold transition active:scale-95 sm:px-2.5 ${
                showSubtitles
                  ? 'border-badge-new-bg/40 bg-badge-new-bg/15 text-primary'
                  : 'border-border-subtle bg-surface-container text-text-secondary'
              }`}
            >
              <Subtitles className="h-3.5 w-3.5" />
              <span>Phụ đề</span>
            </button>

            <button
              type="button"
              onClick={onToggleVoice}
              title="Đổi giọng đọc Neural AI: Nữ (Hoài My) / Nam (Nam Minh)"
              className={`inline-flex shrink-0 whitespace-nowrap items-center gap-1 rounded-full border px-2 py-1 font-semibold transition active:scale-95 sm:px-2.5 ${
                voice === 'hoaimy'
                  ? 'border-primary/40 bg-primary/15 text-primary'
                  : 'border-tertiary/40 bg-tertiary/15 text-tertiary'
              }`}
            >
              <Mic className="h-3.5 w-3.5" />
              <span className="sm:hidden">{voice === 'hoaimy' ? 'Nữ' : 'Nam'}</span>
              <span className="hidden sm:inline">{voice === 'hoaimy' ? 'Giọng Nữ' : 'Giọng Nam'}</span>
            </button>

            <button
              type="button"
              onClick={cycleSleep}
              className={`inline-flex shrink-0 whitespace-nowrap items-center gap-1 rounded-full border px-2 py-1 font-semibold transition active:scale-95 sm:px-2.5 ${
                sleepSecondsLeft !== null
                  ? 'border-tertiary-container/50 bg-tertiary-container/20 text-tertiary'
                  : 'border-border-subtle bg-surface-container text-text-secondary'
              }`}
              title="Hẹn giờ tắt: Tắt / 15p / 30p / 60p"
            >
              <Moon className="h-3.5 w-3.5" />
              <span>
                {sleepSecondsLeft !== null ? formatCountdown(sleepSecondsLeft) : 'Hẹn giờ'}
              </span>
            </button>
          </div>

          <button
            type="button"
            onClick={onToggleEngine}
            title={
              engine === 'ocr'
                ? 'Đang đọc bằng OCR cục bộ + Giọng Google (0 AI, tự dịch AI khi gặp ngoại ngữ)'
                : 'Đang dùng AI Gemini đọc tranh & kể chuyện'
            }
            className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-1 font-semibold transition active:scale-95 sm:px-2.5 ${
              engine === 'ocr'
                ? 'border-accent-green/40 bg-accent-green/15 text-accent-green'
                : 'border-badge-hot-bg/40 bg-badge-hot-bg/15 text-secondary'
            }`}
          >
            {engine === 'ocr' ? (
              <>
                <span className="sm:hidden">0 AI</span>
                <span className="hidden sm:inline">Google • 0 AI</span>
              </>
            ) : (
              <>
                <span className="sm:hidden">AI</span>
                <span className="hidden sm:inline">Kể chuyện AI</span>
              </>
            )}
          </button>
        </div>
        </div>
      </div>
    );
  })
);
