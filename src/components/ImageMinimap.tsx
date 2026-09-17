import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  computeViewBox,
  fitMinimap,
  panForMinimapCentre,
  type Point,
} from "../utils/minimapGeometry";

/**
 * The zoomed view's navigator: the whole image with a box marking what the pane
 * is showing. Drag the box to travel, or press anywhere on the map to jump there
 * and keep dragging from the jump.
 *
 * Measures nothing itself — every size arrives as a prop — so the mapping is
 * exercised in tests without a layout engine. Visibility belongs to the caller:
 * this draws whatever its props describe (ImageModal mounts it only above 1x).
 */
export interface ImageMinimapProps {
  /** Whole-image pixels. The 512px-capped thumbnail is plenty and is already cached. */
  thumbnailUrl: string;
  /** The image's laid-out size at scale 1 (display px). */
  imageWidth: number;
  imageHeight: number;
  /** The pane's size — the same numbers `clampPan` uses. */
  viewportWidth: number;
  viewportHeight: number;
  zoom: number;
  pan: Point;
  /** Moves the pane; the caller clamps. */
  onPanChange: (x: number, y: number) => void;
  /** Raised while a drag is live so the caller can drop the image's easing. */
  onDragStateChange: (dragging: boolean) => void;
}

interface DragState {
  /** Where the box's centre sat when the drag began, in map px. */
  centreX: number;
  centreY: number;
  /** Pointer position at mousedown, in client coords. */
  originX: number;
  originY: number;
}

const isPositive = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

const ImageMinimap: React.FC<ImageMinimapProps> = ({
  thumbnailUrl,
  imageWidth,
  imageHeight,
  viewportWidth,
  viewportHeight,
  zoom,
  pan,
  onPanChange,
  onDragStateChange,
}) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const layout = fitMinimap(imageWidth, imageHeight);
  const mapWidth = layout?.width ?? 0;
  const mapHeight = layout?.height ?? 0;
  const mapScale = layout?.scale ?? 0;
  const viewBox = layout
    ? computeViewBox({
        imageWidth,
        imageHeight,
        viewportWidth,
        viewportHeight,
        zoom,
        pan,
        layout,
      })
    : null;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || !viewBox || !isPositive(mapScale)) return;
      // This gesture is the map's, not the pane's: without this the image's own
      // pan-drag (and its window-edge file drag) would start underneath it too.
      e.stopPropagation();
      e.preventDefault();

      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect) return;

      const mapX = e.clientX - rect.left;
      const mapY = e.clientY - rect.top;
      const boxCentreX = viewBox.left + viewBox.width / 2;
      const boxCentreY = viewBox.top + viewBox.height / 2;
      const insideBox =
        mapX >= viewBox.left &&
        mapX <= viewBox.left + viewBox.width &&
        mapY >= viewBox.top &&
        mapY <= viewBox.top + viewBox.height;

      // Grabbing the box keeps the offset between pointer and centre; pressing
      // outside travels there first, centring the box under the pointer. Either
      // way the drag then reads as "this point of the map has moved by this much".
      const centreX = insideBox ? boxCentreX : mapX;
      const centreY = insideBox ? boxCentreY : mapY;

      if (!insideBox) {
        const jumped = panForMinimapCentre({
          imageWidth,
          imageHeight,
          viewportWidth,
          viewportHeight,
          zoom,
          layout: { width: mapWidth, height: mapHeight, scale: mapScale },
          centreX,
          centreY,
        });
        onPanChange(jumped.x, jumped.y);
      }

      setDrag({ centreX, centreY, originX: e.clientX, originY: e.clientY });
    },
    [
      viewBox,
      mapScale,
      mapWidth,
      mapHeight,
      onPanChange,
      imageWidth,
      imageHeight,
      viewportWidth,
      viewportHeight,
      zoom,
    ],
  );

  // Window-level move/up: a target this small makes leaving it mid-drag routine.
  useEffect(() => {
    if (!drag) return;

    onDragStateChange(true);

    const handleMove = (e: MouseEvent) => {
      // The centre moves with the pointer 1:1 — the map is at 1:1 with client px —
      // so a wheel-zoom landing mid-drag re-derives the pan for the new zoom
      // instead of re-baselining the gesture.
      const next = panForMinimapCentre({
        imageWidth,
        imageHeight,
        viewportWidth,
        viewportHeight,
        zoom,
        layout: { width: mapWidth, height: mapHeight, scale: mapScale },
        centreX: drag.centreX + (e.clientX - drag.originX),
        centreY: drag.centreY + (e.clientY - drag.originY),
      });
      onPanChange(next.x, next.y);
    };
    const handleUp = () => setDrag(null);

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    // Alt-tabbing away with the button down never delivers a mouseup.
    window.addEventListener("blur", handleUp);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      window.removeEventListener("blur", handleUp);
      // Every teardown ends a gesture: mouseup, blur, unmount, or a zoom change
      // that re-anchored it.
      onDragStateChange(false);
    };
  }, [
    drag,
    mapWidth,
    mapHeight,
    mapScale,
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    zoom,
    onPanChange,
    onDragStateChange,
  ]);

  if (!layout || !viewBox) return null;

  // Only the gesture's START is isolated from the pane underneath. React's
  // stopPropagation calls the native event's too, and React listens at the root
  // container — so stopping a *move* or an *up* here would also stop it reaching
  // the window listeners this component's own drag runs on. Nothing later in the
  // gesture needs isolating: the pane's handlers all bail while it is not dragging.
  return (
    <div
      ref={surfaceRef}
      data-testid="image-minimap"
      className="image-minimap relative cursor-crosshair select-none rounded-sm overflow-hidden"
      style={{ width: layout.width, height: layout.height }}
      title="Minimap: drag the box to pan, click to jump"
      onMouseDown={handleMouseDown}
      onTouchStart={(e) => e.stopPropagation()}
    >
      {/* object-fill: this element is already sized to the image's aspect, so it
          only absorbs the sub-pixel rounding in the cached thumbnail. */}
      <img
        src={thumbnailUrl}
        alt=""
        draggable={false}
        className="w-full h-full object-fill pointer-events-none"
      />
      <div
        className="absolute pointer-events-none box-border border border-gray-50/80 bg-gray-50/15"
        style={{
          left: viewBox.left,
          top: viewBox.top,
          width: viewBox.width,
          height: viewBox.height,
        }}
      />
    </div>
  );
};

export default ImageMinimap;
