import { describe, expect, it } from 'vitest';
import { DEFAULT_PATTERN_PARAMETERS } from './defaults';
import { generateFacePieces } from './generateFaces';
import { generateGussetPieces } from './generateGusset';
import { generatePattern } from './generatePattern';
import { applyApproximateSeamAllowance, boundingBox, polygonPerimeter } from './geometry';
import { createValidatedBagShape } from './shape';
import type { FaceOptions, PatternParameters, ValidatedBagShape } from './types';

const rectangleShape: ValidatedBagShape = {
  outline: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 80 },
    { x: 0, y: 80 },
  ],
  closed: true,
  unit: 'mm',
};

const asymmetricShape: ValidatedBagShape = {
  outline: [
    { x: 0, y: 0 },
    { x: 80, y: 0 },
    { x: 100, y: 80 },
    { x: 0, y: 80 },
  ],
  closed: true,
  unit: 'mm',
};

const curvedTubeShape: ValidatedBagShape = {
  outline: [
    { x: 0, y: 0 },
    { x: 50, y: 3 },
    { x: 100, y: 8 },
    { x: 150, y: 14 },
    { x: 200, y: 20 },
    { x: 210, y: 100 },
    { x: 0, y: 100 },
  ],
  closed: true,
  unit: 'mm',
};

function testParameters(overrides: Partial<PatternParameters> = {}): PatternParameters {
  return {
    ...DEFAULT_PATTERN_PARAMETERS,
    seamAllowanceMm: 0,
    faceA: { zipperCount: 0, zippers: [] },
    faceB: { zipperCount: 0, zippers: [] },
    gusset: { splitMode: 'single-piece', angleBreakThresholdDeg: 25 },
    ...overrides,
  };
}

function faceWithZips(...distances: number[]): FaceOptions {
  return {
    zipperCount: distances.length as 0 | 1 | 2,
    zippers: distances.map((distance, index) => ({
      id: `zip-${index + 1}`,
      distanceFromTopTubeMm: distance,
    })),
  };
}

function faceWithSecondZipBottomClearance(
  firstZipDistanceFromTopMm: number,
  secondZipClearanceFromBottomMm: number,
): FaceOptions {
  return {
    zipperCount: 2,
    zippers: [
      {
        id: 'zip-1',
        distanceFromTopTubeMm: firstZipDistanceFromTopMm,
      },
      {
        id: 'zip-2',
        distanceFromTopTubeMm: 0,
        clearanceFromBottomTubeMm: secondZipClearanceFromBottomMm,
      },
    ],
  };
}

describe('pattern shape validation', () => {
  it('rejects an open outline', () => {
    expect(() =>
      createValidatedBagShape(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        false,
        1,
      ),
    ).toThrow(/open outline/i);
  });

  it('rejects a closed outline with fewer than three points', () => {
    expect(() =>
      createValidatedBagShape(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        true,
        1,
      ),
    ).toThrow(/at least three/i);
  });

  it('converts source units to millimeters', () => {
    const shape = createValidatedBagShape(
      [
        { x: 1, y: 2 },
        { x: 3, y: 2 },
        { x: 3, y: 4 },
      ],
      true,
      2.5,
    );

    expect(shape.outline).toEqual([
      { x: 2.5, y: 5 },
      { x: 7.5, y: 5 },
      { x: 7.5, y: 10 },
    ]);
  });
});

describe('pattern geometry', () => {
  it('measures a closed polygon perimeter', () => {
    expect(polygonPerimeter(rectangleShape.outline)).toBe(360);
  });

  it('offsets a rectangle by the configured seam allowance on every side', () => {
    const path = applyApproximateSeamAllowance(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 50 },
        { x: 0, y: 50 },
      ],
      10,
    );

    const bounds = boundingBox(path);

    expect(bounds.minX).toBeCloseTo(-10);
    expect(bounds.minY).toBeCloseTo(-10);
    expect(bounds.maxX).toBeCloseTo(110);
    expect(bounds.maxY).toBeCloseTo(60);
    expect(bounds.width).toBeCloseTo(120);
    expect(bounds.height).toBeCloseTo(70);
  });
});

