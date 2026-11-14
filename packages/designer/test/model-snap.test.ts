import { describe, expect, it } from 'vitest';
import { snapMove, snapResize, type Rect } from '../src/index.ts';

const box: Rect = { x: 100, y: 100, width: 80, height: 40 };

describe('snapMove', () => {
  it('snaps the top-left to the 8 px grid', () => {
    const result = snapMove(box, 5, -3, { siblings: [] });
    // 105 -> 104, 97 -> 96
    expect(result).toEqual({ dx: 4, dy: -4, guides: [] });
  });

  it('leaves the delta alone when nothing is within the threshold', () => {
    // 100 + 4 = 104 is on the grid; the grid is 8, threshold 5, so 3 away from a line snaps, 4 away also snaps.
    expect(snapMove({ ...box, x: 0, y: 0 }, 4, 4, { siblings: [], threshold: 1 })).toEqual({ dx: 4, dy: 4, guides: [] });
    expect(snapMove({ ...box, x: 0, y: 0 }, 3, 3, { siblings: [], threshold: 1 })).toEqual({ dx: 3, dy: 3, guides: [] });
  });

  it('snaps to a sibling edge and draws a guide', () => {
    const sibling: Rect = { x: 203, y: 300, width: 50, height: 50 };
    // Box left edge would be 100 + 100 = 200, the sibling's left edge is 203.
    const result = snapMove(box, 100, 0, { siblings: [sibling], grid: 0 });
    expect(result.dx).toBe(103);
    expect(result.guides).toEqual([{ axis: 'x', position: 203, from: 100, to: 350, kind: 'edge' }]);
  });

  it('snaps the box right edge to a sibling left edge', () => {
    const sibling: Rect = { x: 300, y: 0, width: 50, height: 20 };
    // Right edge: 100 + 80 + 118 = 298, the sibling's left edge is 300.
    const result = snapMove(box, 118, 0, { siblings: [sibling], grid: 0 });
    expect(result.dx).toBe(120);
    expect(result.guides[0]).toMatchObject({ axis: 'x', position: 300 });
  });

  it('snaps centres to centres', () => {
    const sibling: Rect = { x: 0, y: 200, width: 400, height: 20 };
    // The box centre is x = 140 + dx, the sibling centre is 200.
    const result = snapMove(box, 57, 0, { siblings: [sibling], grid: 0 });
    expect(result.dx).toBe(60);
    expect(result.guides.find((g) => g.axis === 'x')).toMatchObject({ position: 200, kind: 'centre' });
  });

  it('prefers a sibling over the grid, and the nearest sibling feature', () => {
    const near: Rect = { x: 202, y: 0, width: 10, height: 10 };
    const far: Rect = { x: 204, y: 50, width: 10, height: 10 };
    const result = snapMove(box, 100, 0, { siblings: [far, near] });
    // The grid line 200 is 0 away from the raw 200, but a sibling edge within the threshold wins.
    expect(result.dx).toBe(102);
    expect(result.guides.filter((g) => g.axis === 'x').map((g) => g.position)).toEqual([202]);
  });

  it('snaps both axes independently', () => {
    const sibling: Rect = { x: 500, y: 203, width: 10, height: 10 };
    const result = snapMove(box, 5, 100, { siblings: [sibling] });
    expect(result.dx).toBe(4);
    expect(result.dy).toBe(103);
    expect(result.guides.map((g) => g.axis)).toEqual(['y']);
  });

  it('draws one line for the targets the snap lands on, long enough to reach all of them', () => {
    const a: Rect = { x: 203, y: 0, width: 10, height: 10 };
    const b: Rect = { x: 203, y: 400, width: 10, height: 10 };
    const result = snapMove(box, 100, 0, { siblings: [a, b], grid: 0 });
    const guides = result.guides.filter((g) => g.axis === 'x' && g.position === 203);
    expect(guides.map((g) => [g.from, g.to])).toEqual([[0, 410]]);
  });

  it('does nothing but round when disabled (Alt)', () => {
    const sibling: Rect = { x: 203, y: 0, width: 10, height: 10 };
    expect(snapMove(box, 100.4, 5.6, { siblings: [sibling], disabled: true })).toEqual({ dx: 100, dy: 6, guides: [] });
  });
});

describe('snapResize', () => {
  it('snaps the dragged edge to the grid', () => {
    // East handle: right edge 180 + 5 = 185 -> 184.
    expect(snapResize(box, 'e', 5, 99, { siblings: [] })).toEqual({ dx: 4, dy: 0, guides: [] });
    // South-east handle: right edge 180 + 4 = 184 stays, bottom edge 140 + 6 = 146 -> 144.
    expect(snapResize(box, 'se', 4, 6, { siblings: [] })).toEqual({ dx: 4, dy: 4, guides: [] });
  });

  it('snaps the west edge, not the east one', () => {
    // Left edge 100 + 3 = 103 -> 104
    expect(snapResize(box, 'w', 3, 0, { siblings: [] }).dx).toBe(4);
  });

  it('snaps to a sibling edge with a guide spanning both boxes', () => {
    const sibling: Rect = { x: 200, y: 10, width: 50, height: 20 };
    // Right edge 180 + 18 = 198, the sibling's left is 200.
    const result = snapResize(box, 'e', 18, 0, { siblings: [sibling], grid: 0 });
    expect(result.dx).toBe(20);
    expect(result.guides).toEqual([{ axis: 'x', position: 200, from: 10, to: 140, kind: 'edge' }]);
  });

  it('keeps the minimum size', () => {
    const result = snapResize(box, 'e', -75, 0, { siblings: [], min: 8 });
    // 80 - 75 = 5, below the minimum of 8, so the delta stops at 72.
    expect(result.dx).toBe(-72);
    expect(result.guides).toEqual([]);
  });

  it('does not snap while Alt is held', () => {
    expect(snapResize(box, 'se', 5, 6, { siblings: [], disabled: true })).toEqual({ dx: 5, dy: 6, guides: [] });
  });

  it('does not move an axis the handle does not drag', () => {
    const result = snapResize(box, 'n', 7, 3, { siblings: [] });
    expect(result.dx).toBe(0);
    expect(result.dy).toBe(4);
  });
});
