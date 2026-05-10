import { ArrowLeft, CircleHelp, Download, Image, Move, RotateCcw, Scissors, Settings2, ZoomIn } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, PointerEvent } from 'react';
import { DEFAULT_CABLE_PASS_DISTANCE_FROM_TOP_MM } from './defaults';
import { generatePattern } from './generatePattern';
import { boundingBox, segmentLength } from './geometry';
import { layoutPieces } from './layoutPieces';
import { ensureZipperCount, updateNumber, zipperBottomClearanceValue } from './zipperOptions';
import type { FaceOptions, PatternAnnotation, PatternParameters, Point, ValidatedBagShape } from './types';
import { downloadSvgSnapshotAsPng } from '../App';

type PatternWorkspaceProps = {
  shape: ValidatedBagShape;
  parameters: PatternParameters;
  onParametersChange: (parameters: PatternParameters) => void;
  onBackToTrace: () => void;
  backButtonLabel?: string;
  canvasSvgSnapshot?: string;
};

type PatternViewTransform = {
  offsetX: number;
  offsetY: number;
  scale: number;
};

type PanInteraction = {
  pointerId: number;
  startPoint: Point;
  startView: PatternViewTransform;
};

const INITIAL_PATTERN_VIEW: PatternViewTransform = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
};

const MIN_PATTERN_ZOOM = 0.25;
const MAX_PATTERN_ZOOM = 8;

