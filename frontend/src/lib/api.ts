import type {
  AuthResponse,
  BatchNarrationResponse,
  ChapterPagesResponse,
  ComicDetail,
  ComicSummary,
  FavoriteItem,
  HiNetHomeResponse,
  HistoryItem,
  NarrationEngine,
  NarrationMode,
  PageNarrationResponse,
  SourceType,
  UserProfile,
  VoiceId,
} from '../types';

const RAW_API_BASE = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

export function getApiBaseUrl(): string {
  return RAW_API_BASE;
}

export function resolveBackendUrl(url: string): string {
  if (!url) return '';
  if (/^https?:\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) {
    return url;
  }
  if (RAW_API_BASE && url.startsWith('/')) {
    return `${RAW_API_BASE}${url}`;
  }
  return url;
}

const TOKEN_KEY = 'lcr_token';
const HOME_SWR_KEY = 'lcr_home_swr_v1';
const HOME_SWR_TTL = 15 * 60 * 1000;
const MAX_GET_CACHE_ITEMS = 120;
const _GET_CACHE = new Map<string, { exp: number; data: unknown }>();
const _GET_INFLIGHT = new Map<string, Promise<unknown>>();

export function peekCachedGet<T>(path: string): T | null {
  const hit = _GET_CACHE.get(path);
  if (hit) {
    if (Date.now() < hit.exp) {
      return hit.data as T;
    }
    _GET_CACHE.delete(path);
  }
  if (path === '/api/comics/hinettruyen/home') {
    try {
      const raw = localStorage.getItem(HOME_SWR_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { ts?: number; data?: T };
        if (parsed?.data && typeof parsed.ts === 'number' && Date.now() - parsed.ts < HOME_SWR_TTL) {
          return parsed.data;
        }
      }
    } catch {
      // ignore storage parse error
    }
  }
  return null;
}

export function invalidateComicCaches(): void {
  for (const key of Array.from(_GET_CACHE.keys())) {
    if (key.startsWith('/api/comics/')) {
      _GET_CACHE.delete(key);
    }
  }
}

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string | null): void {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs = 35000
): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!(options.body instanceof FormData) && options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(resolveBackendUrl(path), { ...options, headers, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(
        'Máy chủ phản hồi quá lâu (có thể đang khởi động lại sau khi ngủ) — hãy thử lại sau vài giây.',
        408
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }

  if (!res.ok) {
    let msg = `Lỗi máy chủ (${res.status})`;
    try {
      const data = await res.json();
      if (typeof data?.detail === 'string') {
        msg = data.detail;
      } else if (Array.isArray(data?.detail) && data.detail[0]?.msg) {
        msg = data.detail[0].msg;
      }
    } catch {
      // ignore json parse error
    }
    throw new ApiError(msg, res.status);
  }

  return (await res.json()) as T;
}

function cachedGet<T>(path: string, ttlMs: number): Promise<T> {
  const existing = peekCachedGet<T>(path);
  if (existing !== null) {
    return Promise.resolve(existing);
  }
  const inflight = _GET_INFLIGHT.get(path);
  if (inflight) {
    return inflight as Promise<T>;
  }

  const p = request<T>(path)
    .then((data) => {
      if (_GET_CACHE.size >= MAX_GET_CACHE_ITEMS) {
        const oldestKey = _GET_CACHE.keys().next().value;
        if (oldestKey) _GET_CACHE.delete(oldestKey);
      }
      _GET_CACHE.set(path, { exp: Date.now() + ttlMs, data });
      return data;
    })
    .finally(() => {
      _GET_INFLIGHT.delete(path);
    });

  _GET_INFLIGHT.set(path, p);
  return p;
}

export const api = {
  // Auth
  register: (username: string, email: string, password: string) =>
    request<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    }),

  login: (identifier: string, password: string) =>
    request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    }),

  getMe: () => request<UserProfile>('/api/auth/me'),

  updateApiKey: (gemini_api_key: string | null) =>
    request<UserProfile>('/api/auth/settings/api-key', {
      method: 'PUT',
      body: JSON.stringify({ gemini_api_key }),
    }),

  // Comics
  listLocalComics: (q = '') =>
    request<ComicSummary[]>(`/api/comics/local?q=${encodeURIComponent(q)}`),

  getHiNetHome: async () => {
    const data = await cachedGet<HiNetHomeResponse>('/api/comics/hinettruyen/home', 120_000);
    try {
      localStorage.setItem(HOME_SWR_KEY, JSON.stringify({ ts: Date.now(), data }));
    } catch {
      // ignore storage quota errors
    }
    return data;
  },

  browseExternalComics: (
    source: 'hinettruyen' | 'otruyen' | 'mangadex',
    q = '',
    genre = '',
    page = 1
  ) =>
    cachedGet<ComicSummary[]>(
      `/api/comics/external?source=${source}&q=${encodeURIComponent(q)}&genre=${encodeURIComponent(genre)}&page=${page}`,
      90_000
    ),

  getComicDetail: (sourceType: SourceType, comicId: string) =>
    cachedGet<ComicDetail>(
      `/api/comics/${sourceType}/${encodeURIComponent(comicId)}`,
      180_000
    ),

  getChapterPages: (sourceType: SourceType, comicId: string, chapterId: string) =>
    cachedGet<ChapterPagesResponse>(
      `/api/comics/${sourceType}/${encodeURIComponent(comicId)}/chapters/${encodeURIComponent(chapterId)}`,
      300_000
    ),

  uploadComic: async (formData: FormData) => {
    const res = await request<ComicDetail>('/api/comics/upload', {
      method: 'POST',
      body: formData,
    });
    invalidateComicCaches();
    return res;
  },

  // Narration
  narratePage: (body: {
    source_type: SourceType;
    comic_id: string;
    chapter_id: string;
    page_index: number;
    image_url: string;
    mode: NarrationMode;
    engine?: NarrationEngine;
    voice?: VoiceId;
    demo_mode: boolean;
    allow_fallback?: boolean;
    comic_title?: string;
    previous_context?: string;
  }) =>
    request<PageNarrationResponse>('/api/narration/page', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  narrateBatch: (body: {
    source_type: SourceType;
    comic_id: string;
    chapter_id: string;
    mode: NarrationMode;
    engine?: NarrationEngine;
    voice?: VoiceId;
    demo_mode: boolean;
    allow_fallback?: boolean;
    comic_title?: string;
    previous_context?: string;
    pages: { page_index: number; image_url: string }[];
  }) =>
    request<BatchNarrationResponse>(
      '/api/narration/batch',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      30000
    ),

  prefetchPages: (body: {
    source_type: SourceType;
    comic_id: string;
    chapter_id: string;
    mode: NarrationMode;
    engine?: NarrationEngine;
    voice?: VoiceId;
    demo_mode: boolean;
    comic_title?: string;
    pages: { page_index: number; image_url: string }[];
  }) =>
    request<{ queued: number }>('/api/narration/prefetch', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Library
  listFavorites: () => request<FavoriteItem[]>('/api/library/favorites'),

  toggleFavorite: (body: {
    source_type: SourceType;
    comic_id: string;
    comic_title: string;
    cover_url: string;
  }) =>
    request<{ favorited: boolean }>('/api/library/favorites/toggle', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listHistory: () => request<HistoryItem[]>('/api/library/history'),

  saveHistory: (body: {
    source_type: SourceType;
    comic_id: string;
    comic_title: string;
    cover_url: string;
    chapter_id: string;
    chapter_title: string;
    page_index: number;
  }) =>
    request<{ ok: boolean }>('/api/library/history', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
