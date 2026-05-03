import type { FaceOptions, PatternParameters, ZipperOptions } from './types';

export const DEFAULT_ZIPPER_DISTANCES_MM = [40, 200] as const;

export function makeDefaultZipper(index: number): ZipperOptions {
  return {
    id: `zip-${index + 1}`,
    distanceFromTopTubeMm:
      DEFAULT_ZIPPER_DISTANCES_MM[index] ??
      DEFAULT_ZIPPER_DISTANCES_MM[DEFAULT_ZIPPER_DISTANCES_MM.length - 1],
  };
}

export function makeFaceOptions(zipperCount: 0 | 1 | 2): FaceOptions {
  return {
    zipperCount,
    zippers: Array.from({ length: zipperCount }, (_, index) => makeDefaultZipper(index)),
  };
}

export const DEFAULT_PATTERN_PARAMETERS: PatternParameters = {
  seamAllowanceMm: 10,
  bagDepthMm: 55,
  zipperCutoutHeightMm: 12,
  zipperEndPatchWidthMm: 35,
  zipperEndPatchHeightMm: 28,
  zipperCoverWidthMm: 32,
  zipperCoverLengthMm: 40,
  zipperCoverGapMm: 15,
  faceA: makeFaceOptions(0),
  faceB: makeFaceOptions(0),
  gusset: {
    splitMode: 'single-piece',
    angleBreakThresholdDeg: 25,
  },
};
