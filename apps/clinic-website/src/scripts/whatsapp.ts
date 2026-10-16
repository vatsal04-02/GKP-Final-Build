/**
 * Opens a WhatsApp link in a new tab from inside a click/submit handler.
 *
 * `window.open(url, '_blank', 'noopener')` always returns null (that is what `noopener` means), so a
 * "popup blocked → navigate this tab" fallback would also navigate the tab the visitor is on. A real
 * anchor click opens exactly one new tab, is allowed inside a user gesture, and keeps the page where it is.
 */
export function openWhatsApp(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
}
