import type {
  CablePassOptions,
  GussetOptions,
  PatternAnnotation,
  PatternParameters,
  PatternPiece,
  Point,
  ValidatedBagShape,
} from './types';
import { applyApproximateSeamAllowance, boundingBox, polygonPerimeter, rectangle, segmentLength } from './geometry';

type GussetSection = {
  startSegmentIndex: number;
  segmentCount: number;
  length: number;
};

type SeamlessEdge = 'left' | 'right';

function rectangularSeamAllowancePath(
  length: number,
  depth: number,
  seamAllowanceMm: number,
  seamlessEdges: SeamlessEdge[] = [],
): Point[] {
  if (seamAllowanceMm <= 0) {
    return rectangle(length, depth);
  }

  const hasNoLeftSeam = seamlessEdges.includes('left');
  const hasNoRightSeam = seamlessEdges.includes('right');

  return rectangle(
    length + (hasNoLeftSeam ? 0 : seamAllowanceMm) + (hasNoRightSeam ? 0 : seamAllowanceMm),
    depth + seamAllowanceMm * 2,
    {
      x: hasNoLeftSeam ? 0 : -seamAllowanceMm,
      y: -seamAllowanceMm,
    },
  );
}

function segmentMarkAnnotations(
  xPositions: number[],
  depth: number,
  seamAllowanceMm: number,
): PatternAnnotation[] {
  const tickDepth = Math.min(5, seamAllowanceMm);

  return xPositions.flatMap((x) => [
    {
      type: 'segment-mark' as const,
      points: [
        { x, y: -seamAllowanceMm },
        { x, y: -seamAllowanceMm + tickDepth },
      ],
    },
    {
      type: 'segment-mark' as const,
      points: [
        { x, y: depth + seamAllowanceMm },
        { x, y: depth + seamAllowanceMm - tickDepth },
      ],
    },
  ]);
}

function makeGussetPiece(
  id: string,
  label: string,
  length: number,
  depth: number,
  seamAllowanceMm: number,
  extraAnnotations: PatternAnnotation[] = [],
  seamlessEdges: SeamlessEdge[] = [],
  segmentBreakXPositions: number[] = [],
): PatternPiece {
  const referencePath = rectangle(length, depth);
  const path =
    seamlessEdges.length > 0
      ? rectangularSeamAllowancePath(length, depth, seamAllowanceMm, seamlessEdges)
      : applyApproximateSeamAllowance(referencePath, seamAllowanceMm);
  const bounds = boundingBox(path);

  return {
    id,
    label,
    kind: 'gusset',
    paths: [path],
    referencePaths: [referencePath],
    annotations: [
      {
        type: 'label',
        label,
        fontSizeMm: seamAllowanceMm * 0.4,
        points: [{ x: bounds.minX + bounds.width / 2, y: bounds.minY + seamAllowanceMm / 2 }],
      },
      {
        type: 'fold-line',
        label: 'Milieu soufflet',
        points: [
          { x: 0, y: depth / 2 },
          { x: length, y: depth / 2 },
        ],
      },
      ...segmentMarkAnnotations(segmentBreakXPositions, depth, seamAllowanceMm),
      ...extraAnnotations,
    ],
  };
}

function segmentLabel(index: number): string {
  if (index === 0) {
    return 'top tube';
  }

  return `segment ${index + 1}`;
}

function turnAngleDeg(previous: Point, current: Point, next: Point): number {
  const ax = current.x - previous.x;
  const ay = current.y - previous.y;
  const bx = next.x - current.x;
  const by = next.y - current.y;
  const aLength = Math.hypot(ax, ay);
  const bLength = Math.hypot(bx, by);

  if (aLength === 0 || bLength === 0) {
    return 0;
  }

  const dot = (ax * bx + ay * by) / (aLength * bLength);
  const clampedDot = Math.min(1, Math.max(-1, dot));

  return (Math.acos(clampedDot) * 180) / Math.PI;
}

