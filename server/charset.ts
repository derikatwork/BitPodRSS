function label(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const l = raw.trim().replace(/^["']|["']$/g, '').toLowerCase();
  try {
    new TextDecoder(l);
    return l;
  } catch {
    return undefined;
  }
}

/**
 * Decode a response body to a string honouring, in order: the Content-Type charset, an XML declaration
 * or HTML <meta> charset near the top of the document, then UTF-8.
 */
export function decodeBody(body: Uint8Array, contentType = ''): string {
  let charset = label(/charset=([^;\s]+)/i.exec(contentType)?.[1]);
  if (!charset) {
    const head = new TextDecoder('latin1').decode(body.subarray(0, 2048));
    charset =
      label(/<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(head)?.[1]) ??
      label(/<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]) ??
      'utf-8';
  }
  return new TextDecoder(charset).decode(body);
}
