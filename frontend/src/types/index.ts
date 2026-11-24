export type SourceType = 'local' | 'hinettruyen' | 'otruyen' | 'mangadex';
export type NarrationMode = 'storytelling' | 'dialogue';
export type NarrationEngine = 'ocr' | 'ai';
export type VoiceId = 'hoaimy' | 'namminh';

export interface GenreItem {
  name: string;
  slug: string;
}

export interface HiNetHomeResponse {
  featured: ComicSummary[];
  latest: ComicSummary[];
  top_month: ComicSummary[];
  top_week: ComicSummary[];
  top_day: ComicSummary[];
  genres: GenreItem[];
}

export interface UserProfile {
  id: string;
  username: string;
  email: string;
  role?: string;
  is_admin?: boolean;
  has_custom_api_key: boolean;
  key_hint: string | null;
  daily_free_used: number;
  daily_free_limit: number;
  server_has_gemini_key: boolean;
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: UserProfile;
}

export interface ComicSummary {
  id: string;
  source_type: SourceType;
  title: string;
  cover_url: string;
  description: string;
  latest_chapter: string;
  language: string;
  chapter_count: number;
}

export interface ChapterItem {
  id: string;
  title: string;
  chapter_number: string;
  page_count: number;
  language: string;
  updated_at?: string;
  views?: string;
}

export interface ComicDetail {
  id: string;
  source_type: SourceType;
  title: string;
  description: string;
  cover_url: string;
  authors: string[];
  tags: string[];
  status?: string;
  updated_at?: string;
  chapters: ChapterItem[];
}

export interface ChapterPagesResponse {
  comic_id: string;
  source_type: SourceType;
  chapter_id: string;
  chapter_title: string;
  pages: string[];
  prev_chapter_id: string | null;
  next_chapter_id: string | null;
}

export interface PageNarrationResponse {
  page_index: number;
  mode: NarrationMode;
  engine?: NarrationEngine | string;
  voice?: VoiceId | string;
  script_text: string;
  audio_url: string | null;
  duration_ms: number;
  cached: boolean;
  used_demo: boolean;
  translated?: boolean;
}

export interface BatchNarrationResponse {
  items: PageNarrationResponse[];
  batch_ai_calls: number;
  fallback_used: boolean;
}

export interface FavoriteItem {
  id: number;
  source_type: SourceType;
  comic_id: string;
  comic_title: string;
  cover_url: string;
  created_at: string;
}

export interface HistoryItem {
  id: number;
  source_type: SourceType;
  comic_id: string;
  comic_title: string;
  cover_url: string;
  chapter_id: string;
  chapter_title: string;
  page_index: number;
  updated_at: string;
}
