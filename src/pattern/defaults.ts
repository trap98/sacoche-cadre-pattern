import type { FaceOptions, PatternParameters, ZipperOptions } from './types';

export const DEFAULT_ZIPPER_DISTANCES_MM = [40, 200] as const;
export const DEFAULT_ZIPPER_BOTTOM_CLEARANCE_MM = 210;
export const DEFAULT_CABLE_PASS_SEGMENT_INDEX = 2;
export const DEFAULT_CABLE_PASS_DISTANCE_FROM_TOP_MM = 50;
export const DEFAULT_CABLE_PASS_OVERLAP_MM = 20;

export function makeDefaultZipper(index: number): ZipperOptions {
  return {
    id: `zip-${index + 1}`,
    distanceFromTopTubeMm:
      DEFAULT_ZIPPER_DISTANCES_MM[index] ??
      DEFAULT_ZIPPER_DISTANCES_MM[DEFAULT_ZIPPER_DISTANCES_MM.length - 1],
    ...(index === 1 ? { clearanceFromBottomTubeMm: DEFAULT_ZIPPER_BOTTOM_CLEARANCE_MM } : {}),
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
  bagDepthMm: 50,
  zipperCutoutHeightMm: 30,
  zipperEndPatchWidthMm: 60,
  zipperEndPatchHeightMm: 35,
  zipperCoverWidthMm: 35,
  zipperCoverLengthMm: 60,
  zipperCoverGapMm: 22,
  sublimationScalePct: 100,
  faceA: makeFaceOptions(0),
  faceB: makeFaceOptions(0),
  gusset: {
    splitMode: 'single-piece',
    angleBreakThresholdDeg: 25,
    manualBreakSegmentIndices: [],
    cablePass: {
      enabled: true,
      segmentIndex: DEFAULT_CABLE_PASS_SEGMENT_INDEX,
      distanceFromTopMm: DEFAULT_CABLE_PASS_DISTANCE_FROM_TOP_MM,
      overlapMm: DEFAULT_CABLE_PASS_OVERLAP_MM,
    },
  },
};
