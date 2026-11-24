import React, { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { api, ApiError } from '../lib/api';

export function AuthModal() {
  const { authModalOpen, closeAuthModal, loginSuccess } = useAuth();
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!authModalOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      if (tab === 'login') {
        const res = await api.login(identifier, password);
        loginSuccess(res.access_token, res.user);
      } else {
        const res = await api.register(username, email, password);
        loginSuccess(res.access_token, res.user);
      }
      setPassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Có lỗi xảy ra, vui lòng thử lại.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={closeAuthModal}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border-x border-t border-border-subtle bg-surface-card px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] pt-3 shadow-[0_-10px_35px_rgba(0,0,0,0.85)] sm:rounded-2xl sm:border sm:p-6"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-outline-variant/70 sm:hidden" />
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold text-text-primary">
            {tab === 'login' ? 'Đăng nhập tài khoản' : 'Tạo tài khoản mới'}
          </h2>
          <button
            type="button"
            onClick={closeAuthModal}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-container hover:text-text-primary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-5 grid grid-cols-2 rounded-lg bg-surface-container p-1">
          <button
            type="button"
            onClick={() => {
              setTab('login');
              setError('');
            }}
            className={`rounded-md py-2 text-sm font-semibold transition ${
              tab === 'login'
                ? 'bg-primary-container text-on-primary-container'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Đăng nhập
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('register');
              setError('');
            }}
            className={`rounded-md py-2 text-sm font-semibold transition ${
              tab === 'register'
                ? 'bg-primary-container text-on-primary-container'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Đăng ký
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {tab === 'login' ? (
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-on-surface-variant">
                Tên đăng nhập hoặc Email
              </label>
              <input
                type="text"
                required
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="ban_doc_truyen hoặc email@..."
                className="w-full rounded-lg border border-border-subtle bg-surface-container px-3.5 py-2.5 text-[16px] text-text-primary outline-none focus:border-primary-container sm:text-sm"
              />
            </div>
          ) : (
            <>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-on-surface-variant">
                  Tên đăng nhập (không dấu, 3-40 ký tự)
                </label>
                <input
                  type="text"
                  required
                  minLength={3}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="nguoiloai_99"
                  className="w-full rounded-lg border border-border-subtle bg-surface-container px-3.5 py-2.5 text-[16px] text-text-primary outline-none focus:border-primary-container sm:text-sm"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-on-surface-variant">
                  Email
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="email@example.com"
                  className="w-full rounded-lg border border-border-subtle bg-surface-container px-3.5 py-2.5 text-[16px] text-text-primary outline-none focus:border-primary-container sm:text-sm"
                />
              </div>
            </>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-semibold text-on-surface-variant">
              Mật khẩu
            </label>
            <input
              type="password"
              required
              minLength={6}
              maxLength={72}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Ít nhất 6 ký tự"
              className="w-full rounded-lg border border-border-subtle bg-surface-container px-3.5 py-2.5 text-[16px] text-text-primary outline-none focus:border-primary-container sm:text-sm"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-badge-hot-bg/40 bg-badge-hot-bg/10 px-3.5 py-2.5 text-xs text-secondary">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-primary-container py-2.5 text-sm font-bold text-on-primary-container transition hover:bg-badge-new-bg hover:text-white active:scale-[0.98] disabled:opacity-60"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {tab === 'login' ? 'Đăng nhập' : 'Đăng ký ngay'}
          </button>
        </form>
      </div>
    </div>
  );
}
