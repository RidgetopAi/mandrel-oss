/**
 * Primitive render/markup tests (P0.3). Uses renderToStaticMarkup (the repo's
 * established no-@testing-library pattern) to assert semantic element, ARIA,
 * variant-driven structure and text — the behaviour that must hold regardless of
 * the (browser-verified) visual treatment. Under vitest `css:false`, CSS-Module
 * class names resolve to `undefined`, so these assert on DOM/roles/text, not
 * class names.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import {
  Text,
  Heading,
  Label,
  Code,
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Badge,
  StatusPill,
  Alert,
  Empty,
  Spinner,
  Skeleton,
  Tooltip,
  StatTile,
  Tabs,
  Stack,
  Grid,
  Divider,
} from './index';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('Text / Typography', () => {
  it('renders as a span by default and honors `as`', () => {
    expect(html(<Text>hello</Text>)).toMatch(/^<span[^>]*>hello<\/span>$/);
    expect(html(<Text as="p">para</Text>)).toMatch(/^<p[^>]*>para<\/p>$/);
  });

  it('Heading maps level → tag (display for h1-2, title for h3+)', () => {
    expect(html(<Heading level={1}>Big</Heading>)).toMatch(/^<h1[^>]*>Big<\/h1>$/);
    expect(html(<Heading level={4}>Small</Heading>)).toMatch(/^<h4[^>]*>Small<\/h4>$/);
  });

  it('Label + Code render their semantic elements', () => {
    expect(html(<Label>lbl</Label>)).toMatch(/<span/);
    expect(html(<Code>id</Code>)).toMatch(/^<code[^>]*>id<\/code>$/);
  });

  it('passes through arbitrary DOM props (title)', () => {
    expect(html(<Text title="tip">x</Text>)).toContain('title="tip"');
  });
});

describe('Button', () => {
  it('defaults to type=button and renders its label', () => {
    const out = html(<Button>Save</Button>);
    expect(out).toContain('type="button"');
    expect(out).toContain('Save');
  });

  it('loading → disabled + aria-busy, hides no label from DOM', () => {
    const out = html(<Button loading>Saving</Button>);
    expect(out).toContain('disabled');
    expect(out).toContain('aria-busy="true"');
  });

  it('disabled renders the disabled attribute', () => {
    expect(html(<Button disabled>x</Button>)).toContain('disabled');
  });

  it('renders left and right icon slots', () => {
    const out = html(
      <Button iconLeft={<i data-testid="l" />} iconRight={<i data-testid="r" />}>
        go
      </Button>,
    );
    expect(out).toContain('data-testid="l"');
    expect(out).toContain('data-testid="r"');
  });
});

describe('Card', () => {
  it('renders children and header/body/footer sections', () => {
    const out = html(
      <Card flush>
        <CardHeader>H</CardHeader>
        <CardBody>B</CardBody>
        <CardFooter>F</CardFooter>
      </Card>,
    );
    expect(out).toContain('H');
    expect(out).toContain('B');
    expect(out).toContain('F');
  });
});

describe('Badge', () => {
  it('renders content; dot adds a decorative span', () => {
    expect(html(<Badge variant="teal">handoff</Badge>)).toContain('handoff');
    const withDot = html(
      <Badge variant="green" dot>
        ok
      </Badge>,
    );
    expect(withDot).toContain('aria-hidden="true"');
  });
});

describe('StatusPill', () => {
  it('active renders a dot; ended never renders a dot', () => {
    expect(html(<StatusPill tone="active">active</StatusPill>)).toContain('aria-hidden="true"');
    const ended = html(<StatusPill tone="ended">ended</StatusPill>);
    expect(ended).toContain('ended');
    expect(ended).not.toContain('aria-hidden="true"');
  });
});

describe('Alert', () => {
  it('error/warning are role=alert; info/success are role=status', () => {
    expect(html(<Alert variant="error">e</Alert>)).toContain('role="alert"');
    expect(html(<Alert variant="warning">w</Alert>)).toContain('role="alert"');
    expect(html(<Alert variant="info">i</Alert>)).toContain('role="status"');
    expect(html(<Alert variant="success">s</Alert>)).toContain('role="status"');
  });

  it('renders a title and a dismiss button when onClose is given', () => {
    const out = html(
      <Alert variant="info" title="Heads up" onClose={() => undefined}>
        body
      </Alert>,
    );
    expect(out).toContain('Heads up');
    expect(out).toContain('aria-label="Dismiss"');
  });

  it('no onClose → no dismiss control', () => {
    expect(html(<Alert variant="info">x</Alert>)).not.toContain('aria-label="Dismiss"');
  });
});

describe('Empty', () => {
  it('renders title, description and action slot', () => {
    const out = html(
      <Empty title="Nothing" description="desc" action={<button>act</button>} />,
    );
    expect(out).toContain('Nothing');
    expect(out).toContain('desc');
    expect(out).toContain('act');
  });
});

describe('Spinner / Skeleton', () => {
  it('Spinner exposes role=status + an sr-only label', () => {
    const out = html(<Spinner label="Loading data" />);
    expect(out).toContain('role="status"');
    expect(out).toContain('Loading data');
  });

  it('Skeleton is aria-hidden and applies width/height inline', () => {
    const out = html(<Skeleton shape="circle" width={40} height={40} />);
    expect(out).toContain('aria-hidden="true"');
    expect(out).toMatch(/width:\s*40px/);
    expect(out).toMatch(/height:\s*40px/);
  });
});

describe('Tooltip', () => {
  it('renders role=tooltip with the label and links it to the trigger', () => {
    const out = html(
      <Tooltip label="the tip">
        <button>trigger</button>
      </Tooltip>,
    );
    expect(out).toContain('role="tooltip"');
    expect(out).toContain('the tip');
    // aria-describedby on the trigger references the tooltip id
    const describedBy = out.match(/aria-describedby="([^"]+)"/);
    const tooltipId = out.match(/role="tooltip" id="([^"]+)"/);
    expect(describedBy).toBeTruthy();
    expect(tooltipId).toBeTruthy();
    expect(describedBy?.[1]).toBe(tooltipId?.[1]);
  });
});

describe('StatTile', () => {
  it('renders label + value; delta renders a trend chip', () => {
    const out = html(
      <StatTile label="Contexts" value="990" delta="+18%" trend="up" caption="30d" />,
    );
    expect(out).toContain('Contexts');
    expect(out).toContain('990');
    expect(out).toContain('+18%');
    expect(out).toContain('30d');
  });

  it('no delta → no trend chip glyph', () => {
    const out = html(<StatTile label="X" value="1" />);
    expect(out).not.toContain('↑');
    expect(out).not.toContain('↓');
  });
});

describe('Tabs (static ARIA)', () => {
  const items = [
    { key: 'a', label: 'A', content: <span>PanelA</span> },
    { key: 'b', label: 'B', content: <span>PanelB</span> },
  ];

  it('exposes a tablist with tabs and a single active panel', () => {
    const out = html(<Tabs items={items} aria-label="demo" />);
    expect(out).toContain('role="tablist"');
    expect(out).toContain('aria-label="demo"');
    expect((out.match(/role="tab"/g) ?? []).length).toBe(2);
    expect(out).toContain('role="tabpanel"');
  });

  it('defaultActiveKey selects that tab + panel', () => {
    const out = html(<Tabs items={items} defaultActiveKey="b" />);
    expect(out).toMatch(/id="tab-b"[^>]*aria-selected="true"/);
    expect(out).toContain('PanelB');
    expect(out).not.toContain('PanelA');
  });

  it('controlled activeKey wins', () => {
    const out = html(<Tabs items={items} activeKey="a" />);
    expect(out).toMatch(/id="tab-a"[^>]*aria-selected="true"/);
    expect(out).toContain('PanelA');
  });
});

describe('Layout', () => {
  it('Stack renders children and a flex-direction + token gap style', () => {
    const out = html(
      <Stack direction="row" gap={6}>
        <span>one</span>
        <span>two</span>
      </Stack>,
    );
    expect(out).toContain('one');
    expect(out).toContain('two');
    expect(out).toMatch(/flex-direction:\s*row/);
    expect(out).toContain('var(--sp-6)');
  });

  it('Grid renders a grid-template-columns for a fixed column count', () => {
    const out = html(
      <Grid columns={3} gap={4}>
        <span>c</span>
      </Grid>,
    );
    expect(out).toMatch(/repeat\(3, minmax\(0, 1fr\)\)/);
    expect(out).toContain('var(--sp-4)');
  });

  it('Grid auto-fill uses minColumnWidth', () => {
    const out = html(<Grid minColumnWidth="160px">x</Grid>);
    expect(out).toContain('auto-fill');
    expect(out).toContain('160px');
  });

  it('Divider is a separator; vertical sets orientation; label renders text', () => {
    expect(html(<Divider />)).toContain('role="separator"');
    expect(html(<Divider orientation="vertical" />)).toContain('aria-orientation="vertical"');
    expect(html(<Divider label="Section" />)).toContain('Section');
  });
});
