import React, { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  type Node,
  type Edge,
  type ReactFlowProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useChartTheme, type ChartTheme, type ThemeName } from './chartTheme';

/**
 * GraphView (P0.6) — the THEMED @xyflow/react v12 baseline that Surveyor (already
 * v12) and TreeWalker build their node-graph screens on. This establishes the
 * token-driven node/edge/background language ONCE; the full graph screens are
 * their own phases.
 *
 * Theming: xyflow v12 reads CSS variables (`--xy-*`) for its chrome and honours a
 * `colorMode` prop. We set `colorMode` from the active theme AND push resolved
 * token hexes into the xyflow CSS vars via a wrapper style, so nodes/edges/
 * controls all match the design tokens with no hardcoded colour.
 */

/** Resolved token hex → the xyflow CSS-variable surface (v12). */
export function xyflowCssVars(ct: ChartTheme): React.CSSProperties {
  return {
    // Documented xyflow v12 theming variables.
    ['--xy-background-color' as string]: ct.surface.bg,
    ['--xy-node-background-color' as string]: ct.surface.s2,
    ['--xy-node-border-default' as string]: `1px solid ${ct.line}`,
    ['--xy-node-color' as string]: ct.text,
    ['--xy-node-boxshadow-hover' as string]: `0 0 0 1px ${ct.accent}`,
    ['--xy-node-boxshadow-selected' as string]: `0 0 0 1px ${ct.accent}`,
    ['--xy-edge-stroke-default' as string]: ct.line,
    ['--xy-edge-stroke-selected' as string]: ct.accent,
    ['--xy-connectionline-stroke-default' as string]: ct.accent,
    ['--xy-controls-button-background-color-default' as string]: ct.surface.s2,
    ['--xy-controls-button-background-color-hover-default' as string]: ct.surface.s3,
    ['--xy-controls-button-color-default' as string]: ct.textMuted,
    ['--xy-controls-button-border-color-default' as string]: ct.line,
    ['--xy-attribution-background-color-default' as string]: 'transparent',
  };
}

/** Reusable themed node style (token-sourced) for callers building graph screens. */
export function themedNodeStyle(ct: ChartTheme, accent?: string): React.CSSProperties {
  return {
    background: ct.surface.s2,
    color: ct.text,
    border: `1px solid ${accent ?? ct.line}`,
    borderRadius: 10,
    padding: '8px 12px',
    fontSize: 12,
    fontWeight: 600,
  };
}

export interface GraphViewProps extends Omit<ReactFlowProps, 'colorMode' | 'height' | 'width'> {
  nodes: Node[];
  edges: Edge[];
  theme?: ThemeName;
  height?: number | string;
  /** Show the zoom/fit controls. */
  showControls?: boolean;
  /** Dotted background grid. */
  showBackground?: boolean;
}

export const GraphView: React.FC<GraphViewProps> = ({
  nodes,
  edges,
  theme,
  height = 360,
  showControls = true,
  showBackground = true,
  fitView = true,
  ...rest
}) => {
  const ct = useChartTheme(theme);
  const wrapStyle = useMemo(
    () => ({
      height,
      width: '100%',
      background: ct.surface.bg,
      border: `1px solid ${ct.line}`,
      borderRadius: 12,
      ...xyflowCssVars(ct),
    }),
    [ct, height],
  );

  return (
    <div style={wrapStyle}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        colorMode={ct.theme}
        fitView={fitView}
        proOptions={{ hideAttribution: true }}
        {...rest}
      >
        {showBackground && (
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color={ct.grid} />
        )}
        {showControls && <Controls showInteractive={false} />}
      </ReactFlow>
    </div>
  );
};

export default GraphView;
