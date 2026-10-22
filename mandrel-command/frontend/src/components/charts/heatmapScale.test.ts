/**
 * Heatmap colour-scale util (P0.6) — pure interpolation math.
 */
import { describe, it, expect } from 'vitest';
import { hexToRgb, rgbToHex, interpolateColor, normalize } from './heatmapScale';

describe('heatmapScale', () => {
  it('hexToRgb parses long + short hex', () => {
    expect(hexToRgb('#ffffff')).toEqual([255, 255, 255]);
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    expect(hexToRgb('#f00')).toEqual([255, 0, 0]);
    expect(hexToRgb('2ED9C6')).toEqual([46, 217, 198]);
  });

  it('rgbToHex round-trips + clamps', () => {
    expect(rgbToHex(46, 217, 198)).toBe('#2ed9c6');
    expect(rgbToHex(-5, 300, 128)).toBe('#00ff80');
  });

  it('interpolateColor returns endpoints at t=0 and t=1', () => {
    const stops = ['#000000', '#ffffff'];
    expect(interpolateColor(stops, 0)).toBe('#000000');
    expect(interpolateColor(stops, 1)).toBe('#ffffff');
  });

  it('interpolateColor blends at the midpoint', () => {
    expect(interpolateColor(['#000000', '#ffffff'], 0.5)).toBe('#808080');
  });

  it('interpolateColor clamps out-of-range t', () => {
    expect(interpolateColor(['#000000', '#ffffff'], -1)).toBe('#000000');
    expect(interpolateColor(['#000000', '#ffffff'], 5)).toBe('#ffffff');
  });

  it('interpolateColor walks multi-stop ramps', () => {
    const stops = ['#000000', '#ff0000', '#ffffff'];
    expect(interpolateColor(stops, 0.5)).toBe('#ff0000'); // exactly the middle stop
  });

  it('normalize maps into [0,1] and guards a zero range', () => {
    expect(normalize(5, 0, 10)).toBe(0.5);
    expect(normalize(0, 0, 10)).toBe(0);
    expect(normalize(10, 0, 10)).toBe(1);
    expect(normalize(5, 5, 5)).toBe(0);
  });
});
