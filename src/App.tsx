import {
  ChangeEvent,
  FormEvent,
  MouseEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlignHorizontalSpaceAround,
  CheckCircle2,
  CirclePlus,
  Crosshair,
  ImagePlus,
  Move,
  MousePointer2,
  Redo2,
  RotateCcw,
  Ruler,
  Trash2,
  Undo2,
  ZoomIn,
} from 'lucide-react';
import {
  angleToHorizontal,
  DEFAULT_MM_PER_UNIT,
  pointsToPolyline,
  rotateImageFrameAround,
  rotatePointsAround,
  scaleImageFrameAround,
  scalePointsAround,
  screenToWorld,
  segmentEndIndex,
  segmentLengthInMm,
  segmentMidpoint,
  segmentScaleFactorForTargetMm,
  zoomAtScreenPoint,
} from './geometry';
import { DEFAULT_PATTERN_PARAMETERS } from './pattern/defaults';
import { PatternWorkspace } from './pattern/PatternWorkspace';
import { createValidatedBagShape } from './pattern/shape';
import type { PatternParameters, ValidatedBagShape } from './pattern/types';
import type { Point, SceneImage, SegmentSelection, ViewTransform } from './types';

type Interaction =
  | {
      kind: 'pan';
      pointerId: number;
      startScreen: Point;
      startView: ViewTransform;
      addsPointOnClick: boolean;
      moved: boolean;
    }
  | {
      kind: 'point';
      pointerId: number;
      index: number;
      startScreen: Point;
      startScene: SceneSnapshot;
      historyRecorded: boolean;
      moved: boolean;
    };

type ContextMenuState =
  | {
      kind: 'point';
      index: number;
      x: number;
      y: number;
    }
  | {
      kind: 'segment';
      startIndex: number;
      worldPoint: Point;
      x: number;
      y: number;
    };

type SceneSnapshot = {
  image: SceneImage | null;
  points: Point[];
  isClosed: boolean;
};

type AppMode = 'trace' | 'pattern';

const INITIAL_VIEW: ViewTransform = {
  offsetX: 80,
  offsetY: 80,
  scale: 1,
};

const POINT_NODE_RADIUS_PX = 5;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = src;
  });
}

function formatMm(value: number): string {
  return new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 1,
  }).format(value);
}

