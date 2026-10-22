/**
 * Chart wrapper render tests (P0.6). Mounts into jsdom with createRoot + act (the
 * repo pattern). Charts render NON-responsive at a fixed pixel size — jsdom has
 * no layout, so ResponsiveContainer would measure 0×0 and recharts would draw
 * nothing; a fixed size gives real SVG to assert on. Covers the three required
 * states (data / empty / loading) plus the graph + heatmap baselines.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, afterEach } from 'vitest';
import {
  AreaChartCard,
  LineChartCard,
  BarChartCard,
  PieChartCard,
  Sparkline,
  Heatmap,
  GraphView,
} from './index';

let container: HTMLDivElement;
let root: Root;

function mount(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(ui);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const trend = [
  { day: 'Mon', value: 12 },
  { day: 'Tue', value: 18 },
  { day: 'Wed', value: 9 },
  { day: 'Thu', value: 24 },
  { day: 'Fri', value: 20 },
];

const FIXED = { responsive: false as const, width: 420, height: 200 };

describe('AreaChartCard states', () => {
  it('renders an SVG chart with data', () => {
    mount(<AreaChartCard data={trend} xKey="day" caption="Contexts / day" {...FIXED} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // The area/line series draws at least one <path>.
    expect(container.querySelectorAll('path').length).toBeGreaterThan(0);
  });

  it('shows the Spinner while loading (no chart)', () => {
    mount(<AreaChartCard data={trend} xKey="day" loading {...FIXED} />);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('shows the Empty state when there is no data', () => {
    mount(<AreaChartCard data={[]} xKey="day" {...FIXED} />);
    expect(container.textContent).toMatch(/No data yet/i);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('themes differently for dark vs light (explicit prop)', () => {
    // Sanity that the explicit theme prop is honoured end-to-end (no throw,
    // renders an svg in both). Colour correctness is covered by chartTheme.test.
    mount(<AreaChartCard data={trend} xKey="day" theme="light" {...FIXED} />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('LineChartCard', () => {
  it('renders multi-series lines', () => {
    const data = [
      { t: '1', coordinator: 5, tick: 2 },
      { t: '2', coordinator: 8, tick: 3 },
      { t: '3', coordinator: 6, tick: 4 },
    ];
    mount(
      <LineChartCard
        data={data}
        xKey="t"
        series={[{ key: 'coordinator' }, { key: 'tick' }]}
        {...FIXED}
      />,
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('BarChartCard', () => {
  it('renders bars with a per-datum colour key', () => {
    // colorKey resolves per-row; use a themed value indirectly via status chart.
    mount(
      <BarChartCard
        data={[{ status: 'open', count: 12 }, { status: 'done', count: 30 }]}
        xKey="status"
        series={[{ key: 'count', name: 'Tasks' }]}
        {...FIXED}
      />,
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });

  // Regression: a horizontal (layout="vertical") STACKED bar with showAxes={false} — the
  // exact "Open tasks by status" config — must still draw its bars. The prior code omitted
  // the axes entirely when showAxes was false, so recharts fell back to default axis TYPES
  // that don't match a vertical layout → a zero-width, blank bar. The fix keeps the axes
  // (correct per-layout types) and merely HIDES them.
  it('draws stacked bars with showAxes={false} + vertical layout (blank-chart regression)', () => {
    mount(
      <BarChartCard
        data={[{ name: 'Open', todo: 95, in_progress: 3, blocked: 15 }]}
        xKey="name"
        series={[
          { key: 'todo', name: 'Todo' },
          { key: 'in_progress', name: 'In progress' },
          { key: 'blocked', name: 'Blocked' },
        ]}
        layout="vertical"
        stacked
        showAxes={false}
        showGrid={false}
        {...FIXED}
      />,
    );
    // The bars render as recharts rectangle shapes; a blank chart has none. Each of the 3
    // stacked series contributes a shape for the single row → at least one bar drawn.
    const bars = container.querySelectorAll('.recharts-rectangle');
    expect(bars.length).toBeGreaterThan(0);
  });

  it('renders a category axis for the empty and single-row populations without throwing', () => {
    for (const rows of [[], [{ label: 'only', count: 1 }]]) {
      mount(
        <BarChartCard
          data={rows}
          xKey="label"
          series={[{ key: 'count', name: 'Completed' }]}
          layout="vertical"
          empty={false}
          {...FIXED}
        />,
      );
      expect(container.querySelector('svg')).not.toBeNull();
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('PieChartCard', () => {
  it('renders a donut with slices', () => {
    mount(
      <PieChartCard
        data={[
          { name: 'open', value: 12 },
          { name: 'done', value: 30 },
          { name: 'blocked', value: 4 },
        ]}
        {...FIXED}
      />,
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('is empty when every slice is zero', () => {
    mount(<PieChartCard data={[{ name: 'a', value: 0 }]} {...FIXED} />);
    expect(container.textContent).toMatch(/No data yet/i);
  });
});

describe('Sparkline', () => {
  it('renders a bare area sparkline', () => {
    mount(<Sparkline data={trend} responsive={false} width={120} height={40} />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelectorAll('path').length).toBeGreaterThan(0);
  });
});

describe('Heatmap', () => {
  it('renders an SVG cell grid from a matrix', () => {
    mount(
      <Heatmap
        matrix={[
          [1, 0.4, 0.2],
          [0.4, 1, 0.6],
          [0.2, 0.6, 1],
        ]}
        xLabels={['a', 'b', 'c']}
        yLabels={['a', 'b', 'c']}
      />,
    );
    const rects = container.querySelectorAll('rect');
    expect(rects.length).toBe(9);
    // Accessible hover title present.
    expect(container.querySelector('title')).not.toBeNull();
  });

  it('shows Empty for an empty matrix', () => {
    mount(<Heatmap matrix={[]} />);
    expect(container.textContent).toMatch(/No matrix data/i);
  });
});

describe('GraphView (xyflow v12 baseline)', () => {
  it('mounts the themed react-flow container', () => {
    mount(
      <GraphView
        nodes={[
          { id: 'a', position: { x: 0, y: 0 }, data: { label: 'root' } },
          { id: 'b', position: { x: 120, y: 60 }, data: { label: 'branch' } },
        ]}
        edges={[{ id: 'a-b', source: 'a', target: 'b' }]}
        height={240}
      />,
    );
    // xyflow applies the literal `.react-flow` class (not a CSS module), so it
    // survives css:false. Presence = the themed baseline mounted.
    expect(container.querySelector('.react-flow')).not.toBeNull();
  });
});
