// Tactical cleanup for plain-text email bodies before rendering. We don't
// render HTML (security + tracking concerns) but the text/plain version of
// marketing/transactional emails dumps every CDN URL and tracking redirect
// inline, which buries the actual content. Collapse those down so an
// operator can scan a draft in 2s instead of scrolling past 20 lines of URL.

const URL_LONG = 60;

// `[https://foo.example.com/path/file.png]` → `[image: file.png]`
// Used by Gmail/Apple Mail when text/plain version of an HTML email
// references inline images via markdown-ish syntax.
const MARKDOWN_IMG_RE = /\[(https?:\/\/[^\s\]]+\.(?:png|jpe?g|gif|webp|svg))\]/gi;

// Bare URL of any length. We only collapse if length > URL_LONG.
const BARE_URL_RE = /https?:\/\/[^\s\]<>)]+/g;

export function formatEmailBody(body: string): string {
  let out = body;

  out = out.replace(MARKDOWN_IMG_RE, (_match, url: string) => {
    const filename = url.split('/').pop()?.split('?')[0] ?? 'image';
    return `[image: ${filename}]`;
  });

  out = out.replace(BARE_URL_RE, (url) => {
    if (url.length <= URL_LONG) return url;
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return `[link: ${host}]`;
    } catch {
      return '[link]';
    }
  });

  // Collapse 3+ blank lines to a single blank line — long footers / tracking
  // tables often leave whitespace ladders behind once URLs are stripped.
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}