describe('face generation', () => {
  it('generates one face piece when there is no zip', () => {
    const pieces = generateFacePieces('A', rectangleShape, faceWithZips(), testParameters());

    expect(pieces).toHaveLength(1);
    expect(pieces[0].kind).toBe('face-panel');
    expect(pieces[0].label).toBe('Face A');
  });

  it('mirrors face A on the y axis while keeping face B as traced', () => {
    const faceA = generateFacePieces('A', asymmetricShape, faceWithZips(), testParameters())[0];
    const faceB = generateFacePieces('B', asymmetricShape, faceWithZips(), testParameters())[0];

    expect(faceA.paths[0]).toEqual([
      { x: 100, y: 0 },
      { x: 20, y: 0 },
      { x: 0, y: 80 },
      { x: 100, y: 80 },
    ]);
    expect(faceB.paths[0]).toEqual(asymmetricShape.outline);
  });

  it('generates two face pieces and two patches for one zip', () => {
    const pieces = generateFacePieces(
      'A',
      rectangleShape,
      faceWithZips(30),
      testParameters({ zipperCutoutHeightMm: 10 }),
    );

    expect(pieces.filter((piece) => piece.kind.startsWith('face-panel'))).toHaveLength(2);
    expect(pieces.filter((piece) => piece.kind === 'zip-end-patch')).toHaveLength(2);
    expect(pieces.filter((piece) => piece.kind === 'zip-cover')).toHaveLength(1);
  });

  it('generates three face pieces and four patches for two zips', () => {
    const pieces = generateFacePieces(
      'A',
      rectangleShape,
      faceWithZips(25, 55),
      testParameters({ zipperCutoutHeightMm: 10 }),
    );

    expect(pieces.filter((piece) => piece.kind.startsWith('face-panel'))).toHaveLength(3);
    expect(pieces.filter((piece) => piece.kind === 'zip-end-patch')).toHaveLength(4);
    expect(pieces.filter((piece) => piece.kind === 'zip-cover')).toHaveLength(2);
  });

  it('adds a compartment divider above the second zip', () => {
    const pieces = generateFacePieces(
      'A',
      rectangleShape,
      faceWithZips(25, 55),
      testParameters({ zipperCutoutHeightMm: 10, bagDepthMm: 45 }),
    );
    const divider = pieces.find((piece) => piece.kind === 'compartment-divider');

    expect(divider).toBeDefined();
    expect(divider!.label).toBe('Face A - cloison au-dessus zip 2');
    expect(boundingBox(divider!.referencePaths![0])).toMatchObject({ width: 100, height: 45 });
  });

  it('allows face A and face B to use different zip configurations', () => {
    const pieces = generatePattern(
      rectangleShape,
      testParameters({
        faceA: faceWithZips(30, 55),
        faceB: faceWithZips(),
        zipperCutoutHeightMm: 10,
      }),
    );

    expect(pieces.filter((piece) => piece.label.startsWith('Face A') && piece.kind.startsWith('face-panel'))).toHaveLength(3);
    expect(pieces.filter((piece) => piece.label === 'Face B')).toHaveLength(1);
  });

  it('uses zipper cutout height to separate upper and lower pieces', () => {
    const pieces = generateFacePieces(
      'A',
      rectangleShape,
      faceWithZips(30),
      testParameters({ zipperCutoutHeightMm: 12 }),
    );
    const upper = pieces.find((piece) => piece.label.includes('haut zip 1'));
    const lower = pieces.find((piece) => piece.label.includes('bas zip 1'));

    expect(upper).toBeDefined();
    expect(lower).toBeDefined();
    expect(boundingBox(upper!.paths[0]).maxY).toBe(24);
    expect(boundingBox(lower!.paths[0]).minY).toBe(36);
  });

  it('places zip 2 from the bottom clearance so the lower piece keeps the requested bladder height', () => {
    const pieces = generateFacePieces(
      'A',
      rectangleShape,
      faceWithSecondZipBottomClearance(25, 20),
      testParameters({ zipperCutoutHeightMm: 10 }),
    );
    const lower = pieces.find((piece) => piece.label.includes('bas zip 2'));

    expect(lower).toBeDefined();
    expect(boundingBox(lower!.referencePaths![0]).minY).toBe(60);
    expect(boundingBox(lower!.referencePaths![0]).height).toBe(20);
  });

  it('uses zipper patch dimensions from parameters', () => {
    const pieces = generateFacePieces(
      'A',
      rectangleShape,
      faceWithZips(30),
      testParameters({
        zipperEndPatchWidthMm: 42,
        zipperEndPatchHeightMm: 18,
      }),
    );
    const patch = pieces.find((piece) => piece.kind === 'zip-end-patch');

    expect(patch).toBeDefined();
    expect(boundingBox(patch!.paths[0])).toMatchObject({ width: 42, height: 18 });
  });

  it('generates a no-seam cover piece for each zipper', () => {
    const pieces = generateFacePieces(
      'A',
      rectangleShape,
      faceWithZips(30),
      testParameters({
        zipperCoverWidthMm: 32,
        zipperCoverLengthMm: 40,
        zipperCoverGapMm: 15,
      }),
    );
    const cover = pieces.find((piece) => piece.kind === 'zip-cover');

    expect(cover).toBeDefined();
    expect(cover!.paths[0]).toEqual(cover!.referencePaths![0]);
    expect(boundingBox(cover!.paths[0]).width).toBeGreaterThan(32);
    expect(boundingBox(cover!.paths[0]).height).toBeGreaterThan(40);
  });
});

