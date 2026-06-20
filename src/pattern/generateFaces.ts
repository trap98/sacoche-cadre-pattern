import type { FaceOptions, PatternAnnotation, PatternParameters, PatternPiece, Point, ValidatedBagShape } from './types';
import {
  applyApproximateSeamAllowance,
  boundingBox,
  clipPolygonToHorizontalRange,
  horizontalLineIntersections,
  mirrorPathOnYAxis,
  normalizePath,
  rectangle,
} from './geometry';
import { gussetPieceBoundaryVertexIndices } from './generateGusset';

type FaceName = 'A' | 'B';

type FaceSection = {
  id: string;
  label: string;
  minY: number;
  maxY: number;
  kind: PatternPiece['kind'];
};

type ActiveZipper = {
  id: string;
  distanceFromTopTubeMm: number;
};

const CUT_EDGE_EPSILON = 0.001;

function resolveZipperDistanceFromTop(
  zipper: FaceOptions['zippers'][number],
  index: number,
  bounds: ReturnType<typeof boundingBox>,
  halfCutout: number,
): number {
  const clearanceFromBottom = zipper.clearanceFromBottomTubeMm;

  if (index === 1 && clearanceFromBottom !== undefined && Number.isFinite(clearanceFromBottom)) {
    return bounds.height - clearanceFromBottom - halfCutout;
  }

  return zipper.distanceFromTopTubeMm;
}

function activeZippers(face: FaceOptions, outline: Point[], parameters: PatternParameters): ActiveZipper[] {
  const bounds = boundingBox(outline);
  const halfCutout = parameters.zipperCutoutHeightMm / 2;

  return face.zippers
    .slice(0, face.zipperCount)
    .map((zipper, index) => ({
      id: zipper.id,
      distanceFromTopTubeMm: resolveZipperDistanceFromTop(zipper, index, bounds, halfCutout),
    }))
    .filter((zipper) => Number.isFinite(zipper.distanceFromTopTubeMm))
    .sort((a, b) => a.distanceFromTopTubeMm - b.distanceFromTopTubeMm);
}

function faceSectionLabels(faceName: FaceName, count: number): string[] {
  if (count === 1) {
    return [`Face ${faceName} - haut zip 1`, `Face ${faceName} - bas zip 1`];
  }

  if (count === 2) {
    return [`Face ${faceName} - haut zip 1`, `Face ${faceName} - entre zips`, `Face ${faceName} - bas zip 2`];
  }

  return [`Face ${faceName}`];
}

function buildFaceSections(
  faceName: FaceName,
  outline: Point[],
  face: FaceOptions,
  parameters: PatternParameters,
): FaceSection[] {
  const bounds = boundingBox(outline);
  const zippers = activeZippers(face, outline, parameters);
  const labels = faceSectionLabels(faceName, zippers.length);

  if (zippers.length === 0) {
    return [
      {
        id: `face-${faceName.toLowerCase()}`,
        label: labels[0],
        minY: bounds.minY,
        maxY: bounds.maxY,
        kind: 'face-panel',
      },
    ];
  }

  const halfCutout = parameters.zipperCutoutHeightMm / 2;
  const sections: FaceSection[] = [];

  zippers.forEach((zipper, index) => {
    const zipY = bounds.minY + zipper.distanceFromTopTubeMm;
    const cutTop = zipY - halfCutout;
    const cutBottom = zipY + halfCutout;

    if (index === 0) {
      sections.push({
        id: `face-${faceName.toLowerCase()}-section-1`,
        label: labels[0],
        minY: bounds.minY,
        maxY: cutTop,
        kind: 'face-panel-upper',
      });
      return;
    }

    const previousZipY = bounds.minY + zippers[index - 1].distanceFromTopTubeMm;
    sections.push({
      id: `face-${faceName.toLowerCase()}-section-${index + 1}`,
      label: labels[index],
      minY: previousZipY + halfCutout,
      maxY: cutTop,
      kind: 'face-panel',
    });
  });

  const lastZipY = bounds.minY + zippers[zippers.length - 1].distanceFromTopTubeMm;
  sections.push({
    id: `face-${faceName.toLowerCase()}-section-${zippers.length + 1}`,
    label: labels[labels.length - 1],
    minY: lastZipY + halfCutout,
    maxY: bounds.maxY,
    kind: 'face-panel-lower',
  });

  return sections;
}

