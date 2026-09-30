// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from './sanitize';

describe('sanitizeHtml', () => {
  it('removes scripts, event handlers, javascript: URLs, frames, forms and styles', () => {
    const dirty = `
      <p onclick="alert(1)">Hello <b>world</b></p>
      <script>alert(2)</script>
      <a href="javascript:alert(3)">bad</a>
      <iframe src="https://evil.example"></iframe>
      <form action="https://evil.example"><input name="x"><button>go</button></form>
      <style>body{display:none}</style>
      <img src="x" onerror="alert(4)">
      <svg onload="alert(5)"><script>alert(6)</script></svg>
      <div style="position:fixed;inset:0">overlay</div>`;
    const clean = sanitizeHtml(dirty);
    for (const needle of ['alert', 'onclick', 'onerror', 'onload', 'javascript:', '<iframe', '<form', '<input', '<button', '<style', 'position:fixed', '<script']) {
      expect(clean, needle).not.toContain(needle);
    }
    expect(clean).toContain('<b>world</b>');
    expect(clean).toContain('overlay');
  });

  it('keeps ordinary content and makes links safe to open', () => {
    const clean = sanitizeHtml('<p>Read <a href="https://example.com/a">this</a> and <a href="mailto:a@b.co">mail</a></p><img src="https://example.com/i.png" alt="pic" srcset="a 1x">');
    expect(clean).toContain('href="https://example.com/a"');
    expect(clean).toContain('target="_blank"');
    expect(clean).toMatch(/rel="noopener noreferrer nofollow"/);
    expect(clean).toContain('mailto:a@b.co');
    expect(clean).toContain('loading="lazy"');
    expect(clean).toContain('referrerpolicy="no-referrer"');
    expect(clean).not.toContain('srcset');
  });

  it('strips the href from links using data:, ftp: and other non-web schemes', () => {
    const clean = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a><a href="ftp://x">f</a><a href="vbscript:msgbox(1)">v</a>');
    expect(clean).not.toMatch(/href=/);
    expect(clean).not.toContain('alert');
    expect(clean).toContain('>x</a>'); // the text survives
  });

  it('allows inline data: images (they cannot execute script) but never scriptable SVG content', () => {
    const clean = sanitizeHtml('<img src="data:image/png;base64,AAAA"><svg><a xlink:href="javascript:alert(1)"><text>t</text></a></svg>');
    expect(clean).toContain('data:image/png');
    expect(clean).not.toContain('javascript:');
  });
});
