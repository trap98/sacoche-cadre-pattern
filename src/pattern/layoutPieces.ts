import { boundingBox, translatePath } from './geometry';
import type { PatternAnnotation, PatternPiece, Point } from './types';

export type LaidOutPatternPiece = PatternPiece & {
  layout: Point;
  bounds: {
    width: number;
    height: number;
  };
};

export type PatternLayout = {
  pieces: LaidOutPatternPiece[];
  viewBox: string;
  width: number;
  height: number;
};

function allPiecePoints(piece: PatternPiece): Point[] {
  return [
    ...piece.paths.flat(),
    ...piece.annotations.flatMap((annotation) => annotation.points),
  ];
}

function translateAnnotation(annotation: PatternAnnotation, dx: number, dy: number): PatternAnnotation {
  return {
    ...annotation,
    points: translatePath(annotation.points, dx, dy),
  };
}

export function layoutPieces(
  pieces: PatternPiece[],
  options: { maxRowWidth?: number; gap?: number; padding?: number } = {},
): PatternLayout {
  const maxRowWidth = options.maxRowWidth ?? 1200;
  const gap = options.gap ?? 24;
  const padding = options.padding ?? 20;
  let cursorX = padding;
  let cursorY = padding;
  let rowHeight = 0;
  let usedWidth = padding;

  const laidOut = pieces.map((piece) => {
    const points = allPiecePoints(piece);
    const bounds = boundingBox(points);
    const width = Math.max(bounds.width, 1);
    const height = Math.max(bounds.height, 1);

    if (cursorX > padding && cursorX + width > maxRowWidth) {
      cursorX = padding;
      cursorY += rowHeight + gap;
      rowHeight = 0;
    }

    const dx = cursorX - bounds.minX;
    const dy = cursorY - bounds.minY;
    const layout = { x: cursorX, y: cursorY };
    const translatedPiece: LaidOutPatternPiece = {
      ...piece,
      layout,
      bounds: { width, height },
      paths: piece.paths.map((path) => translatePath(path, dx, dy)),
      referencePaths: piece.referencePaths?.map((path) => translatePath(path, dx, dy)),
      annotations: piece.annotations.map((annotation) => translateAnnotation(annotation, dx, dy)),
    };

    cursorX += width + gap;
    rowHeight = Math.max(rowHeight, height);
    usedWidth = Math.max(usedWidth, cursorX);

    return translatedPiece;
  });

  const totalHeight = Math.max(padding * 2, cursorY + rowHeight + padding);
  const totalWidth = Math.max(padding * 2, usedWidth + padding - gap);
  const width = Math.ceil(totalWidth);
  const height = Math.ceil(totalHeight);

  return {
    pieces: laidOut,
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
  };
}
