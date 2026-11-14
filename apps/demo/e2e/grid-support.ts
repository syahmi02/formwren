import type { Locator, Page } from '@playwright/test';

/** What the page says the active cell is: read from `aria-activedescendant`, the way a screen reader would. */
export interface ActiveCell {
  id: string;
  index: number;
  rowId: number;
  track: number;
  text: string;
  /** The id resolves to an element inside the Grid. */
  valid: boolean;
}

export const gridOf = (page: Page): Locator => page.getByRole('grid');

/** A record cell by its position in the view and its track. Only exists while the row is rendered. */
export const cellAt = (page: Page, index: number, track: number): Locator =>
  page.locator(`.fw-grid__row[data-index="${index}"] .fw-grid__cell[data-track="${track}"]`);

/** A record cell by row id, which does not change when the Grid is sorted. */
export const cellOfRow = (page: Page, rowId: number, track: number): Locator =>
  page.locator(`.fw-grid__row[data-row-id="${rowId}"] .fw-grid__cell[data-track="${track}"]`);

export const headerCell = (page: Page, text: string): Locator =>
  page.locator('.fw-grid__header .fw-grid__cell', { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });

export async function activeCell(page: Page): Promise<ActiveCell | null> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.fw-grid');
    const id = root?.getAttribute('aria-activedescendant');
    if (!root || !id) return null;
    const el = document.getElementById(id);
    const row = el?.closest<HTMLElement>('.fw-grid__row');
    if (!el || !row) return { id, index: -1, rowId: -1, track: -1, text: '', valid: false };
    return {
      id,
      index: Number(row.dataset.index),
      rowId: Number(row.dataset.rowId),
      track: Number(el.dataset.track),
      text: el.textContent ?? '',
      valid: root.contains(el),
    };
  });
}

/** Where the active cell is, as `[index, track]`, for `expect.poll`. */
export async function activePosition(page: Page): Promise<[number, number] | null> {
  const a = await activeCell(page);
  return a ? [a.index, a.track] : null;
}

/** True if `aria-activedescendant` is set, resolves to a rendered cell inside the Grid, and that cell is the one marked `data-active`. */
export async function activeDescendantIsValid(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.fw-grid');
    const id = root?.getAttribute('aria-activedescendant');
    if (!root || !id) return false;
    const el = document.getElementById(id);
    return Boolean(el && root.contains(el) && el.hasAttribute('data-active') && el.getAttribute('role') === 'gridcell');
  });
}

export interface WindowStats {
  frames: { n: number; mean: number; p50: number; p95: number; p99: number; max: number; over20: number; over34: number };
  longTasks: number;
  longestTaskMs: number;
}

/** Runs `work`, and reports the frame times and long tasks the page saw meanwhile. Needs window.p1 (the P1 page). */
export async function measureWindow(page: Page, work: () => Promise<void>): Promise<WindowStats> {
  const before = await page.evaluate(() => {
    const p1 = (window as unknown as { p1: { startFrames(): void; longTasks(): unknown[] } }).p1;
    p1.startFrames();
    return p1.longTasks().length;
  });
  await work();
  return page.evaluate((count) => {
    const p1 = (window as unknown as { p1: { stopFrames(): WindowStats['frames']; longTasks(): { duration: number }[] } }).p1;
    const frames = p1.stopFrames();
    const tasks = p1.longTasks().slice(count);
    return { frames, longTasks: tasks.length, longestTaskMs: Math.round(Math.max(0, ...tasks.map((t) => t.duration)) * 10) / 10 };
  }, before);
}
