import type { HistoryItem, NarrationEngine, NarrationMode, SourceType, VoiceId } from '../types';

const PREFS_KEY = 'lcr_reader_prefs_v1';
const LOCAL_HISTORY_KEY = 'lcr_local_history_v1';

export type StripWidth = 'narrow' | 'default' | 'full';
export type ReaderViewMode = 'video' | 'scroll';

export interface ReaderPrefs {
  playbackRate: number;
  mode: NarrationMode;
  engine: NarrationEngine;
  voice: VoiceId;
  autoScroll: boolean;
  showSubtitles: boolean;
  stripWidth: StripWidth;
  viewMode: ReaderViewMode;
}

const DEFAULT_PREFS: ReaderPrefs = {
  playbackRate: 1,
  mode: 'storytelling',
  engine: 'ocr',
  voice: 'hoaimy',
  autoScroll: true,
  showSubtitles: true,
  stripWidth: 'default',
  viewMode: 'video',
};

export function loadReaderPrefs(): ReaderPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ReaderPrefs>;
    return {
      playbackRate:
        typeof parsed.playbackRate === 'number' && parsed.playbackRate >= 0.5 && parsed.playbackRate <= 10
          ? parsed.playbackRate
          : DEFAULT_PREFS.playbackRate,
      mode: parsed.mode === 'dialogue' ? 'dialogue' : 'storytelling',
      engine: parsed.engine === 'ai' ? 'ai' : 'ocr',
      voice: parsed.voice === 'namminh' ? 'namminh' : 'hoaimy',
      autoScroll: typeof parsed.autoScroll === 'boolean' ? parsed.autoScroll : DEFAULT_PREFS.autoScroll,
      showSubtitles:
        typeof parsed.showSubtitles === 'boolean' ? parsed.showSubtitles : DEFAULT_PREFS.showSubtitles,
      stripWidth:
        parsed.stripWidth === 'narrow' || parsed.stripWidth === 'full' ? parsed.stripWidth : 'default',
      viewMode: parsed.viewMode === 'scroll' ? 'scroll' : 'video',
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveReaderPrefs(prefs: Partial<ReaderPrefs>): void {
  try {
    const merged = { ...loadReaderPrefs(), ...prefs };
    localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
  } catch {
    // ignore storage quota errors
  }
}

export function loadLocalHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(LOCAL_HISTORY_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return (list as HistoryItem[]).filter((item) => item.comic_id !== 'demo-lazy-night');
  } catch {
    return [];
  }
}

export function upsertLocalHistory(entry: {
  source_type: SourceType;
  comic_id: string;
  comic_title: string;
  cover_url: string;
  chapter_id: string;
  chapter_title: string;
  page_index: number;
}): void {
  try {
    const current = loadLocalHistory().filter(
      (h) => !(h.source_type === entry.source_type && h.comic_id === entry.comic_id)
    );
    const nextItem: HistoryItem = {
      id: Date.now(),
      ...entry,
      updated_at: new Date().toISOString(),
    };
    const updated = [nextItem, ...current].slice(0, 30);
    localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(updated));
  } catch {
    // ignore
  }
}
