import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ImageMinimap from '../components/ImageMinimap';
import { fitMinimap } from '../utils/minimapGeometry';

/**
 * The minimap gesture.
 *
 * Every size arrives as a prop, so the component is exercised without a layout
 * engine: jsdom reports a zero-sized bounding box, which conveniently makes a
 * client coordinate the map coordinate. The one test that cares about the map's
 * position on the page stubs the rect to prove the offset is subtracted.
 */

/** A 1000x800 image fitted into a 400x300 pane at 2x → a 175x140 map. */
const METRICS = {
  imageWidth: 1000,
  imageHeight: 800,
  viewportWidth: 400,
  viewportHeight: 300,
  zoom: 2,
};

/** Where the view box sits at pan (0,0): 35x26.25 starting at (70, 56.875). */
const BOX = { left: 70, top: 56.875, width: 35, height: 26.25 };

const onPanChange = vi.fn();
const onDragStateChange = vi.fn();

const renderMap = (overrides: Partial<React.ComponentProps<typeof ImageMinimap>> = {}) =>
  render(
    <ImageMinimap
      thumbnailUrl="blob:thumb"
      {...METRICS}
      pan={{ x: 0, y: 0 }}
      onPanChange={onPanChange}
      onDragStateChange={onDragStateChange}
      {...overrides}
    />,
  );

const surface = () => screen.getByTestId('image-minimap');

const viewBoxElement = () =>
  surface().querySelector('div') as HTMLDivElement;

beforeEach(() => {
  onPanChange.mockClear();
  onDragStateChange.mockClear();
});

describe('ImageMinimap', () => {
  it('is the image, fitted to the map box and never enlarged', () => {
    renderMap();
    expect(surface().style.width).toBe('175px');
    expect(surface().style.height).toBe('140px');

    // A small image keeps its own size: no blurry upscale.
    const layout = fitMinimap(64, 64)!;
    expect(layout).toEqual({ width: 64, height: 64, scale: 1 });
  });

  it('draws the view box over the region the pane is showing', () => {
    renderMap();
    const box = viewBoxElement();
    expect(parseFloat(box.style.left)).toBeCloseTo(BOX.left, 6);
    expect(parseFloat(box.style.top)).toBeCloseTo(BOX.top, 6);
    expect(parseFloat(box.style.width)).toBeCloseTo(BOX.width, 6);
    expect(parseFloat(box.style.height)).toBeCloseTo(BOX.height, 6);
  });

  it('travels to a point pressed outside the box', () => {
    renderMap();
    // Top-left of the map: the box centres as close to it as the image allows,
    // which is clampPan's own limit — 800 and 650 display px for these numbers.
    fireEvent.mouseDown(surface(), { button: 0, clientX: 10, clientY: 10 });
    expect(onPanChange).toHaveBeenCalledWith(800, 650);
  });

  it('leaves the view alone when the box itself is grabbed', () => {
    renderMap();
    fireEvent.mouseDown(surface(), { button: 0, clientX: 80, clientY: 70 });
    // Grabbing the box must not snap its centre under the pointer.
    expect(onPanChange).not.toHaveBeenCalled();
  });

  it('follows the pointer 1:1 once dragging, from wherever it was grabbed', () => {
    renderMap();
    fireEvent.mouseDown(surface(), { button: 0, clientX: 80, clientY: 70 });

    // +35 map px is +200 display px of centre, which at 2x is -400 px of pan.
    fireEvent.mouseMove(window, { clientX: 115, clientY: 70 });
    expect(onPanChange).toHaveBeenCalledWith(-400, 0);

    // And the offset from the grab is preserved: another +35 moves it again.
    fireEvent.mouseMove(window, { clientX: 150, clientY: 70 });
    const [lastX, lastY] = onPanChange.mock.lastCall!;
    expect(lastX).toBeCloseTo(-800, 6);
    expect(lastY).toBeCloseTo(0, 6);
  });

  it('hears the move while the pointer is over the map itself', () => {
    renderMap();
    fireEvent.mouseDown(surface(), { button: 0, clientX: 80, clientY: 70 });

    // A browser sends the move to whatever is under the pointer — usually this
    // very element — and it reaches a window listener only by bubbling. Aiming a
    // synthetic event at window skips that journey and hides a handler that stops
    // it, which is exactly how the map's own drag broke.
    fireEvent.mouseMove(surface(), { clientX: 115, clientY: 70 });
    expect(onPanChange).toHaveBeenCalledWith(-400, 0);
  });

  it('hears the button come up over the map itself', () => {
    renderMap();
    fireEvent.mouseDown(surface(), { button: 0, clientX: 80, clientY: 70 });

    fireEvent.mouseUp(surface());
    fireEvent.mouseMove(surface(), { clientX: 150, clientY: 70 });
    expect(onPanChange).not.toHaveBeenCalled();
    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
  });

  it('measures from the map, not from the window', () => {
    renderMap();
    const rect = surface().getBoundingClientRect();
    // jsdom hands back a zero rect; place the map somewhere else on the page.
    vi.spyOn(surface(), 'getBoundingClientRect').mockReturnValue({
      ...rect,
      left: 300,
      top: 200,
    } as DOMRect);

    fireEvent.mouseDown(surface(), { button: 0, clientX: 310, clientY: 210 });
    // The same press as the jump test above, 300/200 px further down the page.
    expect(onPanChange).toHaveBeenCalledWith(800, 650);
  });

  it('stops following the pointer once the button comes up', () => {
    renderMap();
    fireEvent.mouseDown(surface(), { button: 0, clientX: 80, clientY: 70 });
    fireEvent.mouseMove(window, { clientX: 115, clientY: 70 });
    expect(onPanChange).toHaveBeenCalledTimes(1);

    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 150, clientY: 70 });
    expect(onPanChange).toHaveBeenCalledTimes(1);
  });

  it('announces the drag so the caller can drop the image easing', () => {
    renderMap();
    expect(onDragStateChange).not.toHaveBeenCalled();

    fireEvent.mouseDown(surface(), { button: 0, clientX: 80, clientY: 70 });
    expect(onDragStateChange).toHaveBeenLastCalledWith(true);

    fireEvent.mouseUp(window);
    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
  });

  it('ignores buttons that are not the primary one', () => {
    renderMap();
    fireEvent.mouseDown(surface(), { button: 2, clientX: 80, clientY: 70 });
    expect(onPanChange).not.toHaveBeenCalled();
    expect(onDragStateChange).not.toHaveBeenCalled();
  });

  it('draws nothing until the image and pane have been measured', () => {
    renderMap({ imageWidth: 0, imageHeight: 0 });
    expect(screen.queryByTestId('image-minimap')).toBeNull();
  });

  it('keeps its own copy of the image out of the drag system', () => {
    renderMap();
    const image = surface().querySelector('img')!;
    // The pane's image starts an OS file drag on dragstart; the map's must not.
    expect(image.getAttribute('draggable')).toBe('false');
    expect(image.className).toContain('pointer-events-none');
  });
});
