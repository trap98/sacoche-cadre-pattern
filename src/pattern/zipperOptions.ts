import { makeDefaultZipper } from './defaults';
import type { FaceOptions } from './types';

export function updateNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function ensureZipperCount(face: FaceOptions, zipperCount: 0 | 1 | 2): FaceOptions {
  return {
    zipperCount,
    zippers: Array.from(
      { length: zipperCount },
      (_, index) => face.zippers[index] ?? makeDefaultZipper(index),
    ),
  };
}

export function zipperBottomClearanceValue(
  zipper: FaceOptions['zippers'][number],
  shapeHeightMm: number,
  cutoutHeightMm: number,
): number {
  const clearanceFromBottom = zipper.clearanceFromBottomTubeMm;

  if (clearanceFromBottom !== undefined && Number.isFinite(clearanceFromBottom)) {
    return clearanceFromBottom;
  }

  return Math.max(0, shapeHeightMm - zipper.distanceFromTopTubeMm - cutoutHeightMm / 2);
}

export function resolveZipperDistanceFromTopMm(
  zipper: FaceOptions['zippers'][number],
  zipperIndex: number,
  shapeHeightMm: number,
  cutoutHeightMm: number,
): number {
  if (
    zipperIndex === 1 &&
    zipper.clearanceFromBottomTubeMm !== undefined &&
    Number.isFinite(zipper.clearanceFromBottomTubeMm)
  ) {
    return Math.max(0, shapeHeightMm - zipper.clearanceFromBottomTubeMm - cutoutHeightMm / 2);
  }

  return zipper.distanceFromTopTubeMm;
}