function gussetSectionsByAngle(points: Point[], thresholdDeg: number): GussetSection[] {
  const segmentCount = points.length;

  if (segmentCount === 0) {
    return [];
  }

  const breakBeforeSegment = points.map((point, index) => {
    const previous = points[(index + segmentCount - 1) % segmentCount];
    const next = points[(index + 1) % segmentCount];
    return turnAngleDeg(previous, point, next) >= thresholdDeg;
  });
  const firstBreak = breakBeforeSegment.findIndex(Boolean);

  if (firstBreak === -1) {
    return [
      {
        startSegmentIndex: 0,
        segmentCount,
        length: polygonPerimeter(points),
      },
    ];
  }

  const sections: GussetSection[] = [];
  let currentStart = firstBreak;
  let currentLength = 0;
  let currentCount = 0;

  Array.from({ length: segmentCount }, (_, offset) => (firstBreak + offset) % segmentCount).forEach(
    (segmentIndex, offset) => {
      const nextPointIndex = (segmentIndex + 1) % segmentCount;
      currentLength += segmentLength(points[segmentIndex], points[nextPointIndex]);
      currentCount += 1;

      const nextSegmentIndex = (segmentIndex + 1) % segmentCount;
      const isLast = offset === segmentCount - 1;

      if (isLast || breakBeforeSegment[nextSegmentIndex]) {
        sections.push({
          startSegmentIndex: currentStart,
          segmentCount: currentCount,
          length: currentLength,
        });
        currentStart = nextSegmentIndex;
        currentLength = 0;
        currentCount = 0;
      }
    },
  );

  return sections;
}

