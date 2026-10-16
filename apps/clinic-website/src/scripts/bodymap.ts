/**
 * Body map: each hotspot scrolls to the condition card whose title matches `data-bodymap-target`
 * (case-insensitive) and flashes an orange ring around it for 1.2s.
 */

const FLASH_MS = 1200;
const norm = (s: string | null | undefined): string => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export function initBodyMap(root: HTMLElement, reduceMotion: boolean): void {
  const status = root.querySelector<HTMLElement>('[data-bodymap-status]');
  const cards = Array.from(document.querySelectorAll<HTMLElement>('#conditions .card'));
  let flashTimer = 0;
  let pending: (() => void) | null = null;

  const flash = (cell: HTMLElement): void => {
    window.clearTimeout(flashTimer);
    document.querySelectorAll('.cell.is-flash').forEach((el) => el.classList.remove('is-flash'));
    void cell.offsetWidth; // restart the animation if the same card is chosen twice
    cell.classList.add('is-flash');
    flashTimer = window.setTimeout(() => cell.classList.remove('is-flash'), FLASH_MS);
  };

  // Flash once the page has finished scrolling (or straight away if it is already in place)
  const afterScroll = (run: () => void): void => {
    if (pending) window.removeEventListener('scrollend', pending);
    let done = false;
    let timer = 0;
    const fire = (): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      window.removeEventListener('scrollend', fire);
      pending = null;
      run();
    };
    pending = fire;
    window.addEventListener('scrollend', fire, { once: true });
    timer = window.setTimeout(fire, reduceMotion ? 0 : 1000); // browsers without `scrollend`, or nothing to scroll
  };

  root.querySelectorAll<HTMLButtonElement>('[data-bodymap-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wanted = norm(btn.dataset.bodymapTarget);
      const card = cards.find((c) => norm(c.querySelector('.card__title')?.textContent) === wanted);
      const cell = card?.closest<HTMLElement>('.cell');
      if (!card || !cell) return;

      const r = cell.getBoundingClientRect();
      const inPlace = Math.abs(r.top + r.height / 2 - window.innerHeight / 2) < 6;
      cell.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center', inline: 'nearest' });
      if (status) status.textContent = `Showing the ${card.querySelector('.card__title')?.textContent?.trim()} card`;
      if (inPlace) flash(cell);
      else afterScroll(() => flash(cell));
    });
  });
}
