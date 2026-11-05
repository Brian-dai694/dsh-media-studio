// Pure path resolution for the isolated video-plugin local harness wrapper.
// The wrapper page is video/host.html; its relative asset (host.js) is served from the
// same video subtree. This is a local harness route, never a DSH runtime registration.
export const VIDEO_HOST_PREFIX = '/video-host/';
const SAFE_ASSET = /^[a-zA-Z0-9._/-]+$/;

export function resolveVideoHostAsset(pathname) {
  if (typeof pathname !== 'string') return { status: 404 };
  if (pathname === '/video-host') return { redirect: VIDEO_HOST_PREFIX };
  if (!(pathname === VIDEO_HOST_PREFIX || pathname.startsWith(VIDEO_HOST_PREFIX))) return null;
  let raw;
  try { raw = decodeURIComponent(pathname.slice(VIDEO_HOST_PREFIX.length)); } catch { return { status: 404 }; }
  const name = raw || 'host.html';
  if (name.includes('..') || name.startsWith('/') || name.endsWith('.map') ||
      !SAFE_ASSET.test(name) || name.startsWith('tests/') || name === 'host.html/') return { status: 404 };
  return { asset: name };
}
