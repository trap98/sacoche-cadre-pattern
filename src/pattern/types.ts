export type Point = {
  x: number;
  y: number;
};

export type ValidatedBagShape = {
  outline: Point[];
  closed: true;
  unit: 'mm';
};

export type PatternParameters = {
  seamAllowanceMm: number;
  bagDepthMm: number;
  zipperCutoutHeightMm: number;
  zipperEndPatchWidthMm: number;
  zipperEndPatchHeightMm: number;
  zipperCoverWidthMm: number;
  zipperCoverLengthMm: number;
  zipperCoverGapMm: number;
  faceA: FaceOptions;
  faceB: FaceOptions;
  gusset: GussetOptions;
};

export type FaceOptions = {
  zipperCount: 0 | 1 | 2;
  zippers: ZipperOptions[];
};

export type ZipperOptions = {
  id: string;
  distanceFromTopTubeMm: number;
  clearanceFromBottomTubeMm?: number;
};

export type GussetOptions = {
  splitMode: 'single-piece' | 'one-piece-per-tube';
  angleBreakThresholdDeg: number;
};

export type PatternPiece = {
  id: string;
  label: string;
  kind:
    | 'face-panel'
    | 'face-panel-upper'
    | 'face-panel-lower'
    | 'gusset'
    | 'zip-end-patch'
    | 'zip-cover'
    | 'reference';
  paths: Point[][];
  referencePaths?: Point[][];
  annotations: PatternAnnotation[];
};

export type PatternAnnotation = {
  type: 'label' | 'fold-line' | 'stitch-line' | 'zip-line' | 'grain-line';
  label?: string;
  points: Point[];
};
