import DOMPurify from 'dompurify';

let hooked = false;

function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    if (node.tagName === 'IMG') {
      node.setAttribute('loading', 'lazy');
      node.setAttribute('referrerpolicy', 'no-referrer');
      node.removeAttribute('srcset'); // avoids tracking-pixel style variants and layout surprises
    }
  });
}

/**
 * Sanitise untrusted feed / article HTML for display. Scripts, styles, forms, frames and event handlers
 * are removed; links open in a new tab without leaking the opener.
 */
export function sanitizeHtml(html: string): string {
  ensureHooks();
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea', 'iframe', 'object', 'embed', 'link', 'meta'],
    FORBID_ATTR: ['style'],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
  });
}
