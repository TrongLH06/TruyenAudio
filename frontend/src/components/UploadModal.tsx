import React, { useState } from 'react';
import { FileUp, Loader2, Upload, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, ApiError } from '../lib/api';

export function UploadModal({ onUploaded }: { onUploaded?: () => void }) {
  const { uploadModalOpen, closeUploadModal, uploadTargetComic } = useAuth();
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [chapterTitle, setChapterTitle] = useState('Chương 1');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!uploadModalOpen) return null;

  const effectiveTitle = uploadTargetComic ? uploadTargetComic.title : title;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!files.length) {
      setError('Vui lòng chọn ít nhất một ảnh, file ZIP/CBZ hoặc PDF.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('title', effectiveTitle.trim() || 'Truyện chưa đặt tên');
      fd.append('chapter_title', chapterTitle.trim() || 'Chương 1');
      fd.append('description', description.trim());
      if (uploadTargetComic) {
        fd.append('comic_id', uploadTargetComic.id);
      }
      for (const file of files) {
        fd.append('files', file);
      }

      const detail = await api.uploadComic(fd);
      setTitle('');
      setChapterTitle('Chương 1');
      setDescription('');
      setFiles([]);
      closeUploadModal();
      onUploaded?.();
      navigate(`/comic/local/${encodeURIComponent(detail.id)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Tải lên thất bại, vui lòng thử lại.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={closeUploadModal}
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
            <Upload className="h-5 w-5 text-accent-green" />
            <h2 className="text-lg font-bold text-text-primary">
              {uploadTargetComic ? `Thêm chương vào: ${uploadTargetComic.title}` : 'Tải truyện từ máy lên'}
            </h2>
          </div>
          <button
            type="button"
            onClick={closeUploadModal}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-container hover:text-text-primary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!uploadTargetComic && (
            <>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-on-surface-variant">
                  Tên bộ truyện
                </label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Ví dụ: Solo Leveling, Doraemon..."
                  className="w-full rounded-lg border border-border-subtle bg-surface-container px-3.5 py-2.5 text-[16px] text-text-primary outline-none focus:border-primary-container sm:text-sm"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-on-surface-variant">
                  Mô tả ngắn (không bắt buộc)
                </label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Tóm tắt ngắn nội dung truyện..."
                  className="w-full rounded-lg border border-border-subtle bg-surface-container px-3.5 py-2 text-[16px] text-text-primary outline-none focus:border-primary-container sm:text-sm"
                />
              </div>
            </>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-semibold text-on-surface-variant">
              Tên chương
            </label>
            <input
              type="text"
              required
              value={chapterTitle}
              onChange={(e) => setChapterTitle(e.target.value)}
              placeholder="Chương 1"
              className="w-full rounded-lg border border-border-subtle bg-surface-container px-3.5 py-2.5 text-[16px] text-text-primary outline-none focus:border-primary-container sm:text-sm"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold text-on-surface-variant">
              Chọn nhiều ảnh (JPG/PNG/WEBP), hoặc 1 file ZIP / CBZ / PDF
            </label>
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-outline-variant bg-surface-container px-4 py-6 text-center transition hover:border-primary-container hover:bg-surface-container-high">
              <FileUp className="h-7 w-7 text-primary" />
              <span className="text-sm font-semibold text-text-primary">
                {files.length
                  ? `Đã chọn ${files.length} tệp (${(
                      files.reduce((acc, f) => acc + f.size, 0) /
                      (1024 * 1024)
                    ).toFixed(2)} MB)`
                  : 'Bấm để chọn tệp từ thiết bị'}
              </span>
              <span className="text-xs text-text-secondary">
                Hỗ trợ tối đa 200 trang / 120MB mỗi chương
              </span>
              <input
                type="file"
                multiple
                accept="image/*,.zip,.cbz,.pdf"
                className="hidden"
                onChange={(e) => setFiles(Array.from(e.target.files || []))}
              />
            </label>
          </div>

          {error && (
            <div className="rounded-lg border border-badge-hot-bg/40 bg-badge-hot-bg/10 px-3.5 py-2 text-xs text-secondary">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-accent-green py-2.5 text-sm font-bold text-white transition hover:brightness-110 active:scale-[0.98] disabled:opacity-60"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting ? 'Đang xử lý trang truyện...' : 'Tải lên & mở đọc ngay'}
          </button>
        </form>
      </div>
    </div>
  );
}