function applyFaceSectionSeamAllowance(
  clipped: Point[],
  section: FaceSection,
  outlineSeamPath: Point[],
  outlineBounds: ReturnType<typeof boundingBox>,
  seamAllowanceMm: number,
): Point[] {
  if (seamAllowanceMm <= 0) {
    return clipped.map((point) => ({ ...point }));
  }

  const hasInternalTopCut = section.minY > outlineBounds.minY + CUT_EDGE_EPSILON;
  const hasInternalBottomCut = section.maxY < outlineBounds.maxY - CUT_EDGE_EPSILON;
  const seamBounds = boundingBox(outlineSeamPath);
  const minY = hasInternalTopCut ? section.minY - seamAllowanceMm : seamBounds.minY;
  const maxY = hasInternalBottomCut ? section.maxY + seamAllowanceMm : seamBounds.maxY;
  const path = clipPolygonToHorizontalRange(outlineSeamPath, minY, maxY);

  return path.length >= 3 ? path : clipped.map((point) => ({ ...point }));
}

function faceSegmentMarkAnnotations(
  clipped: Point[],
  path: Point[],
  outline: Point[],
  outlineSeamPath: Point[],
  splitVertexIndices: Set<number>,
  tickLength: number,
): PatternAnnotation[] {
  const epsilon = 0.01;
  const annotations: PatternAnnotation[] = [];

  clipped.forEach((refPoint, index) => {
    const originalIndex = outline.findIndex(
      (v) => Math.abs(v.x - refPoint.x) < epsilon && Math.abs(v.y - refPoint.y) < epsilon,
    );

    if (originalIndex < 0) return;

    const cutPoint = outlineSeamPath[originalIndex] ?? path[index];
    const dx = refPoint.x - cutPoint.x;
    const dy = refPoint.y - cutPoint.y;
    const dist = Math.hypot(dx, dy);

    if (dist < epsilon) return;

    const type = splitVertexIndices.has(originalIndex) ? ('split-mark' as const) : ('segment-mark' as const);

    annotations.push({
      type,
      points: [
        cutPoint,
        { x: cutPoint.x + (dx / dist) * tickLength, y: cutPoint.y + (dy / dist) * tickLength },
      ],
    });
  });

  return annotations;
}

function cablePassMarkAnnotation(
  clipped: Point[],
  outline: Point[],
  cablePass: { enabled: boolean; segmentIndex: number; distanceFromTopMm?: number; distanceFromSegmentStartMm?: number; overlapMm: number },
  sectionMinY: number,
  sectionMaxY: number,
  seamAllowanceMm: number,
  tickLength: number,
): PatternAnnotation | null {
  if (!cablePass.enabled || cablePass.overlapMm <= 0 || outline.length === 0) return null;

  const n = outline.length;
  const segIndex = Math.min(Math.max(Math.trunc(cablePass.segmentIndex), 0), n - 1);
  const segStart = outline[segIndex];
  const segEnd = outline[(segIndex + 1) % n];
  const edgeDx = segEnd.x - segStart.x;
  const edgeDy = segEnd.y - segStart.y;
  const segLen = Math.hypot(edgeDx, edgeDy);

  if (segLen < 0.001) return null;

  let distFromStart: number;

  if (cablePass.distanceFromTopMm !== undefined && Number.isFinite(cablePass.distanceFromTopMm)) {
    const segStartIsTop = segStart.y <= segEnd.y;
    const d = Math.min(Math.max(cablePass.distanceFromTopMm, 0), segLen);
    distFromStart = segStartIsTop ? d : segLen - d;
  } else {
    distFromStart = Math.min(Math.max(cablePass.distanceFromSegmentStartMm ?? segLen / 2, 0), segLen);
  }

  const t = distFromStart / segLen;
  const refPoint: Point = {
    x: segStart.x + t * (segEnd.x - segStart.x),
    y: segStart.y + t * (segEnd.y - segStart.y),
  };

  const epsilon = 0.1;

  if (refPoint.y < sectionMinY - epsilon || refPoint.y > sectionMaxY + epsilon) return null;

  // Outward normal: perpendicular to edge, pointing away from the polygon centroid
  const cx = clipped.reduce((s, p) => s + p.x, 0) / clipped.length;
  const cy = clipped.reduce((s, p) => s + p.y, 0) / clipped.length;
  const n1x = edgeDy / segLen;
  const n1y = -edgeDx / segLen;
  const toCentroidDot = n1x * (cx - refPoint.x) + n1y * (cy - refPoint.y);
  const outX = toCentroidDot > 0 ? -n1x : n1x;
  const outY = toCentroidDot > 0 ? -n1y : n1y;

  return {
    type: 'split-mark',
    points: [
      { x: refPoint.x + outX * seamAllowanceMm, y: refPoint.y + outY * seamAllowanceMm },
      { x: refPoint.x + outX * (seamAllowanceMm - tickLength), y: refPoint.y + outY * (seamAllowanceMm - tickLength) },
    ],
  };
}

