import type { FromCanvas, ToCanvas } from '../contract.ts';

/**
 * The designer also tells the canvas which theme the editor uses. This is an additive message that
 * lives here, not in the shared contract, until the contract owner takes it over.
 */
export type ThemeMessage = { type: 'theme'; theme: 'light' | 'dark' | null };

export type ToCanvasMessage = ToCanvas | ThemeMessage;
export type { FromCanvas };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Checks the shape of a message from outside. Anything else is dropped. */
export function parseToCanvas(data: unknown): ToCanvasMessage | null {
  if (!isObject(data)) return null;
  switch (data.type) {
    case 'definition':
      return isObject(data.definition) && Array.isArray(data.definition.components) ? (data as unknown as ToCanvasMessage) : null;
    case 'reveal':
      return data.id === null || typeof data.id === 'string' ? (data as unknown as ToCanvasMessage) : null;
    case 'theme':
      return data.theme === null || data.theme === 'light' || data.theme === 'dark' ? (data as unknown as ToCanvasMessage) : null;
    default:
      return null;
  }
}

const isBox = (value: unknown): boolean =>
  isObject(value) &&
  typeof value.id === 'string' &&
  (value.parentId === null || typeof value.parentId === 'string') &&
  ['x', 'y', 'width', 'height', 'depth'].every((key) => typeof value[key] === 'number') &&
  typeof value.visible === 'boolean' &&
  (value.content === undefined || (isObject(value.content) && ['x', 'y', 'width', 'height'].every((key) => typeof (value.content as Record<string, unknown>)[key] === 'number')));

/** Checks the shape of a message from the canvas. */
export function parseFromCanvas(data: unknown): FromCanvas | null {
  if (!isObject(data)) return null;
  switch (data.type) {
    case 'ready':
      return { type: 'ready' };
    case 'error':
      return typeof data.message === 'string' ? { type: 'error', message: data.message } : null;
    case 'boxes':
      return Array.isArray(data.boxes) && data.boxes.every(isBox) && typeof data.formWidth === 'number' && typeof data.formHeight === 'number'
        ? (data as unknown as FromCanvas)
        : null;
    default:
      return null;
  }
}
