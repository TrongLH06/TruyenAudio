import { resolveBackendUrl } from './api';

export function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < 768;
}

export function getMobileImageUrl(url: string, targetWidth: number, quality = 78): string {
  if (!url) return '';
  const shouldResize =
    isMobileViewport() &&
    url.startsWith('/api/comics/proxy-image?') &&
    !url.includes('&w=');
  const finalPath = shouldResize ? `${url}&w=${targetWidth}&q=${quality}` : url;
  return resolveBackendUrl(finalPath);
}