function makeLabelAnnotation(label: string, path: Point[], seamAllowanceMm: number) {
  const bounds = boundingBox(path);

  return {
    type: 'label' as const,
    label,
    fontSizeMm: seamAllowanceMm * 0.5,
    points: [{ x: bounds.minX + bounds.width / 2, y: bounds.minY + seamAllowanceMm / 2 }],
  };
}

function widestHorizontalSpanLength(outline: Point[], y: number): number | null {
  const intersections = horizontalLineIntersections(outline, y);

  if (intersections.length < 2) {
    return null;
  }

  let widest = intersections[1] - intersections[0];

  for (let index = 2; index < intersections.length; index += 2) {
    const next = intersections[index + 1];

    if (next === undefined) {
      break;
    }

    widest = Math.max(widest, next - intersections[index]);
  }

  return widest;
}

function rotatePoint(point: Point, origin: Point, angleRadians: number): Point {
  const cos = Math.cos(angleRadians);
  const sin = Math.sin(angleRadians);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;

  return {
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  };
}

function circleCenterFromThreePoints(a: Point, b: Point, c: Point): Point | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));

  if (Math.abs(d) < 0.000001) {
    return null;
  }

  const aLength = a.x * a.x + a.y * a.y;
  const bLength = b.x * b.x + b.y * b.y;
  const cLength = c.x * c.x + c.y * c.y;

  return {
    x: (aLength * (b.y - c.y) + bLength * (c.y - a.y) + cLength * (a.y - b.y)) / d,
    y: (aLength * (c.x - b.x) + bLength * (a.x - c.x) + cLength * (b.x - a.x)) / d,
  };
}

function normalizeAngle(angle: number): number {
  const fullTurn = Math.PI * 2;
  return ((angle % fullTurn) + fullTurn) % fullTurn;
}

function unwrapAngles(angles: number[], direction: 'clockwise' | 'counter-clockwise'): number[] {
  return angles.reduce<number[]>((unwrapped, angle) => {
    if (unwrapped.length === 0) {
      return [angle];
    }

    let next = angle;
    const previous = unwrapped[unwrapped.length - 1];
    const fullTurn = Math.PI * 2;

    if (direction === 'counter-clockwise') {
      while (next < previous) {
        next += fullTurn;
      }
    } else {
      while (next > previous) {
        next -= fullTurn;
      }
    }

    return [...unwrapped, next];
  }, []);
}

function arcThroughOrderedPoints(points: Point[], samples = 28): Point[] {
  const center = circleCenterFromThreePoints(points[0], points[1], points[points.length - 1]);

  if (!center) {
    return points.map((point) => ({ ...point }));
  }

  const radius = Math.hypot(points[0].x - center.x, points[0].y - center.y);
  const angles = points.map((point) => normalizeAngle(Math.atan2(point.y - center.y, point.x - center.x)));
  const clockwise = unwrapAngles(angles, 'clockwise');
  const counterClockwise = unwrapAngles(angles, 'counter-clockwise');
  const clockwiseSpan = Math.abs(clockwise[clockwise.length - 1] - clockwise[0]);
  const counterClockwiseSpan = Math.abs(counterClockwise[counterClockwise.length - 1] - counterClockwise[0]);
  const selected = clockwiseSpan <= counterClockwiseSpan ? clockwise : counterClockwise;
  const startAngle = selected[0];
  const endAngle = selected[selected.length - 1];

  return Array.from({ length: samples + 1 }, (_, index) => {
    const t = index / samples;
    const angle = startAngle + (endAngle - startAngle) * t;

    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    };
  });
}

function generateZipperCoverPath(widthMm: number, lengthMm: number, gapMm: number): Point[] {
  const halfWidth = widthMm / 2;
  const halfGap = gapMm / 2;
  const openAngle = Math.asin(Math.min(0.95, halfGap / Math.max(lengthMm, 1)));

  const leftOuterTop = { x: -halfWidth, y: 0 };
  const rightOuterTop = { x: halfWidth, y: 0 };
  const leftInnerTop = rotatePoint({ x: 0, y: 0 }, leftOuterTop, openAngle);
  const rightInnerTop = rotatePoint({ x: 0, y: 0 }, rightOuterTop, -openAngle);
  const leftOuterBottom = rotatePoint({ x: -halfWidth, y: lengthMm }, leftOuterTop, openAngle);
  const leftInnerBottom = rotatePoint({ x: 0, y: lengthMm }, leftOuterTop, openAngle);
  const rightOuterBottom = rotatePoint({ x: halfWidth, y: lengthMm }, rightOuterTop, -openAngle);
  const rightInnerBottom = rotatePoint({ x: 0, y: lengthMm }, rightOuterTop, -openAngle);
  const topPath = [leftOuterTop, leftInnerTop, rightInnerTop, rightOuterTop];
  const bottomArc = arcThroughOrderedPoints(
    [rightOuterBottom, rightInnerBottom, leftInnerBottom, leftOuterBottom],
    28,
  );
  const path = [
    leftOuterBottom,
    ...topPath,
    rightOuterBottom,
    ...bottomArc.slice(1),
  ];
  const bounds = boundingBox(path);

  return path.map((point) => ({
    x: point.x - bounds.minX,
    y: point.y - bounds.minY,
  }));
}