describe('gusset generation', () => {
  it('generates one gusset with perimeter length in single-piece mode', () => {
    const pieces = generateGussetPieces(
      rectangleShape,
      { splitMode: 'single-piece', angleBreakThresholdDeg: 25 },
      testParameters({ bagDepthMm: 50 }),
    );

    expect(pieces).toHaveLength(1);
    expect(boundingBox(pieces[0].paths[0])).toMatchObject({ width: 360, height: 50 });
  });

  it('applies seam allowance to the top and bottom of long gusset strips', () => {
    const pieces = generateGussetPieces(
      rectangleShape,
      { splitMode: 'single-piece', angleBreakThresholdDeg: 25 },
      testParameters({ bagDepthMm: 50, seamAllowanceMm: 10 }),
    );

    expect(boundingBox(pieces[0].referencePaths![0])).toMatchObject({ height: 50 });
    expect(boundingBox(pieces[0].paths[0])).toMatchObject({
      minY: -10,
      maxY: 60,
      height: 70,
    });
  });

  it('generates one gusset per outline segment in per-tube mode', () => {
    const pieces = generateGussetPieces(
      rectangleShape,
      { splitMode: 'one-piece-per-tube', angleBreakThresholdDeg: 25 },
      testParameters({ bagDepthMm: 50 }),
    );

    expect(pieces).toHaveLength(4);
    expect(boundingBox(pieces[0].paths[0])).toMatchObject({ width: 100, height: 50 });
    expect(boundingBox(pieces[1].paths[0])).toMatchObject({ width: 80, height: 50 });
  });

  it('generates manual gusset sections between selected trace points', () => {
    const pieces = generateGussetPieces(
      rectangleShape,
      { splitMode: 'manual', angleBreakThresholdDeg: 25, manualBreakSegmentIndices: [0, 2] },
      testParameters({ bagDepthMm: 50 }),
    );

    expect(pieces).toHaveLength(2);
    expect(boundingBox(pieces[0].paths[0])).toMatchObject({ width: 180, height: 50 });
    expect(boundingBox(pieces[1].paths[0])).toMatchObject({ width: 180, height: 50 });
  });

  it('merges small angle changes into one gusset section for curved tubes', () => {
    const pieces = generateGussetPieces(
      curvedTubeShape,
      { splitMode: 'one-piece-per-tube', angleBreakThresholdDeg: 25 },
      testParameters({ bagDepthMm: 50 }),
    );

    expect(pieces.length).toBeLessThan(curvedTubeShape.outline.length);
    expect(pieces.some((piece) => piece.label === 'Soufflet section 1')).toBe(true);
  });

  it('splits the configured gusset segment with a cable pass overlap', () => {
    const pieces = generateGussetPieces(
      rectangleShape,
      {
        splitMode: 'one-piece-per-tube',
        angleBreakThresholdDeg: 25,
        cablePass: {
          enabled: true,
          segmentIndex: 2,
          distanceFromSegmentStartMm: 40,
          overlapMm: 10,
        },
      },
      testParameters({ bagDepthMm: 50 }),
    );
    const cablePassPieces = pieces.filter((piece) => piece.id.includes('cable-pass'));
    const cablePassLength = cablePassPieces.reduce(
      (total, piece) => total + boundingBox(piece.referencePaths![0]).width,
      0,
    );

    expect(cablePassPieces).toHaveLength(2);
    expect(cablePassLength).toBe(110);
    expect(cablePassPieces[0].annotations.some((annotation) => annotation.label?.includes('Chevauchement'))).toBe(false);
  });

  it('does not add seam allowance on cable pass bias edges', () => {
    const pieces = generateGussetPieces(
      rectangleShape,
      {
        splitMode: 'one-piece-per-tube',
        angleBreakThresholdDeg: 25,
        cablePass: {
          enabled: true,
          segmentIndex: 2,
          distanceFromSegmentStartMm: 40,
          overlapMm: 10,
        },
      },
      testParameters({ bagDepthMm: 50, seamAllowanceMm: 10 }),
    );
    const before = pieces.find((piece) => piece.id.includes('before-cable-pass'));
    const after = pieces.find((piece) => piece.id.includes('after-cable-pass'));

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(boundingBox(before!.referencePaths![0])).toMatchObject({ width: 50 });
    expect(boundingBox(before!.paths[0])).toMatchObject({ minX: -10, maxX: 50, width: 60 });
    expect(boundingBox(after!.referencePaths![0])).toMatchObject({ width: 60 });
    expect(boundingBox(after!.paths[0])).toMatchObject({ minX: 0, maxX: 70, width: 70 });
  });

  it('places the cable pass from the top of the selected segment', () => {
    const pieces = generateGussetPieces(
      rectangleShape,
      {
        splitMode: 'one-piece-per-tube',
        angleBreakThresholdDeg: 25,
        cablePass: {
          enabled: true,
          segmentIndex: 3,
          distanceFromTopMm: 20,
          overlapMm: 10,
        },
      },
      testParameters({ bagDepthMm: 50 }),
    );
    const cablePassPieces = pieces.filter((piece) => piece.id.includes('cable-pass'));

    expect(cablePassPieces).toHaveLength(2);
    expect(boundingBox(cablePassPieces[0].referencePaths![0]).width).toBe(70);
    expect(boundingBox(cablePassPieces[1].referencePaths![0]).width).toBe(20);
  });
});