function sectionLength(points: Point[], startSegmentIndex: number, segmentCount: number): number {
  return Array.from({ length: segmentCount }, (_, offset) => {
    const segmentIndex = (startSegmentIndex + offset) % points.length;
    return segmentLength(points[segmentIndex], points[(segmentIndex + 1) % points.length]);
  }).reduce((total, length) => total + length, 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sectionContainsSegment(section: GussetSection, segmentIndex: number, totalSegments: number): boolean {
  return Array.from(
    { length: section.segmentCount },
    (_, offset) => (section.startSegmentIndex + offset) % totalSegments,
  ).includes(segmentIndex);
}

function distanceFromSectionStartToSegment(
  points: Point[],
  section: GussetSection,
  segmentIndex: number,
): number {
  let distance = 0;

  for (let offset = 0; offset < section.segmentCount; offset += 1) {
    const currentSegmentIndex = (section.startSegmentIndex + offset) % points.length;

    if (currentSegmentIndex === segmentIndex) {
      return distance;
    }

    distance += segmentLength(points[currentSegmentIndex], points[(currentSegmentIndex + 1) % points.length]);
  }

  return distance;
}

function cablePassDistanceOnSegment(points: Point[], cablePass: CablePassOptions, segmentIndex: number): number {
  const segmentStart = points[segmentIndex];
  const segmentEnd = points[(segmentIndex + 1) % points.length];
  const length = segmentLength(segmentStart, segmentEnd);
  const distanceFromTopMm = cablePass.distanceFromTopMm;

  if (distanceFromTopMm !== undefined && Number.isFinite(distanceFromTopMm)) {
    const distanceFromTop = clamp(distanceFromTopMm, 0, length);
    const segmentStartIsTop = segmentStart.y <= segmentEnd.y;

    return segmentStartIsTop ? distanceFromTop : length - distanceFromTop;
  }

  return clamp(cablePass.distanceFromSegmentStartMm ?? length / 2, 0, length);
}

function internalSegmentBreakPositions(points: Point[], section: GussetSection): number[] {
  const positions: number[] = [];
  let accumulated = 0;

  for (let offset = 0; offset < section.segmentCount - 1; offset++) {
    const segmentIndex = (section.startSegmentIndex + offset) % points.length;
    accumulated += segmentLength(points[segmentIndex], points[(segmentIndex + 1) % points.length]);
    positions.push(accumulated);
  }

  return positions;
}

function makeGussetPiecesForSection(
  section: GussetSection,
  index: number,
  points: Point[],
  parameters: PatternParameters,
  idOverride?: string,
  labelOverride?: string,
): PatternPiece[] {
  const baseId = idOverride ?? `gusset-${index + 1}`;
  const baseLabel =
    labelOverride ??
    (section.segmentCount === 1
      ? `Soufflet ${segmentLabel(section.startSegmentIndex)}`
      : `Soufflet section ${index + 1}`);
  const cablePass = parameters.gusset.cablePass;
  const segmentCount = points.length;
  const cableSegmentIndex =
    cablePass && segmentCount > 0
      ? Math.trunc(clamp(cablePass.segmentIndex, 0, segmentCount - 1))
      : -1;
  const breakPositions = internalSegmentBreakPositions(points, section);

  if (
    !cablePass?.enabled ||
    cablePass.overlapMm <= 0 ||
    cableSegmentIndex < 0 ||
    !sectionContainsSegment(section, cableSegmentIndex, segmentCount)
  ) {
    return [
      makeGussetPiece(
        baseId,
        baseLabel,
        section.length,
        parameters.bagDepthMm,
        parameters.seamAllowanceMm,
        [],
        [],
        breakPositions,
      ),
    ];
  }

  const distanceToSegment = distanceFromSectionStartToSegment(points, section, cableSegmentIndex);
  const distanceToPass =
    distanceToSegment + cablePassDistanceOnSegment(points, cablePass, cableSegmentIndex);
  const beforeLength = distanceToPass + cablePass.overlapMm;
  const afterLength = section.length - distanceToPass;
  const pieces: PatternPiece[] = [];

  if (beforeLength > 0.001) {
    pieces.push(
      makeGussetPiece(
        `${baseId}-before-cable-pass`,
        `${baseLabel} - avant passe cable`,
        beforeLength,
        parameters.bagDepthMm,
        parameters.seamAllowanceMm,
        [],
        ['right'],
        breakPositions.filter((x) => x > 0 && x < beforeLength),
      ),
    );
  }

  if (afterLength > 0.001) {
    pieces.push(
      makeGussetPiece(
        `${baseId}-after-cable-pass`,
        `${baseLabel} - après passe cable`,
        afterLength,
        parameters.bagDepthMm,
        parameters.seamAllowanceMm,
        [],
        ['left'],
        breakPositions.filter((x) => x > distanceToPass).map((x) => x - distanceToPass),
      ),
    );
  }

  return pieces;
}

function gussetSectionsByManualBreaks(
  points: Point[],
  manualBreakSegmentIndices: number[] = [],
): GussetSection[] {
  const segmentCount = points.length;

  if (segmentCount === 0) {
    return [];
  }

  const breaks = Array.from(
    new Set(
      manualBreakSegmentIndices
        .map((index) => Math.trunc(index))
        .filter((index) => index >= 0 && index < segmentCount),
    ),
  ).sort((a, b) => a - b);

  if (breaks.length <= 1) {
    const startSegmentIndex = breaks[0] ?? 0;

    return [
      {
        startSegmentIndex,
        segmentCount,
        length: polygonPerimeter(points),
      },
    ];
  }

  return breaks.map((startSegmentIndex, index) => {
    const nextBreak = breaks[(index + 1) % breaks.length];
    const count =
      nextBreak > startSegmentIndex
        ? nextBreak - startSegmentIndex
        : segmentCount - startSegmentIndex + nextBreak;

    return {
      startSegmentIndex,
      segmentCount: count,
      length: sectionLength(points, startSegmentIndex, count),
    };
  });
}

export function generateGussetPieces(
  shape: ValidatedBagShape,
  gusset: GussetOptions,
  parameters: PatternParameters,
): PatternPiece[] {
  const effectiveParameters = {
    ...parameters,
    gusset,
  };

  if (gusset.splitMode === 'single-piece') {
    return makeGussetPiecesForSection(
      {
        startSegmentIndex: 0,
        segmentCount: shape.outline.length,
        length: polygonPerimeter(shape.outline),
      },
      0,
      shape.outline,
      effectiveParameters,
      'gusset-single-piece',
      'Soufflet une pièce',
    );
  }

  const sections =
    gusset.splitMode === 'manual'
      ? gussetSectionsByManualBreaks(shape.outline, gusset.manualBreakSegmentIndices)
      : gussetSectionsByAngle(shape.outline, gusset.angleBreakThresholdDeg);

  return sections.flatMap((section, index) =>
    makeGussetPiecesForSection(section, index, shape.outline, effectiveParameters),
  );
}
