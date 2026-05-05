import type { FaceOptions, PatternParameters, PatternPiece, Point, ValidatedBagShape } from './types';
import {
  applyApproximateSeamAllowance,
  boundingBox,
  clipPolygonToHorizontalRange,
  mirrorPathOnYAxis,
  normalizePath,
  rectangle,
} from './geometry';

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

function makeLabelAnnotation(label: string, path: Point[]) {
  const bounds = boundingBox(path);

  return {
    type: 'label' as const,
    label,
    points: [{ x: bounds.minX + bounds.width / 2, y: bounds.minY - 8 }],
  };
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
  const pieces: PatternPiece[] = [];

  sections.forEach((section) => {
    const clipped = clipPolygonToHorizontalRange(outline, section.minY, section.maxY);

    if (clipped.length < 3) {
      return;
    }

    const path = applyApproximateSeamAllowance(clipped, parameters.seamAllowanceMm);

    pieces.push({
      id: section.id,
      label: section.label,
      kind: section.kind,
      paths: [path],
      referencePaths: [clipped],
      annotations: [makeLabelAnnotation(section.label, path)],
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
        annotations: [makeLabelAnnotation(label, path)],
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
      annotations: [makeLabelAnnotation(coverLabel, coverPath)],
    });
  });

  return pieces;
}