export function generateFacePieces(
  faceName: FaceName,
  shape: ValidatedBagShape,
  face: FaceOptions,
  parameters: PatternParameters,
): PatternPiece[] {
  const outline = faceName === 'A' ? mirrorPathOnYAxis(normalizePath(shape.outline)) : normalizePath(shape.outline);
  const sections = buildFaceSections(faceName, outline, face, parameters);
  const outlineBounds = boundingBox(outline);
  const outlineSeamPath = applyApproximateSeamAllowance(outline, parameters.seamAllowanceMm);
  const splitVertexIndices = new Set(gussetPieceBoundaryVertexIndices(shape, parameters.gusset));
  const pieces: PatternPiece[] = [];

  sections.forEach((section) => {
    const clipped = clipPolygonToHorizontalRange(outline, section.minY, section.maxY);

    if (clipped.length < 3) {
      return;
    }

    const path = applyFaceSectionSeamAllowance(
      clipped,
      section,
      outlineSeamPath,
      outlineBounds,
      parameters.seamAllowanceMm,
    );
    const tickLength = Math.min(5, parameters.seamAllowanceMm);
    const segmentMarks = faceSegmentMarkAnnotations(clipped, path, outline, outlineSeamPath, splitVertexIndices, tickLength);
    const cablePass = parameters.gusset.cablePass;
    const cablePassMark = cablePass
      ? cablePassMarkAnnotation(clipped, outline, cablePass, section.minY, section.maxY, parameters.seamAllowanceMm, tickLength)
      : null;

    pieces.push({
      id: section.id,
      label: section.label,
      kind: section.kind,
      paths: [path],
      referencePaths: [clipped],
      annotations: [
        makeLabelAnnotation(section.label, path, parameters.seamAllowanceMm),
        ...segmentMarks,
        ...(cablePassMark ? [cablePassMark] : []),
      ],
    });
  });

  activeZippers(face, outline, parameters).forEach((zipper, index) => {
    const zipNumber = index + 1;
    ['gauche', 'droite'].forEach((side) => {
      const label = `Face ${faceName} - patch zip ${zipNumber} ${side}`;
      const path = rectangle(
        parameters.zipperEndPatchWidthMm,
        parameters.zipperEndPatchHeightMm,
      );

      pieces.push({
        id: `face-${faceName.toLowerCase()}-zip-${zipNumber}-patch-${side}`,
        label,
        kind: 'zip-end-patch',
        paths: [path],
        referencePaths: [path],
        annotations: [],
      });
    });

    const coverLabel = `Face ${faceName} - cover zip ${zipNumber}`;
    const coverPath = generateZipperCoverPath(
      parameters.zipperCoverWidthMm,
      parameters.zipperCoverLengthMm,
      parameters.zipperCoverGapMm,
    );

    pieces.push({
      id: `face-${faceName.toLowerCase()}-zip-${zipNumber}-cover`,
      label: coverLabel,
      kind: 'zip-cover',
      paths: [coverPath],
      referencePaths: [coverPath],
      annotations: [],
    });
  });

  const zippers = activeZippers(face, outline, parameters);

  if (zippers.length >= 2) {
    const secondZipY = boundingBox(outline).minY + zippers[1].distanceFromTopTubeMm;
    const dividerLength = widestHorizontalSpanLength(
      outline,
      secondZipY - parameters.zipperCutoutHeightMm / 2,
    );

    if (dividerLength !== null && dividerLength > 0) {
      const label = `Face ${faceName} - cloison au-dessus zip 2`;
      const referencePath = rectangle(dividerLength, parameters.bagDepthMm);
      const path = applyApproximateSeamAllowance(referencePath, parameters.seamAllowanceMm);

      pieces.push({
        id: `face-${faceName.toLowerCase()}-zip-2-compartment-divider`,
        label,
        kind: 'compartment-divider',
        paths: [path],
        referencePaths: [referencePath],
        annotations: [
          makeLabelAnnotation(label, path, parameters.seamAllowanceMm),
          {
            type: 'fold-line',
            label: 'Milieu cloison',
            points: [
              { x: 0, y: parameters.bagDepthMm / 2 },
              { x: dividerLength, y: parameters.bagDepthMm / 2 },
            ],
          },
        ],
      });
    }
  }

  return pieces;
}
