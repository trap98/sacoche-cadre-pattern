import type {
  CablePassOptions,
  GussetOptions,
  PatternAnnotation,
  PatternParameters,
  PatternPiece,
  Point,
  SegmentPointMark,
  ValidatedBagShape,
} from './types';
import { resolveCablePasses } from './defaults';
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

function pointMarkAnnotations(
  xPositions: number[],
  depth: number,
  seamAllowanceMm: number,
): PatternAnnotation[] {
  // Filled triangle pointing into the piece from each cut edge, base on the edge
  const markDepth = Math.min(5, seamAllowanceMm);
  const halfWidth = markDepth * 0.7;

  return xPositions.flatMap((x) => [
    {
      type: 'point-mark' as const,
      points: [
        { x: x - halfWidth, y: -seamAllowanceMm },
        { x: x + halfWidth, y: -seamAllowanceMm },
        { x, y: -seamAllowanceMm + markDepth },
      ],
    },
    {
      type: 'point-mark' as const,
      points: [
        { x: x - halfWidth, y: depth + seamAllowanceMm },
        { x: x + halfWidth, y: depth + seamAllowanceMm },
        { x, y: depth + seamAllowanceMm - markDepth },
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
  pointMarkXPositions: number[] = [],
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
      ...pointMarkAnnotations(pointMarkXPositions, depth, seamAllowanceMm),
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

function markPointPositionsInSection(
  points: Point[],
  section: GussetSection,
  markPoints: SegmentPointMark[],
): number[] {
  const segmentCount = points.length;

  return markPoints
    .filter(
      (mark) =>
        Number.isFinite(mark.distanceFromStartMm) &&
        Number.isInteger(mark.segmentIndex) &&
        mark.segmentIndex >= 0 &&
        mark.segmentIndex < segmentCount &&
        sectionContainsSegment(section, mark.segmentIndex, segmentCount),
    )
    .map((mark) => {
      const length = segmentLength(
        points[mark.segmentIndex],
        points[(mark.segmentIndex + 1) % segmentCount],
      );

      return (
        distanceFromSectionStartToSegment(points, section, mark.segmentIndex) +
        clamp(mark.distanceFromStartMm, 0, length)
      );
    });
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
  const segmentCount = points.length;
  const breakPositions = internalSegmentBreakPositions(points, section);
  const markPositions = markPointPositionsInSection(points, section, parameters.markPoints ?? []);
  const cuts =
    segmentCount > 0
      ? resolveCablePasses(parameters.gusset)
          .filter((cablePass) => cablePass.enabled && cablePass.overlapMm > 0)
          .map((cablePass) => ({
            ...cablePass,
            segmentIndex: Math.trunc(clamp(cablePass.segmentIndex, 0, segmentCount - 1)),
          }))
          .filter((cablePass) => sectionContainsSegment(section, cablePass.segmentIndex, segmentCount))
          .map((cablePass) => ({
            position:
              distanceFromSectionStartToSegment(points, section, cablePass.segmentIndex) +
              cablePassDistanceOnSegment(points, cablePass, cablePass.segmentIndex),
            overlapMm: cablePass.overlapMm,
          }))
          .sort((a, b) => a.position - b.position)
      : [];

  if (cuts.length === 0) {
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
        markPositions,
      ),
    ];
  }

  const pieces: PatternPiece[] = [];

  for (let pieceIndex = 0; pieceIndex <= cuts.length; pieceIndex += 1) {
    const start = pieceIndex === 0 ? 0 : cuts[pieceIndex - 1].position;
    const end =
      pieceIndex === cuts.length
        ? section.length
        : cuts[pieceIndex].position + cuts[pieceIndex].overlapMm;

    if (end - start <= 0.001) {
      continue;
    }

    const idSuffix =
      cuts.length === 1
        ? pieceIndex === 0
          ? 'before-cable-pass'
          : 'after-cable-pass'
        : `cable-pass-part-${pieceIndex + 1}`;
    const labelSuffix =
      cuts.length === 1
        ? pieceIndex === 0
          ? 'avant passe cable'
          : 'après passe cable'
        : `partie ${pieceIndex + 1}`;
    const seamlessEdges: SeamlessEdge[] = [
      ...(pieceIndex > 0 ? (['left'] as const) : []),
      ...(pieceIndex < cuts.length ? (['right'] as const) : []),
    ];

    pieces.push(
      makeGussetPiece(
        `${baseId}-${idSuffix}`,
        `${baseLabel} - ${labelSuffix}`,
        end - start,
        parameters.bagDepthMm,
        parameters.seamAllowanceMm,
        [],
        seamlessEdges,
        breakPositions.filter((x) => x > start && x < end).map((x) => x - start),
        markPositions.filter((x) => x >= start && x <= end).map((x) => x - start),
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

export function gussetPieceBoundaryVertexIndices(
  shape: ValidatedBagShape,
  gusset: GussetOptions,
): number[] {
  if (gusset.splitMode === 'single-piece') {
    return [];
  }

  if (gusset.splitMode === 'one-piece-per-tube') {
    return Array.from({ length: shape.outline.length }, (_, i) => i);
  }

  const sections =
    gusset.splitMode === 'manual'
      ? gussetSectionsByManualBreaks(shape.outline, gusset.manualBreakSegmentIndices)
      : gussetSectionsByAngle(shape.outline, gusset.angleBreakThresholdDeg);

  return sections.map((s) => s.startSegmentIndex);
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
