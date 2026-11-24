import React, { useState } from 'react';
import { ExternalLink, KeyRound, Loader2, Trash2, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { api, ApiError } from '../lib/api';

export function SettingsModal() {
  const { user, setUser, settingsModalOpen, closeSettingsModal } = useAuth();
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  if (!settingsModalOpen || !user) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const updated = await api.updateApiKey(apiKey.trim());
      setUser(updated);
      setApiKey('');
      setMessage('Đã lưu Gemini API key cá nhân (được mã hóa an toàn trên máy chủ).');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Không thể lưu API key.');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const updated = await api.updateApiKey(null);
      setUser(updated);
      setMessage('Đã xóa API key cá nhân. Hệ thống sẽ dùng hạn mức miễn phí chung nếu có.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Không thể xóa API key.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={closeSettingsModal}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border-x border-t border-border-subtle bg-surface-card px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] pt-3 shadow-[0_-10px_35px_rgba(0,0,0,0.85)] sm:rounded-2xl sm:border sm:p-6"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-outline-variant/70 sm:hidden" />
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold text-text-primary">Cài đặt Gemini AI (BYOK)</h2>
          </div>
          <button
            type="button"
            onClick={closeSettingsModal}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-container hover:text-text-primary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-5 space-y-2 rounded-xl border border-border-subtle bg-surface-container p-4 text-xs leading-relaxed text-on-surface-variant">
          <p>
            Trạng thái hiện tại:{' '}
            {user.has_custom_api_key ? (
              <span className="font-semibold text-accent-green">
                Đang dùng key riêng ({user.key_hint}) — không giới hạn lượt ngày
              </span>
            ) : (
              <span className="font-semibold text-tertiary">
                Chưa cài key riêng (Đã dùng {user.daily_free_used}/{user.daily_free_limit} lượt hệ thống hôm nay)
              </span>
            )}
          </p>
          <p className="text-text-secondary">
            Bạn có thể lấy Gemini API key miễn phí tại Google AI Studio để đọc truyện không giới hạn và dùng chung cache nhanh với cộng đồng.
          </p>
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
          >
            Lấy Gemini API Key miễn phí <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>

        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-on-surface-variant">
              Dán Gemini API Key cá nhân mới
            </label>
            <input
              type="password"
              required
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="AIzaSy..."
              className="w-full rounded-lg border border-border-subtle bg-surface-container px-3.5 py-2.5 text-[16px] text-text-primary outline-none focus:border-primary-container sm:text-sm"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-badge-hot-bg/40 bg-badge-hot-bg/10 px-3.5 py-2 text-xs text-secondary">
              {error}
            </div>
          )}
          {message && (
            <div className="rounded-lg border border-accent-green/40 bg-accent-green/10 px-3.5 py-2 text-xs text-accent-green">
              {message}
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            {user.has_custom_api_key ? (
              <button
                type="button"
                disabled={saving}
                onClick={handleClear}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-badge-hot-bg/30 bg-badge-hot-bg/10 px-3.5 py-2.5 text-xs font-semibold text-secondary transition hover:bg-badge-hot-bg/20 active:scale-[0.98]"
              >
                <Trash2 className="h-4 w-4" />
                Xóa key riêng
              </button>
            ) : (
              <span />
            )}

            <button
              type="submit"
              disabled={saving}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-primary-container px-5 py-2.5 text-sm font-bold text-on-primary-container transition hover:bg-badge-new-bg hover:text-white active:scale-[0.98] disabled:opacity-60"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Lưu API Key
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
