import type { GussetOptions, PatternParameters, PatternPiece, Point, ValidatedBagShape } from './types';
import { applyApproximateSeamAllowance, boundingBox, polygonPerimeter, rectangle, segmentLength } from './geometry';

type GussetSection = {
  startSegmentIndex: number;
  segmentCount: number;
  length: number;
};

function makeGussetPiece(id: string, label: string, length: number, depth: number, seamAllowanceMm: number): PatternPiece {
  const referencePath = rectangle(length, depth);
  const path = applyApproximateSeamAllowance(referencePath, seamAllowanceMm);
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
        points: [{ x: bounds.minX + bounds.width / 2, y: bounds.minY - 8 }],
      },
      {
        type: 'fold-line',
        label: 'Milieu soufflet',
        points: [
          { x: 0, y: depth / 2 },
          { x: length, y: depth / 2 },
        ],
      },
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
  if (gusset.splitMode === 'single-piece') {
    return [
      makeGussetPiece(
        'gusset-single-piece',
        'Soufflet une pièce',
        polygonPerimeter(shape.outline),
        parameters.bagDepthMm,
        parameters.seamAllowanceMm,
      ),
    ];
  }

  const sections =
    gusset.splitMode === 'manual'
      ? gussetSectionsByManualBreaks(shape.outline, gusset.manualBreakSegmentIndices)
      : gussetSectionsByAngle(shape.outline, gusset.angleBreakThresholdDeg);

  return sections.map((section, index) => {
    return makeGussetPiece(
      `gusset-${index + 1}`,
      section.segmentCount === 1
        ? `Soufflet ${segmentLabel(section.startSegmentIndex)}`
        : `Soufflet section ${index + 1}`,
      section.length,
      parameters.bagDepthMm,
      parameters.seamAllowanceMm,
    );
  });
}