function pathPoints(points: Point[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(' ');
}

function pathPointsForExport(points: Point[]): string {
  return points.map((point) => `${toExportUnit(point.x)},${toExportUnit(point.y)}`).join(' ');
}

const SVG_PX_PER_MM = 96 / 25.4;

function toExportUnit(mm: number): number {
  return Math.round(mm * SVG_PX_PER_MM * 1000) / 1000;
}

function clampPatternZoom(scale: number): number {
  return Math.min(MAX_PATTERN_ZOOM, Math.max(MIN_PATTERN_ZOOM, scale));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function annotationClass(annotation: PatternAnnotation): string {
  return `pattern-annotation ${annotation.type}`;
}

function pieceFaceClass(pieceId: string): string {
  if (pieceId.startsWith('face-a')) {
    return 'face-a';
  }

  if (pieceId.startsWith('face-b')) {
    return 'face-b';
  }

  return '';
}

function pieceFill(kind: string, pieceId: string): string {
  if (kind === 'compartment-divider') {
    return '#eaf1f5';
  }

  if (pieceId.startsWith('face-a')) {
    return kind === 'zip-end-patch' || kind === 'zip-cover' ? '#e7f0fb' : '#eaf4ff';
  }

  if (pieceId.startsWith('face-b')) {
    return kind === 'zip-end-patch' || kind === 'zip-cover' ? '#eaf6ed' : '#edf8f0';
  }

  if (kind === 'gusset') {
    return '#f7efe5';
  }

  if (kind === 'zip-end-patch') {
    return '#eef1fa';
  }

  if (kind === 'zip-cover') {
    return '#f3eefb';
  }

  return '#edf7f4';
}

function pieceStroke(kind: string, pieceId: string): string {
  if (kind === 'compartment-divider') {
    return '#406879';
  }

  if (pieceId.startsWith('face-a')) {
    return '#2563a8';
  }

  if (pieceId.startsWith('face-b')) {
    return '#26734d';
  }

  if (kind === 'gusset') {
    return '#9a5d1f';
  }

  if (kind === 'zip-end-patch') {
    return '#4c5c9d';
  }

  if (kind === 'zip-cover') {
    return '#6f4ca6';
  }

  return '#1f6f5b';
}

function FieldLabel({ children, help }: { children: string; help: string }) {
  return (
    <span className="field-label">
      {children}
      <span className="info-icon" title={help} aria-label={help} tabIndex={0}>
        <CircleHelp size={14} />
      </span>
    </span>
  );
}


function buildExportSvg(
  layout: ReturnType<typeof layoutPieces>,
  includeReferencePaths: boolean,
): string {
  const exportWidth = toExportUnit(layout.width);
  const exportHeight = toExportUnit(layout.height);
  const content = layout.pieces
    .map((piece) => {
      const paths = piece.paths
        .map(
          (path) =>
            `<polygon points="${pathPointsForExport(path)}" fill="${pieceFill(
              piece.kind,
              piece.id,
            )}" stroke="${pieceStroke(
              piece.kind,
              piece.id,
            )}" stroke-width="${toExportUnit(0.35)}" />`,
        )
        .join('');
      const referencePaths =
        includeReferencePaths && piece.referencePaths
          ? piece.referencePaths
              .map(
                (path) =>
                  `<polygon points="${pathPointsForExport(
                    path,
                  )}" fill="none" stroke="#d8762a" stroke-width="${toExportUnit(
                    0.3,
                  )}" stroke-dasharray="${toExportUnit(1.6)} ${toExportUnit(1.3)}" />`,
              )
              .join('')
          : '';
      const annotations = piece.annotations
        .map((annotation) => {
          if (annotation.type === 'label') {
            const point = annotation.points[0];

            return `<text x="${toExportUnit(point.x)}" y="${toExportUnit(
              point.y,
            )}" fill="#20242b" font-family="Arial, sans-serif" font-size="${toExportUnit(
              annotation.fontSizeMm ?? 3.5,
            )}" font-weight="700" text-anchor="middle" dominant-baseline="middle">${escapeXml(
              annotation.label ?? '',
            )}</text>`;
          }

          if (annotation.type === 'segment-mark') {
            return `<polyline points="${pathPointsForExport(
              annotation.points,
            )}" fill="none" stroke="#9a5d1f" stroke-width="${toExportUnit(0.3)}" />`;
          }

          return `<polyline points="${pathPointsForExport(
            annotation.points,
          )}" fill="none" stroke="#4b535f" stroke-width="${toExportUnit(
            0.3,
          )}" stroke-dasharray="${toExportUnit(2)} ${toExportUnit(1.4)}" />`;
        })
        .join('');

      return `<g id="${escapeXml(piece.id)}">${paths}${referencePaths}${annotations}</g>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}mm" height="${layout.height}mm" viewBox="0 0 ${exportWidth} ${exportHeight}">
  <rect width="${exportWidth}" height="${exportHeight}" fill="#ffffff" />
  ${content}
</svg>
`;
}

function downloadTextFile(filename: string, text: string, mimeType: string) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function PatternWorkspace({
  shape,
  parameters,
  onParametersChange,
  onBackToTrace,
  backButtonLabel = 'Retour au tracé',
  canvasSvgSnapshot,
}: PatternWorkspaceProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const panInteractionRef = useRef<PanInteraction | null>(null);
  const [showReferencePaths, setShowReferencePaths] = useState(false);
  const [patternView, setPatternView] = useState(INITIAL_PATTERN_VIEW);
  const [isPanning, setIsPanning] = useState(false);
  const shapeBounds = useMemo(() => boundingBox(shape.outline), [shape.outline]);
  const pieces = useMemo(() => generatePattern(shape, parameters), [shape, parameters]);
  const layout = useMemo(() => layoutPieces(pieces), [pieces]);
  const cablePassSegmentIndex = parameters.gusset.cablePass?.segmentIndex ?? 2;
  const cablePassSegmentLengthMm = useMemo(() => {
    if (
      shape.outline.length < 2 ||
      cablePassSegmentIndex < 0 ||
      cablePassSegmentIndex >= shape.outline.length
    ) {
      return 0;
    }

    return segmentLength(
      shape.outline[cablePassSegmentIndex],
      shape.outline[(cablePassSegmentIndex + 1) % shape.outline.length],
    );
  }, [cablePassSegmentIndex, shape.outline]);

  const clientToPatternPoint = useCallback((event: { clientX: number; clientY: number }): Point => {
    const rect = svgRef.current?.getBoundingClientRect();

    if (!rect) {
      return { x: 0, y: 0 };
    }

    const scale = Math.min(rect.width / layout.width, rect.height / layout.height);
    const renderedWidth = layout.width * scale;
    const renderedHeight = layout.height * scale;
    const paddingX = (rect.width - renderedWidth) / 2;
    const paddingY = (rect.height - renderedHeight) / 2;

    return {
      x: (event.clientX - rect.left - paddingX) / scale,
      y: (event.clientY - rect.top - paddingY) / scale,
    };
  }, [layout]);

  function handlePreviewPointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();

    panInteractionRef.current = {
      pointerId: event.pointerId,
      startPoint: clientToPatternPoint(event),
      startView: patternView,
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePreviewPointerMove(event: PointerEvent<SVGSVGElement>) {
    const interaction = panInteractionRef.current;

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    const point = clientToPatternPoint(event);

    setPatternView({
      ...interaction.startView,
      offsetX: interaction.startView.offsetX + point.x - interaction.startPoint.x,
      offsetY: interaction.startView.offsetY + point.y - interaction.startPoint.y,
    });
  }

  function handlePreviewPointerUp(event: PointerEvent<SVGSVGElement>) {
    const interaction = panInteractionRef.current;

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    panInteractionRef.current = null;
    setIsPanning(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    function handlePreviewWheel(event: WheelEvent) {
      event.preventDefault();
      const pointer = clientToPatternPoint(event);
      const zoomFactor = event.deltaY < 0 ? 1.12 : 0.88;
      const nextScale = clampPatternZoom(patternView.scale * zoomFactor);
      const contentPoint = {
        x: (pointer.x - patternView.offsetX) / patternView.scale,
        y: (pointer.y - patternView.offsetY) / patternView.scale,
      };
      setPatternView({
        scale: nextScale,
        offsetX: pointer.x - contentPoint.x * nextScale,
        offsetY: pointer.y - contentPoint.y * nextScale,
      });
    }

    svg.addEventListener('wheel', handlePreviewWheel, { passive: false });
    return () => svg.removeEventListener('wheel', handlePreviewWheel);
  }, [patternView, clientToPatternPoint]);

  function resetPatternView() {
    setPatternView(INITIAL_PATTERN_VIEW);
  }

  function updateParameters(patch: Partial<PatternParameters>) {
    onParametersChange({ ...parameters, ...patch });
  }

  function updateFace(faceKey: 'faceA' | 'faceB', updater: (face: FaceOptions) => FaceOptions) {
    onParametersChange({
      ...parameters,
      [faceKey]: updater(parameters[faceKey]),
    });
  }

  function updateGusset(patch: Partial<PatternParameters['gusset']>) {
    updateParameters({
      gusset: {
        ...parameters.gusset,
        ...patch,
      },
    });
  }

  function updateCablePass(patch: Partial<NonNullable<PatternParameters['gusset']['cablePass']>>) {
    const currentCablePass = parameters.gusset.cablePass ?? {
      enabled: false,
      segmentIndex: 2,
      distanceFromTopMm: DEFAULT_CABLE_PASS_DISTANCE_FROM_TOP_MM,
      overlapMm: 10,
    };

    updateGusset({
      cablePass: {
        ...currentCablePass,
        ...patch,
      },
    });
  }

  function handleFaceZipCount(faceKey: 'faceA' | 'faceB', event: ChangeEvent<HTMLSelectElement>) {
    const zipperCount = Number(event.target.value) as 0 | 1 | 2;
    updateFace(faceKey, (face) => ensureZipperCount(face, zipperCount));
  }

  function exportSvg() {
    downloadTextFile(
      'cadre-pattern.svg',
      buildExportSvg(layout, showReferencePaths),
      'image/svg+xml;charset=utf-8',
    );
  }

  function renderFaceControls(faceKey: 'faceA' | 'faceB', label: string) {
    const face = parameters[faceKey];

    return (
      <section className="tool-section">
        <div className="section-title">{label}</div>
        <label className="field">
          <FieldLabel help="Nombre de fermetures éclair sur cette face. Les hauteurs restent indépendantes entre Face A et Face B.">
            Nombre de zips
          </FieldLabel>
          <select value={face.zipperCount} onChange={(event) => handleFaceZipCount(faceKey, event)}>
            <option value={0}>0 zip</option>
            <option value={1}>1 zip</option>
            <option value={2}>2 zips</option>
          </select>
        </label>

        {face.zippers.slice(0, face.zipperCount).map((zipper, index) => {
          const usesBottomReference = index === 1;
          const inputValue = usesBottomReference
            ? zipperBottomClearanceValue(zipper, shapeBounds.height, parameters.zipperCutoutHeightMm)
            : zipper.distanceFromTopTubeMm;
          const help = usesBottomReference
            ? "Hauteur utile gardée entre le bas du tracé et le bas de la découpe du zip 2. Cette valeur réserve directement la place nécessaire à une hydration bladder."
            : "Distance verticale en millimètres entre le haut du tracé, assimilé au top tube, et l'axe de la fermeture éclair.";
          const labelText = usesBottomReference
            ? 'Hauteur utile sous zip 2'
            : `Hauteur zip ${index + 1} depuis top tube`;

          return (
            <label className="field" key={zipper.id}>
              <FieldLabel help={help}>
                {labelText}
              </FieldLabel>
              <input
                type="number"
                min="0"
                step="1"
                value={inputValue}
                onChange={(event) =>
                  updateFace(faceKey, (currentFace) => ({
                    ...currentFace,
                    zippers: currentFace.zippers.map((currentZipper, zipperIndex) =>
                      zipperIndex === index
                        ? {
                            ...currentZipper,
                            ...(usesBottomReference
                              ? { clearanceFromBottomTubeMm: updateNumber(event.target.value) }
                              : { distanceFromTopTubeMm: updateNumber(event.target.value) }),
                          }
                        : currentZipper,
                    ),
                  }))
                }
              />
            </label>
          );
        })}
      </section>
    );
  }

  function renderAnnotation(annotation: PatternAnnotation, pieceId: string, index: number) {
    if (annotation.type === 'label') {
      const point = annotation.points[0];

      return (
        <text
          className={annotationClass(annotation)}
          key={`${pieceId}-annotation-${index}`}
          x={point.x}
          y={point.y}
          fontSize={annotation.fontSizeMm}
        >
          {annotation.label}
        </text>
      );
    }

    return (
      <polyline
        className={annotationClass(annotation)}
        key={`${pieceId}-annotation-${index}`}
        points={pathPoints(annotation.points)}
        fill="none"
      />
    );
  }

  return (
    <main className="app-shell pattern-shell">
      <aside className="tool-panel" aria-label="Paramètres patronnage">
        <div className="brand-block">
          <Scissors size={22} />
          <div>
            <h1>Cadre Pattern</h1>
            <p>Patronnage paramétrique</p>
          </div>
        </div>

        <section className="tool-section">
          <div className="section-title">Trace validé</div>
          <div className="metric-row">
            <span>Points</span>
            <strong>{shape.outline.length}</strong>
          </div>
          <div className="metric-row">
            <span>Unités</span>
            <strong>mm</strong>
          </div>
          <button className="secondary-button" type="button" onClick={onBackToTrace}>
            <ArrowLeft size={17} />
            {backButtonLabel}
          </button>
          <button className="primary-button" type="button" onClick={exportSvg}>
            <Download size={17} />
            Exporter patron SVG
          </button>
          {canvasSvgSnapshot ? (
            <button
              className="secondary-button"
              type="button"
              onClick={() => downloadSvgSnapshotAsPng(canvasSvgSnapshot)}
            >
              <Image size={17} />
              Exporter vue finale PNG
            </button>
          ) : null}
          <button className="secondary-button" type="button" onClick={resetPatternView}>
            <RotateCcw size={17} />
            Reset vue
          </button>
          <div className="hint-list">
            <span>
              <ZoomIn size={15} /> Molette : zoom preview
            </span>
            <span>
              <Move size={15} /> Glisser preview : déplacer
            </span>
          </div>
        </section>

        <section className="tool-section">
          <div className="section-title">Construction</div>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={showReferencePaths}
              onChange={(event) => setShowReferencePaths(event.target.checked)}
            />
            <span>Afficher tracés sans marge</span>
          </label>
          <label className="field">
            <FieldLabel help="Marge ajoutée autour des contours extérieurs des pièces. En V1, l'offset est volontairement simple pour rester prévisible.">
              Marge couture
            </FieldLabel>
            <input
              type="number"
              min="0"
              step="1"
              value={parameters.seamAllowanceMm}
              onChange={(event) => updateParameters({ seamAllowanceMm: updateNumber(event.target.value) })}
            />
          </label>
          <label className="field">
            <FieldLabel help="Largeur du soufflet, donc profondeur finale visée pour la sacoche.">
              Profondeur sacoche
            </FieldLabel>
            <input
              type="number"
              min="1"
              step="1"
              value={parameters.bagDepthMm}
              onChange={(event) => updateParameters({ bagDepthMm: updateNumber(event.target.value) })}
            />
          </label>
          <label className="field">
            <FieldLabel help="Hauteur de matière retirée autour de la ligne de zip. La moitié est retirée sur la pièce haute, l'autre sur la pièce basse.">
              Hauteur découpe zip
            </FieldLabel>
            <input
              type="number"
              min="0"
              step="1"
              value={parameters.zipperCutoutHeightMm}
              onChange={(event) => updateParameters({ zipperCutoutHeightMm: updateNumber(event.target.value) })}
            />
          </label>
          <label className="field">
            <FieldLabel help="Largeur des petites pièces de finition placées aux extrémités de chaque fermeture éclair.">
              Largeur patch zip
            </FieldLabel>
            <input
              type="number"
              min="1"
              step="1"
              value={parameters.zipperEndPatchWidthMm}
              onChange={(event) => updateParameters({ zipperEndPatchWidthMm: updateNumber(event.target.value) })}
            />
          </label>
          <label className="field">
            <FieldLabel help="Hauteur des petites pièces de finition placées aux extrémités de chaque fermeture éclair.">
              Hauteur patch zip
            </FieldLabel>
            <input
              type="number"
              min="1"
              step="1"
              value={parameters.zipperEndPatchHeightMm}
              onChange={(event) => updateParameters({ zipperEndPatchHeightMm: updateNumber(event.target.value) })}
            />
          </label>
          <label className="field">
            <FieldLabel help="Largeur du rectangle de base utilisé pour construire le cover de zip avant ouverture.">
              Largeur cover zip
            </FieldLabel>
            <input
              type="number"
              min="1"
              step="1"
              value={parameters.zipperCoverWidthMm}
              onChange={(event) => updateParameters({ zipperCoverWidthMm: updateNumber(event.target.value) })}
            />
          </label>
          <label className="field">
            <FieldLabel help="Longueur du rectangle de base du cover, dans l'axe de la coupe centrale.">
              Longueur cover zip
            </FieldLabel>
            <input
              type="number"
              min="1"
              step="1"
              value={parameters.zipperCoverLengthMm}
              onChange={(event) => updateParameters({ zipperCoverLengthMm: updateNumber(event.target.value) })}
            />
          </label>
          <label className="field">
            <FieldLabel help="Écart créé entre les deux coins après pivot des deux demi-rectangles.">
              Écart cover zip
            </FieldLabel>
            <input
              type="number"
              min="0"
              step="1"
              value={parameters.zipperCoverGapMm}
              onChange={(event) => updateParameters({ zipperCoverGapMm: updateNumber(event.target.value) })}
            />
          </label>
        </section>

        {renderFaceControls('faceA', 'Face A')}
        {renderFaceControls('faceB', 'Face B')}

        <section className="tool-section">
          <div className="section-title">Soufflet</div>
          {(() => {
            const cablePass = parameters.gusset.cablePass ?? {
              enabled: false,
              segmentIndex: 2,
              distanceFromTopMm: DEFAULT_CABLE_PASS_DISTANCE_FROM_TOP_MM,
              overlapMm: 10,
            };
            const distanceFromTopMm =
              cablePass.distanceFromTopMm ??
              cablePass.distanceFromSegmentStartMm ??
              DEFAULT_CABLE_PASS_DISTANCE_FROM_TOP_MM;

            return (
              <>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={cablePass.enabled}
                    onChange={(event) => updateCablePass({ enabled: event.target.checked })}
                  />
                  <span>Passe cable down tube</span>
                </label>
                {cablePass.enabled ? (
                  <>
                    <label className="field">
                      <FieldLabel help="Segment du tracé qui correspond au down tube. La valeur est basée sur l'ordre des points, en commençant à 1.">
                        Segment passe cable
                      </FieldLabel>
                      <input
                        type="number"
                        min="1"
                        max={shape.outline.length}
                        step="1"
                        value={cablePass.segmentIndex + 1}
                        onChange={(event) =>
                          updateCablePass({
                            segmentIndex: Math.max(0, updateNumber(event.target.value) - 1),
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <FieldLabel help="Position de la découpe du passe-cable mesurée depuis le point le plus haut du segment down tube sélectionné.">
                        Distance depuis haut du segment
                      </FieldLabel>
                      <input
                        type="number"
                        min="0"
                        max={Math.max(0, Math.round(cablePassSegmentLengthMm * 10) / 10)}
                        step="1"
                        value={Math.round(distanceFromTopMm * 10) / 10}
                        onChange={(event) =>
                          updateCablePass({ distanceFromTopMm: updateNumber(event.target.value) })
                        }
                      />
                    </label>
                    <label className="field">
                      <FieldLabel help="Longueur de recouvrement entre les deux parties du soufflet au niveau du passe-cable.">
                        Chevauchement passe cable
                      </FieldLabel>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={cablePass.overlapMm}
                        onChange={(event) =>
                          updateCablePass({ overlapMm: updateNumber(event.target.value) })
                        }
                      />
                    </label>
                  </>
                ) : null}
              </>
            );
          })()}
          <label className="field">
            <FieldLabel help="Une pièce utilise le périmètre complet. Une pièce par tube crée une bande par segment du tracé validé.">
              Découpe
            </FieldLabel>
            <select
              value={parameters.gusset.splitMode}
              onChange={(event) =>
                updateGusset({
                  splitMode: event.target.value as PatternParameters['gusset']['splitMode'],
                })
              }
            >
              <option value="single-piece">Une pièce</option>
              <option value="one-piece-per-tube">Une pièce par tube</option>
              <option value="manual">Manuelle</option>
            </select>
          </label>
          {parameters.gusset.splitMode === 'one-piece-per-tube' ? (
            <label className="field">
              <FieldLabel help="Angle minimum entre deux segments pour commencer une nouvelle pièce de soufflet. Les petits angles des courbes restent fusionnés.">
                Angle changement pièce
              </FieldLabel>
              <input
                type="number"
                min="1"
                max="180"
                step="1"
                value={parameters.gusset.angleBreakThresholdDeg}
                onChange={(event) =>
                  updateGusset({
                    angleBreakThresholdDeg: updateNumber(event.target.value),
                  })
                }
              />
            </label>
          ) : null}
          {parameters.gusset.splitMode === 'manual' ? (
            <div className="metric-row">
              <span>Points de coupe</span>
              <strong>{parameters.gusset.manualBreakSegmentIndices?.length ?? 0}</strong>
            </div>
          ) : null}
        </section>

        <div className="status-line">
          <Settings2 size={15} />
          {pieces.length} pièces générées automatiquement.
        </div>
      </aside>

      <section className="workspace pattern-workspace">
        <svg
          ref={svgRef}
          className={isPanning ? 'pattern-svg is-panning' : 'pattern-svg'}
          viewBox={layout.viewBox}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={handlePreviewPointerDown}
          onPointerMove={handlePreviewPointerMove}
          onPointerUp={handlePreviewPointerUp}
          onPointerCancel={handlePreviewPointerUp}
        >
          <rect className="pattern-background" width="100%" height="100%" />

          <g
            transform={`translate(${patternView.offsetX} ${patternView.offsetY}) scale(${patternView.scale})`}
          >
            {layout.pieces.map((piece) => (
              <g className="pattern-piece" key={piece.id}>
                {piece.paths.map((path, index) => (
                  <polygon
                    className={`pattern-piece-path ${piece.kind} ${pieceFaceClass(piece.id)}`}
                    key={`${piece.id}-path-${index}`}
                    points={pathPoints(path)}
                  />
                ))}
                {showReferencePaths
                  ? piece.referencePaths?.map((path, index) => (
                      <polygon
                        className="pattern-reference-path"
                        key={`${piece.id}-reference-${index}`}
                        points={pathPoints(path)}
                      />
                    ))
                  : null}
                {piece.annotations.map((annotation, index) => renderAnnotation(annotation, piece.id, index))}
              </g>
            ))}
          </g>
        </svg>
      </section>
    </main>
  );
}