export default function App() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const interactionRef = useRef<Interaction | null>(null);

  const [image, setImage] = useState<SceneImage | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [isClosed, setIsClosed] = useState(false);
  const [mode, setMode] = useState<AppMode>('trace');
  const [validatedShape, setValidatedShape] = useState<ValidatedBagShape | null>(null);
  const [patternParameters, setPatternParameters] = useState<PatternParameters>(
    DEFAULT_PATTERN_PARAMETERS,
  );
  const [view, setView] = useState(INITIAL_VIEW);
  const [selectedSegment, setSelectedSegment] = useState<SegmentSelection | null>(null);
  const [lengthInput, setLengthInput] = useState('');
  const [mmPerUnit] = useState(DEFAULT_MM_PER_UNIT);
  const [previewPoint, setPreviewPoint] = useState<Point | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [historyPast, setHistoryPast] = useState<SceneSnapshot[]>([]);
  const [historyFuture, setHistoryFuture] = useState<SceneSnapshot[]>([]);
  const [status, setStatus] = useState('Importez une photo, puis cliquez dans la zone pour tracer.');

  const makeSceneSnapshot = useCallback(
    (): SceneSnapshot => ({
      image: image ? { ...image } : null,
      points: points.map((point) => ({ ...point })),
      isClosed,
    }),
    [image, isClosed, points],
  );

  const applySceneSnapshot = useCallback((snapshot: SceneSnapshot) => {
    setImage(snapshot.image ? { ...snapshot.image } : null);
    setPoints(snapshot.points.map((point) => ({ ...point })));
    setIsClosed(snapshot.isClosed);
    setSelectedSegment(null);
    setLengthInput('');
    setContextMenu(null);
    setPreviewPoint(null);
  }, []);

  const pushHistorySnapshot = useCallback((snapshot: SceneSnapshot) => {
    setHistoryPast((current) => [...current.slice(-79), snapshot]);
    setHistoryFuture([]);
  }, []);

  const recordHistory = useCallback(() => {
    pushHistorySnapshot(makeSceneSnapshot());
  }, [makeSceneSnapshot, pushHistorySnapshot]);

  const undo = useCallback(() => {
    if (historyPast.length === 0) {
      return;
    }

    const previous = historyPast[historyPast.length - 1];

    setHistoryPast((past) => past.slice(0, -1));
    setHistoryFuture((future) => [makeSceneSnapshot(), ...future]);
    applySceneSnapshot(previous);
    setStatus('Action annulée.');
  }, [applySceneSnapshot, historyPast, makeSceneSnapshot]);

  const redo = useCallback(() => {
    if (historyFuture.length === 0) {
      return;
    }

    const next = historyFuture[0];

    setHistoryPast((past) => [...past.slice(-79), makeSceneSnapshot()]);
    setHistoryFuture((future) => future.slice(1));
    applySceneSnapshot(next);
    setStatus('Action rejouée.');
  }, [applySceneSnapshot, historyFuture, makeSceneSnapshot]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTextInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;

      if (isTextInput || (!event.ctrlKey && !event.metaKey)) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === 'z' && event.shiftKey) {
        event.preventDefault();
        redo();
        return;
      }

      if (key === 'z') {
        event.preventDefault();
        undo();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [redo, undo]);

  const segmentCount = isClosed ? points.length : Math.max(0, points.length - 1);
  const selectedSegmentPoints = useMemo(() => {
    if (!selectedSegment || points.length < 2) {
      return null;
    }

    const start = selectedSegment.startIndex;
    const end = segmentEndIndex(start, points.length, isClosed);

    if (start === end) {
      return null;
    }

    return {
      start,
      end,
      a: points[start],
      b: points[end],
    };
  }, [isClosed, points, selectedSegment]);
  const pointNodeRadius = POINT_NODE_RADIUS_PX / view.scale;

  const currentSelectedLengthMm = selectedSegmentPoints
    ? segmentLengthInMm(selectedSegmentPoints.a, selectedSegmentPoints.b, mmPerUnit)
    : null;

  function getScreenPoint(event: { clientX: number; clientY: number }): Point {
    const rect = svgRef.current?.getBoundingClientRect();

    if (!rect) {
      return { x: 0, y: 0 };
    }

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function addPoint(point: Point) {
    if (isClosed) {
      return;
    }

    recordHistory();
    setPoints((current) => [...current, point]);
    setPreviewPoint(point);
    setSelectedSegment(null);
    setStatus('Point ajouté. Cliquez sur le premier point pour fermer la forme.');
  }

  function closeShape() {
    if (points.length < 3) {
      return;
    }

    recordHistory();
    setIsClosed(true);
    setSelectedSegment(null);
    setPreviewPoint(null);
    setStatus('Forme fermée. Déplacez les points ou sélectionnez un segment à calibrer.');
  }

  async function handleImageImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const src = await readFileAsDataUrl(file);
    const dimensions = await loadImageDimensions(src);

    setImage({
      src,
      opacity: 0.55,
      naturalWidth: dimensions.width,
      naturalHeight: dimensions.height,
      rotation: 0,
      x: 0,
      y: 0,
      width: dimensions.width,
      height: dimensions.height,
    });
    recordHistory();
    setStatus('Photo importée. Ajustez son opacité et tracez la sacoche.');
  }

  function handleWorkspacePointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 && event.button !== 2) {
      return;
    }

    setContextMenu(null);
    const startScreen = getScreenPoint(event);
    interactionRef.current = {
      kind: 'pan',
      pointerId: event.pointerId,
      startScreen,
      startView: view,
      addsPointOnClick: event.button === 0,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointPointerDown(index: number, event: PointerEvent<SVGCircleElement>) {
    event.stopPropagation();

    if (event.button !== 0) {
      return;
    }

    setContextMenu(null);

    if (event.altKey) {
      deletePoint(index);
      return;
    }

    interactionRef.current = {
      kind: 'point',
      pointerId: event.pointerId,
      index,
      startScreen: getScreenPoint(event),
      startScene: makeSceneSnapshot(),
      historyRecorded: false,
      moved: false,
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    const interaction = interactionRef.current;
    const screenPoint = getScreenPoint(event);

    if (!interaction) {
      if (!isClosed && points.length > 0) {
        setPreviewPoint(screenToWorld(screenPoint, view));
      }

      return;
    }

    if (interaction.pointerId !== event.pointerId) {
      return;
    }

    const moved =
      Math.abs(screenPoint.x - interaction.startScreen.x) > 3 ||
      Math.abs(screenPoint.y - interaction.startScreen.y) > 3;

    if (interaction.kind === 'pan') {
      interactionRef.current = { ...interaction, moved: interaction.moved || moved };
      setView({
        ...interaction.startView,
        offsetX: interaction.startView.offsetX + screenPoint.x - interaction.startScreen.x,
        offsetY: interaction.startView.offsetY + screenPoint.y - interaction.startScreen.y,
      });
      return;
    }

    interactionRef.current = { ...interaction, moved: interaction.moved || moved };
    if (moved && !interaction.historyRecorded) {
      pushHistorySnapshot(interaction.startScene);
      interactionRef.current = {
        ...interaction,
        historyRecorded: true,
        moved: interaction.moved || moved,
      };
    }
    const worldPoint = screenToWorld(screenPoint, view);
    setPoints((current) =>
      current.map((point, pointIndex) => (pointIndex === interaction.index ? worldPoint : point)),
    );
  }

  function handlePointerUp(event: PointerEvent<SVGSVGElement>) {
    const interaction = interactionRef.current;

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    interactionRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);

    if (interaction.kind === 'pan' && !interaction.moved) {
      if (interaction.addsPointOnClick) {
        addPoint(screenToWorld(getScreenPoint(event), view));
      }
    }

    if (interaction.kind === 'point' && !interaction.moved && interaction.index === 0 && !isClosed) {
      closeShape();
    }
  }

  function handleWheel(event: React.WheelEvent<SVGSVGElement>) {
    event.preventDefault();
    setContextMenu(null);
    const rect = svgRef.current?.getBoundingClientRect();

    if (!rect) {
      return;
    }

    const screenPoint = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const zoomFactor = event.deltaY < 0 ? 1.12 : 0.88;

    setView((current) => zoomAtScreenPoint(current, screenPoint, current.scale * zoomFactor));
  }

  function selectSegment(startIndex: number, event: PointerEvent<SVGLineElement>) {
    event.stopPropagation();

    if (event.button !== 0) {
      return;
    }

    setContextMenu(null);
    const endIndex = segmentEndIndex(startIndex, points.length, isClosed);
    const lengthMm = segmentLengthInMm(points[startIndex], points[endIndex], mmPerUnit);

    setSelectedSegment({ startIndex });
    setLengthInput(String(Math.round(lengthMm * 10) / 10));
    setStatus('Segment sélectionné. Saisissez sa longueur réelle en millimètres.');
  }

  function insertPointInSegment(startIndex: number, event: MouseEvent<SVGLineElement>) {
    event.stopPropagation();
    const point = screenToWorld(getScreenPoint(event), view);

    insertPointAtSegment(startIndex, point);
  }

  function insertPointAtSegment(startIndex: number, point: Point) {
    const insertIndex = startIndex + 1;

    recordHistory();
    setPoints((current) => [
      ...current.slice(0, insertIndex),
      point,
      ...current.slice(insertIndex),
    ]);
    setSelectedSegment(null);
    setLengthInput('');
    setContextMenu(null);
    setStatus('Point ajouté dans le segment.');
  }

  function deletePoint(index: number) {
    recordHistory();
    setPoints((current) => {
      const next = current.filter((_, pointIndex) => pointIndex !== index);

      if (next.length < 3) {
        setIsClosed(false);
      }

      return next;
    });
    setSelectedSegment(null);
    setLengthInput('');
    setContextMenu(null);
    setStatus('Point supprimé.');
  }

  function openPointContextMenu(index: number, event: MouseEvent<SVGCircleElement>) {
    event.preventDefault();
    event.stopPropagation();
    const screenPoint = getScreenPoint(event);

    setContextMenu({
      kind: 'point',
      index,
      x: screenPoint.x,
      y: screenPoint.y,
    });
  }

  function openSegmentContextMenu(startIndex: number, event: MouseEvent<SVGLineElement>) {
    event.preventDefault();
    event.stopPropagation();
    const screenPoint = getScreenPoint(event);

    setContextMenu({
      kind: 'segment',
      startIndex,
      worldPoint: screenToWorld(screenPoint, view),
      x: screenPoint.x,
      y: screenPoint.y,
    });
  }

  function handleWorkspaceContextMenu(event: MouseEvent<SVGSVGElement>) {
    event.preventDefault();
    setContextMenu(null);
  }

  function runContextMenuAction() {
    if (!contextMenu) {
      return;
    }

    if (contextMenu.kind === 'point') {
      deletePoint(contextMenu.index);
      return;
    }

    insertPointAtSegment(contextMenu.startIndex, contextMenu.worldPoint);
  }

  function applyCalibration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedSegmentPoints) {
      return;
    }

    const targetMm = Number(lengthInput.replace(',', '.'));

    if (!Number.isFinite(targetMm) || targetMm <= 0) {
      setStatus('La longueur doit être un nombre positif.');
      return;
    }

    const scaleFactor = segmentScaleFactorForTargetMm(
      selectedSegmentPoints.a,
      selectedSegmentPoints.b,
      mmPerUnit,
      targetMm,
    );
    const origin = segmentMidpoint(selectedSegmentPoints.a, selectedSegmentPoints.b);

    recordHistory();
    setPoints((current) => scalePointsAround(current, origin, scaleFactor));
    setImage((current) =>
      current
        ? {
            ...current,
            ...scaleImageFrameAround(current, origin, scaleFactor),
          }
        : current,
    );
    setStatus(`Calibration appliquée : segment réglé à ${formatMm(targetMm)} mm.`);
  }

  function straightenSelectedSegment() {
    if (!selectedSegmentPoints) {
      setStatus('Sélectionnez un segment avant de remettre droit.');
      return;
    }

    const rotation = angleToHorizontal(selectedSegmentPoints.a, selectedSegmentPoints.b);

    if (Math.abs(rotation) < 0.0001) {
      setStatus('Le segment sélectionné est déjà horizontal.');
      return;
    }

    const origin = segmentMidpoint(selectedSegmentPoints.a, selectedSegmentPoints.b);

    recordHistory();
    setPoints((current) => rotatePointsAround(current, origin, rotation));
    setImage((current) => (current ? rotateImageFrameAround(current, origin, rotation) : current));
    setContextMenu(null);
    setStatus('Segment remis horizontal, photo et tracé réorientés.');
  }

  function resetView() {
    setView(INITIAL_VIEW);
  }

  function clearTrace() {
    recordHistory();
    setPoints([]);
    setIsClosed(false);
    setValidatedShape(null);
    setSelectedSegment(null);
    setLengthInput('');
    setPreviewPoint(null);
    setStatus('Tracé réinitialisé. Cliquez dans la zone pour ajouter un point.');
  }

  function validateTrace() {
    try {
      const shape = createValidatedBagShape(points, isClosed, mmPerUnit);

      setValidatedShape(shape);
      setMode('pattern');
      setStatus('Tracé validé. Les pièces de patronnage sont générées.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Impossible de valider le tracé.');
    }
  }

  function returnToTrace() {
    setMode('trace');
    setStatus('Retour au tracé. Modifiez la forme puis validez à nouveau.');
  }

  if (mode === 'pattern' && validatedShape) {
    return (
      <PatternWorkspace
        shape={validatedShape}
        parameters={patternParameters}
        onParametersChange={setPatternParameters}
        onBackToTrace={returnToTrace}
      />
    );
  }

  return (
    <main className="app-shell">
      <aside className="tool-panel" aria-label="Outils">
        <div className="brand-block">
          <Crosshair size={22} />
          <div>
            <h1>Cadre Pattern</h1>
            <p>POC tracé sacoche</p>
          </div>
        </div>

        <section className="tool-section">
          <div className="section-title">Photo</div>
          <input
            ref={fileInputRef}
            className="hidden-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleImageImport}
          />
          <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()}>
            <ImagePlus size={18} />
            Importer
          </button>

          <label className="field">
            <span>Opacité</span>
            <input
              type="range"
              min="0.05"
              max="1"
              step="0.05"
              value={image?.opacity ?? 0.55}
              disabled={!image}
              onChange={(event) =>
                setImage((current) =>
                  current ? { ...current, opacity: Number(event.target.value) } : current,
                )
              }
            />
          </label>
        </section>

        <section className="tool-section">
          <div className="section-title">Tracé</div>
          <div className="metric-row">
            <span>Points</span>
            <strong>{points.length}</strong>
          </div>
          <div className="metric-row">
            <span>État</span>
            <strong>{isClosed ? 'Fermé' : 'Ouvert'}</strong>
          </div>
          <div className="button-row">
            <button
              className="secondary-button"
              type="button"
              onClick={undo}
              disabled={historyPast.length === 0}
            >
              <Undo2 size={17} />
              Retour
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={redo}
              disabled={historyFuture.length === 0}
            >
              <Redo2 size={17} />
              Suivant
            </button>
          </div>
          <button className="secondary-button" type="button" onClick={clearTrace} disabled={points.length === 0}>
            <RotateCcw size={17} />
            Réinitialiser
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={validateTrace}
            disabled={!isClosed || points.length < 3}
          >
            <CheckCircle2 size={18} />
            Valider le tracé
          </button>
        </section>

        <section className="tool-section">
          <div className="section-title">Navigation</div>
          <button className="secondary-button" type="button" onClick={resetView}>
            <ZoomIn size={17} />
            Reset vue
          </button>
          <div className="hint-list">
            <span>
              <MousePointer2 size={15} /> Clic fond : point
            </span>
            <span>
              <MousePointer2 size={15} /> Alt + clic point : supprimer
            </span>
            <span>
              <MousePointer2 size={15} /> Clic droit : menu
            </span>
            <span>
              <MousePointer2 size={15} /> Ctrl+Z / Ctrl+Shift+Z
            </span>
            <span>
              <MousePointer2 size={15} /> Double-clic segment : insérer
            </span>
            <span>
              <Move size={15} /> Glisser fond : pan
            </span>
            <span>
              <ZoomIn size={15} /> Molette : zoom
            </span>
          </div>
        </section>

        <section className="tool-section">
          <div className="section-title">Calibration</div>
          {selectedSegmentPoints && currentSelectedLengthMm !== null ? (
            <form className="calibration-form" onSubmit={applyCalibration}>
              <div className="metric-row">
                <span>Segment</span>
                <strong>
                  {selectedSegmentPoints.start + 1}-{selectedSegmentPoints.end + 1}
                </strong>
              </div>
              <div className="metric-row">
                <span>Longueur</span>
                <strong>{formatMm(currentSelectedLengthMm)} mm</strong>
              </div>
              <label className="field">
                <span>Longueur réelle</span>
                <input
                  type="number"
                  min="1"
                  step="0.1"
                  value={lengthInput}
                  onChange={(event) => setLengthInput(event.target.value)}
                />
              </label>
              <button className="primary-button" type="submit">
                <Ruler size={18} />
                Appliquer
              </button>
              <button className="secondary-button" type="button" onClick={straightenSelectedSegment}>
                <AlignHorizontalSpaceAround size={18} />
                Remettre droit
              </button>
            </form>
          ) : (
            <p className="empty-state">Sélectionnez un segment du tracé pour saisir sa longueur en mm.</p>
          )}
        </section>

        <div className="status-line">{status}</div>
      </aside>

      <section className="workspace">
        <svg
          ref={svgRef}
          className="editor-svg"
          onPointerDown={handleWorkspacePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onContextMenu={handleWorkspaceContextMenu}
          onWheel={handleWheel}
        >
          <defs>
            <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path d="M 32 0 L 0 0 0 32" fill="none" stroke="rgba(31, 41, 55, 0.08)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect className="workspace-hit-area" width="100%" height="100%" fill="url(#grid)" />

          <g transform={`translate(${view.offsetX} ${view.offsetY}) scale(${view.scale})`}>
            {image && (
              <image
                href={image.src}
                x={image.x}
                y={image.y}
                width={image.width}
                height={image.height}
                opacity={image.opacity}
                transform={`rotate(${(image.rotation * 180) / Math.PI} ${image.x + image.width / 2} ${
                  image.y + image.height / 2
                })`}
                preserveAspectRatio="none"
              />
            )}

            {points.length > 1 && (
              <>
                {isClosed ? (
                  <polygon className="shape-fill" points={pointsToPolyline(points)} />
                ) : null}
                <polyline className="shape-line" points={pointsToPolyline(points)} />
                {isClosed && points.length > 2 ? (
                  <line
                    className="shape-line"
                    x1={points[points.length - 1].x}
                    y1={points[points.length - 1].y}
                    x2={points[0].x}
                    y2={points[0].y}
                  />
                ) : null}
              </>
            )}

            {Array.from({ length: segmentCount }, (_, index) => {
              const endIndex = segmentEndIndex(index, points.length, isClosed);
              const a = points[index];
              const b = points[endIndex];
              const selected = selectedSegment?.startIndex === index;

              return (
                <line
                  key={`segment-${index}-${endIndex}`}
                  className={selected ? 'segment-hit-area selected' : 'segment-hit-area'}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  vectorEffect="non-scaling-stroke"
                  onPointerDown={(event) => selectSegment(index, event)}
                  onDoubleClick={(event) => insertPointInSegment(index, event)}
                  onContextMenu={(event) => openSegmentContextMenu(index, event)}
                />
              );
            })}

            {!isClosed && points.length > 0 && previewPoint ? (
              <line
                className="preview-line"
                x1={points[points.length - 1].x}
                y1={points[points.length - 1].y}
                x2={previewPoint.x}
                y2={previewPoint.y}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}

            {points.map((point, index) => (
              <circle
                key={`${point.x}-${point.y}-${index}`}
                className={index === 0 && !isClosed && points.length >= 3 ? 'point-node close-ready' : 'point-node'}
                cx={point.x}
                cy={point.y}
                r={pointNodeRadius}
                vectorEffect="non-scaling-stroke"
                onPointerDown={(event) => handlePointPointerDown(index, event)}
                onContextMenu={(event) => openPointContextMenu(index, event)}
              />
            ))}
          </g>
        </svg>

        {contextMenu ? (
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
          >
            <button type="button" onClick={runContextMenuAction}>
              {contextMenu.kind === 'point' ? <Trash2 size={16} /> : <CirclePlus size={16} />}
              {contextMenu.kind === 'point' ? 'Supprimer le point' : 'Ajouter un point'}
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
