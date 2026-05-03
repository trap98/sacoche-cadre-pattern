import type { Point, ValidatedBagShape } from './types';

export function createValidatedBagShape(
  points: Point[],
  isClosed: boolean,
  mmPerUnit: number,
): ValidatedBagShape {
  if (!isClosed) {
    throw new Error('Cannot validate an open outline.');
  }

  if (points.length < 3) {
    throw new Error('A validated outline must contain at least three points.');
  }

  if (!Number.isFinite(mmPerUnit) || mmPerUnit <= 0) {
    throw new Error('Millimeter scale must be greater than zero.');
  }

  return {
    outline: points.map((point) => ({
      x: point.x * mmPerUnit,
      y: point.y * mmPerUnit,
    })),
    closed: true,
    unit: 'mm',
  };
}
