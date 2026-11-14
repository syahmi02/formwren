import type { LayoutDefinition } from '@fw/core';

/** The smallest width or height a resize leaves a component with. */
export const MIN_SIZE = 8;

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** The size a component has on the canvas now. It lets a resize clamp a box that has both opposite edges set. */
export interface BoxSize {
  width: number;
  height: number;
}

export interface ResizeOptions {
  /** The component's current size. Without it, a box with both edges and no size can't be clamped. */
  size?: BoxSize;
  /** Defaults to `MIN_SIZE`. */
  min?: number;
}

function whole(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

/** Which of the two edges on one axis exist, in the order start (left/top), end (right/bottom), size. */
interface Axis {
  start: 'left' | 'top';
  end: 'right' | 'bottom';
  size: 'width' | 'height';
}

const HORIZONTAL: Axis = { start: 'left', end: 'right', size: 'width' };
const VERTICAL: Axis = { start: 'top', end: 'bottom', size: 'height' };

function moveAxis(layout: LayoutDefinition, axis: Axis, delta: number, out: LayoutDefinition): void {
  if (delta === 0) return;
  // Moving right makes `left` bigger and `right` (the gap to the right side) smaller.
  if (layout[axis.start] !== undefined) out[axis.start] = (layout[axis.start] as number) + delta;
  if (layout[axis.end] !== undefined) out[axis.end] = (layout[axis.end] as number) - delta;
}

/** Moves a layout by a whole number of pixels. Only edges it already has are changed. */
export function moveLayout(layout: LayoutDefinition, dx: number, dy: number): LayoutDefinition {
  const out = { ...layout };
  moveAxis(layout, HORIZONTAL, whole(dx), out);
  moveAxis(layout, VERTICAL, whole(dy), out);
  return out;
}

/**
 * Moves the edge a handle drags on one axis. `side` is 'start' for left/top, 'end' for right/bottom.
 * The delta is first limited so the size stays at `min`, if the size is known.
 */
function resizeAxis(layout: LayoutDefinition, axis: Axis, side: 'start' | 'end', rawDelta: number, options: ResizeOptions, out: LayoutDefinition): void {
  let delta = whole(rawDelta);
  if (delta === 0) return;
  const min = options.min ?? MIN_SIZE;
  const start = layout[axis.start];
  const end = layout[axis.end];
  const size = layout[axis.size];
  const known = size ?? options.size?.[axis.size];
  // Dragging the far edge outwards, or the near edge inwards, grows or shrinks by `delta`.
  const growth = side === 'end' ? delta : -delta;
  if (known !== undefined && growth < 0 && known + growth < min) {
    // Stop at the minimum. The current size may already be below it, so never push it further down.
    const allowed = Math.min(min - known, 0);
    delta = side === 'end' ? allowed : -allowed;
    if (delta === 0) return;
  }

  if (side === 'end') {
    // The far edge moves by `delta`: `end` is a gap, so it shrinks.
    if (end !== undefined) out[axis.end] = end - delta;
    if (size !== undefined) out[axis.size] = size + delta;
  } else {
    // The near edge moves by `delta`.
    if (start !== undefined) out[axis.start] = start + delta;
    // With `end` and a size, the far edge stays where it is, so only the size changes.
    if (size !== undefined) out[axis.size] = size - delta;
  }
}

/**
 * Resizes a layout by dragging a handle. The layout keeps its edges: a box set by `right` and
 * `bottom` stays that way, and its numbers change so the opposite side stays where it was.
 */
export function resizeLayout(layout: LayoutDefinition, handle: ResizeHandle, dx: number, dy: number, options: ResizeOptions = {}): LayoutDefinition {
  const out = { ...layout };
  if (handle.includes('e')) resizeAxis(layout, HORIZONTAL, 'end', dx, options, out);
  if (handle.includes('w')) resizeAxis(layout, HORIZONTAL, 'start', dx, options, out);
  if (handle.includes('s')) resizeAxis(layout, VERTICAL, 'end', dy, options, out);
  if (handle.includes('n')) resizeAxis(layout, VERTICAL, 'start', dy, options, out);
  return out;
}
