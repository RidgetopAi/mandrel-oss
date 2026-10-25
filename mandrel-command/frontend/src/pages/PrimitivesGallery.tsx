import React from 'react';
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
  Field,
  Form,
  FormActions,
  Input,
  Textarea,
  NumberInput,
  Checkbox,
  Switch,
  Radio,
  RadioGroup,
  Select,
  ProjectSelect,
  Modal,
  Drawer,
  DataTable,
  type Column,
  type SortState,
} from '../components/ui';
import {
  AreaChartCard,
  LineChartCard,
  BarChartCard,
  PieChartCard,
  Sparkline,
  GraphView,
  Heatmap,
  type ThemeName,
} from '../components/charts';
import { tokenStyleVars } from '../styles/tokens';

/**
 * Primitives gallery (P0.3 verification surface). Renders EVERY primitive in all
 * variants/states on the token ground. Reachable in dev at `/dev/ui` (a public,
 * standalone route — no auth, out of the app nav). This is how the design
 * language is visually verified against command-design-language.html.
 */

// ── tiny inline icons (token stroke=currentColor) — slots for the primitives ──
const Ic = ({ d }: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);
const IconPlus = () => <Ic d="M12 5v14M5 12h14" />;
const IconSearch = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.2-3.2" />
  </svg>
);
const IconInbox = () => (
  <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 13l2.5-8h11L20 13M4 13v6h16v-6M4 13h5l1 2h4l1-2h5" />
  </svg>
);
const IconInfo = () => <Ic d="M12 8v0M12 11v5" />;

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section style={{ marginTop: 'var(--sp-8)' }}>
    <Divider label={title} />
    <div style={{ marginTop: 'var(--sp-4)' }}>{children}</div>
  </section>
);

const Row: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Stack direction="row" gap={3} wrap align="center">
    {children}
  </Stack>
);

interface DemoRow {
  id: string;
  name: string;
  type: string;
  tokens: number;
}
const demoRows: DemoRow[] = [
  { id: 'c1', name: 'Sessions foundation', type: 'milestone', tokens: 118000 },
  { id: 'c2', name: 'requireActor flip', type: 'completion', tokens: 42100 },
  { id: 'c3', name: 'Tree drift validator', type: 'decision', tokens: 9800 },
  { id: 'c4', name: 'Ink-on-accent tokens', type: 'code', tokens: 3200 },
];

// ── chart sample data (static/representative) ───────────────────────────────
const trendData = [
  { day: 'W1', value: 42 },
  { day: 'W2', value: 55 },
  { day: 'W3', value: 48 },
  { day: 'W4', value: 71 },
  { day: 'W5', value: 66 },
  { day: 'W6', value: 90 },
];
const actorTrend = [
  { t: 'Mon', coordinator: 32, tick: 12, operator: 4 },
  { t: 'Tue', coordinator: 41, tick: 18, operator: 6 },
  { t: 'Wed', coordinator: 38, tick: 22, operator: 3 },
  { t: 'Thu', coordinator: 52, tick: 19, operator: 8 },
  { t: 'Fri', coordinator: 47, tick: 25, operator: 5 },
];
const actorBars = [
  { actor: 'coordinator', ctx: 146 },
  { actor: 'tick', ctx: 51 },
  { actor: 'operator', ctx: 17 },
  { actor: 'assistant', ctx: 9 },
];
const statusPie = [
  { name: 'completed', value: 62 },
  { name: 'in progress', value: 28 },
  { name: 'todo', value: 34 },
  { name: 'blocked', value: 6 },
];
const graphNodes = [
  { id: 'root', position: { x: 20, y: 90 }, data: { label: 'canonical' } },
  { id: 'runtime', position: { x: 200, y: 30 }, data: { label: 'runtime' } },
  { id: 'depts', position: { x: 200, y: 150 }, data: { label: 'departments' } },
  { id: 'tick', position: { x: 380, y: 30 }, data: { label: 'tick' } },
];
const graphEdges = [
  { id: 'e1', source: 'root', target: 'runtime' },
  { id: 'e2', source: 'root', target: 'depts' },
  { id: 'e3', source: 'runtime', target: 'tick' },
];
// A small symmetric similarity matrix (diagonal = 1).
const simMatrix = [
  [1.0, 0.82, 0.41, 0.19, 0.55],
  [0.82, 1.0, 0.38, 0.22, 0.6],
  [0.41, 0.38, 1.0, 0.71, 0.33],
  [0.19, 0.22, 0.71, 1.0, 0.29],
  [0.55, 0.6, 0.33, 0.29, 1.0],
];
const simLabels = ['ctx-a', 'ctx-b', 'ctx-c', 'ctx-d', 'ctx-e'];

/**
 * All chart primitives rendered for ONE explicit theme. Wrapped by the gallery in
 * a self-contained token island (tokenStyleVars) so a dark and a light copy can
 * sit side-by-side on the same page for theming verification.
 */
const ChartsShowcase: React.FC<{ theme: ThemeName }> = ({ theme }) => (
  <Stack gap={4}>
    <AreaChartCard
      theme={theme}
      data={trendData}
      xKey="day" /* non-date-axis: design-gallery fixture; trendData.day is "W1".."W6", week labels, not calendar days */
      caption="Contexts / week · 6w"
      value="+18%"
      valueTone="up"
      height={150}
    />
    <Grid columns={2} gap={4}>
      <LineChartCard
        theme={theme}
        title="Tokens by actor"
        data={actorTrend}
        xKey="t" /* non-date-axis: design-gallery fixture; actorTrend.t is "Mon".."Fri", weekday names, not calendar days */
        series={[{ key: 'coordinator' }, { key: 'tick' }, { key: 'operator' }]}
        height={180}
      />
      <PieChartCard theme={theme} title="Task mix" data={statusPie} height={180} />
    </Grid>
    <BarChartCard
      theme={theme}
      title="Contexts by actor"
      data={actorBars}
      xKey="actor" /* non-date-axis: actor names, a category axis */
      series={[{ key: 'ctx', name: 'Contexts' }]}
      layout="vertical"
      height={160}
    />
    <Grid columns={3} gap={4}>
      <Card>
        <StatTile label="Contexts" value="990" delta="+18%" trend="up" />
        <Sparkline theme={theme} data={trendData} height={36} />
      </Card>
      <Card>
        <StatTile label="Open tasks" value="126" delta="-4" trend="down" />
        <Sparkline theme={theme} tone="rose" data={[...trendData].reverse()} height={36} />
      </Card>
      <Card>
        <StatTile label="Sessions" value="2" />
        <Sparkline theme={theme} tone="violet" data={trendData} height={36} />
      </Card>
    </Grid>
    <div>
      <Text variant="label" tone="faint">Graph baseline (xyflow v12)</Text>
      <div style={{ marginTop: 'var(--sp-2)' }}>
        <GraphView theme={theme} nodes={graphNodes} edges={graphEdges} height={220} />
      </div>
    </div>
    <div>
      <Text variant="label" tone="faint">Similarity heatmap (dependency-free SVG)</Text>
      <Card style={{ marginTop: 'var(--sp-2)' }}>
        <Heatmap theme={theme} matrix={simMatrix} xLabels={simLabels} yLabels={simLabels} />
      </Card>
    </div>
    <AreaChartCard
      theme={theme}
      data={[]}
      xKey="day" /* non-date-axis: design-gallery fixture; trendData.day is "W1".."W6", week labels, not calendar days */
      caption="Empty state"
      height={110}
    />
    <AreaChartCard
      theme={theme}
      data={trendData}
      xKey="day" /* non-date-axis: design-gallery fixture; trendData.day is "W1".."W6", week labels, not calendar days */
      caption="Loading state"
      height={110}
      loading
    />
  </Stack>
);

/** A self-contained theme island: descendants resolve var(--…) to `theme`. */
const ThemeIsland: React.FC<{ theme: ThemeName; children: React.ReactNode }> = ({
  theme,
  children,
}) => (
  <div
    style={{
      ...tokenStyleVars(theme),
      background: 'var(--bg)',
      color: 'var(--tx)',
      border: '1px solid var(--line)',
      borderRadius: 'var(--r)',
      padding: 'var(--sp-4)',
    }}
  >
    <div
      style={{
        fontSize: 'var(--fs-label)',
        fontWeight: 'var(--fw-label)' as unknown as number,
        letterSpacing: 'var(--tracking-label)',
        textTransform: 'uppercase',
        color: 'var(--tx-3)',
        marginBottom: 'var(--sp-3)',
      }}
    >
      {theme}
    </div>
    {children}
  </div>
);

const PrimitivesGallery: React.FC = () => {
  const [theme, setTheme] = React.useState<'dark' | 'light'>('dark');
  const [loading, setLoading] = React.useState(false);
  const [tab, setTab] = React.useState('overview');

  // PASS 2 interactive state
  const [selectValue, setSelectValue] = React.useState<string | undefined>('completion');
  // ProjectSelect gallery state. The list is INLINE fixture data on purpose: the gallery
  // is a standalone unauthenticated route (/dev/ui) with no ProjectProvider, so it must
  // not reach for real projects. On a real page these props come from
  // `usePageProject().selectProps` — never hand-assembled.
  const galleryProjects = React.useMemo(
    () => [
      // Product-neutral fixture names on purpose. This gallery is BUILT AND SHIPPED to
      // every tenant, so real project names out of our own Mandrel are company branding
      // in a customer's bundle — the exact class the internal-refs ban (scripts/oss-gate.sh STAGE R)
      // exists to stop, and what it caught here on 2026-08-08.
      { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'demo-alpha' },
      { id: 'bbbbbbbb-2222-4222-8222-222222222222', name: 'demo-beta' },
      { id: 'cccccccc-3333-4333-8333-333333333333', name: 'demo-gamma' },
    ],
    [],
  );
  const [galleryProjectId, setGalleryProjectId] = React.useState<string | undefined>(
    'aaaaaaaa-1111-4111-8111-111111111111',
  );
  const [galleryAllProjectId, setGalleryAllProjectId] = React.useState<string | undefined>('all');
  const [radioValue, setRadioValue] = React.useState('second');
  const [modalOpen, setModalOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [tableLoading, setTableLoading] = React.useState(false);
  const [sort, setSort] = React.useState<SortState | null>({ key: 'tokens', direction: 'desc' });
  const [selectedRows, setSelectedRows] = React.useState<string[]>([]);

  const sortedRows = React.useMemo(() => {
    if (!sort) return demoRows;
    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...demoRows].sort((a, b) => {
      const av = a[sort.key as keyof DemoRow];
      const bv = b[sort.key as keyof DemoRow];
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
  }, [sort]);

  const tableColumns: Column<DemoRow>[] = [
    { key: 'name', header: 'Name', sortable: true },
    { key: 'type', header: 'Type', sortable: true },
    {
      key: 'tokens',
      header: 'Tokens',
      sortable: true,
      align: 'right',
      render: (r) => <Code tone="teal">{r.tokens.toLocaleString()}</Code>,
    },
  ];

  React.useEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', theme);
    return () => {
      if (prev) root.setAttribute('data-theme', prev);
      else root.removeAttribute('data-theme');
    };
  }, [theme]);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--tx)',
        fontFamily: 'var(--font)',
        padding: 'var(--sp-8)',
      }}
    >
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        <Stack direction="row" justify="between" align="center">
          <div>
            <Heading level={1} variant="display">
              Command — primitive library
            </Heading>
            <Text tone="faint" variant="body">
              P0.3 PASS 1 + PASS 2 · token-driven · CSS Modules · dark-first
            </Text>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          >
            Theme: {theme}
          </Button>
        </Stack>

        {/* Typography */}
        <Section title="Typography">
          <Stack gap={3}>
            <Text variant="display">Display — sessions, whole and un-scattered</Text>
            <Text variant="title">Title — requireActor flip complete</Text>
            <Text variant="body">
              Body — comfortable reading measure, generous leading for superb
              readability up front.
            </Text>
            <Label tone="faint">Label — memory &amp; work</Label>
            <Code tone="teal">Data — 0b7cf00d · 990 ctx · 118k tok</Code>
            <Divider />
            <Row>
              <Text tone="default">default</Text>
              <Text tone="muted">muted</Text>
              <Text tone="faint">faint</Text>
              <Text tone="faintest">faintest</Text>
              <Text tone="teal">teal</Text>
              <Text tone="violet">violet</Text>
              <Text tone="blue">blue</Text>
              <Text tone="green">green</Text>
              <Text tone="amber">amber</Text>
              <Text tone="rose">rose</Text>
            </Row>
          </Stack>
        </Section>

        {/* Buttons */}
        <Section title="Buttons">
          <Stack gap={4}>
            <Row>
              <Button variant="primary">Store context</Button>
              <Button variant="ghost">Cancel</Button>
              <Button variant="subtle">Dismiss</Button>
              <Button variant="danger">Delete</Button>
            </Row>
            <Row>
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg">Large</Button>
            </Row>
            <Row>
              <Button iconLeft={<IconPlus />}>New task</Button>
              <Button variant="ghost" iconRight={<IconSearch />}>
                Search
              </Button>
              <Button variant="ghost" iconLeft={<IconSearch />} aria-label="Search only" />
              <Button loading>Saving</Button>
              <Button disabled>Disabled</Button>
              <Button
                loading={loading}
                onClick={() => {
                  setLoading(true);
                  setTimeout(() => setLoading(false), 1500);
                }}
              >
                Click → load
              </Button>
            </Row>
            <div style={{ maxWidth: 320 }}>
              <Button fullWidth variant="primary">
                Full width
              </Button>
            </div>
          </Stack>
        </Section>

        {/* Cards */}
        <Section title="Cards & panels">
          <Grid columns={3} gap={4}>
            <Card>
              <Text variant="title">Surface 1 panel</Text>
              <Text tone="muted" variant="body">
                Default panel — var(--s1), hairline border, radius.
              </Text>
            </Card>
            <Card surface="s2" interactive tabIndex={0}>
              <Text variant="title">Interactive (s2)</Text>
              <Text tone="muted" variant="body">
                Hover / focus me — raised surface.
              </Text>
            </Card>
            <Card flush>
              <CardHeader>
                <Text variant="title">Composed card</Text>
              </CardHeader>
              <CardBody>
                <Text tone="muted" variant="body">
                  Header / body / footer sections.
                </Text>
              </CardBody>
              <CardFooter>
                <Button size="sm" variant="ghost">
                  Action
                </Button>
              </CardFooter>
            </Card>
          </Grid>
        </Section>

        {/* Badges + status */}
        <Section title="Badges, tags & status">
          <Stack gap={4}>
            <Row>
              <Badge variant="teal" mono>handoff</Badge>
              <Badge variant="violet" mono>milestone</Badge>
              <Badge variant="green" mono>completion</Badge>
              <Badge variant="blue" mono>decision</Badge>
              <Badge variant="neutral" mono>note</Badge>
            </Row>
            <Row>
              <Badge variant="teal" pill dot>teal</Badge>
              <Badge variant="violet" pill dot>violet</Badge>
              <Badge variant="blue" pill dot>blue</Badge>
              <Badge variant="green" pill dot>green</Badge>
              <Badge variant="amber" pill dot>amber</Badge>
              <Badge variant="rose" pill dot>rose</Badge>
            </Row>
            <Row>
              <StatusPill tone="active">active</StatusPill>
              <StatusPill tone="dormant">dormant</StatusPill>
              <StatusPill tone="ended">ended</StatusPill>
              <StatusPill tone="alert">alert</StatusPill>
            </Row>
          </Stack>
        </Section>

        {/* Alerts */}
        <Section title="Alerts & callouts">
          <Stack gap={3}>
            <Alert variant="info" title="Heads up" icon={<IconInfo />}>
              Informational callout on the blue accent.
            </Alert>
            <Alert variant="success" title="Deployed" icon={<IconInfo />}>
              The fleet rolled out cleanly — all tenants green.
            </Alert>
            <Alert variant="warning" title="Dormant session" onClose={() => undefined}>
              This session has been idle for a while.
            </Alert>
            <Alert variant="error" title="Write rejected" onClose={() => undefined}>
              Header-less write rejected — missing X-Actor-ID.
            </Alert>
          </Stack>
        </Section>

        {/* Stat tiles */}
        <Section title="Stat tiles">
          <Grid columns={4} gap={4}>
            <StatTile label="Contexts" value="990" delta="+18%" trend="up" caption="vs last 30d" />
            <StatTile label="Open tasks" value="126" delta="-4" trend="down" caption="this week" />
            <StatTile label="Sessions" value="2" delta="0" trend="flat" caption="active now" />
            <StatTile label="Tokens" value="118k" icon={<IconInfo />} />
          </Grid>
        </Section>

        {/* Tabs */}
        <Section title="Tabs">
          <Tabs
            aria-label="Demo tabs (controlled)"
            activeKey={tab}
            onChange={setTab}
            items={[
              {
                key: 'overview',
                label: 'Overview',
                content: <Text tone="muted">Controlled tab — state lives in the gallery.</Text>,
              },
              {
                key: 'activity',
                label: 'Activity',
                content: <Text tone="muted">Second panel content.</Text>,
              },
              {
                key: 'settings',
                label: 'Settings',
                content: <Text tone="muted">Third panel content.</Text>,
              },
              { key: 'disabled', label: 'Disabled', content: null, disabled: true },
            ]}
          />
          <div style={{ marginTop: 'var(--sp-4)' }}>
            <Tabs
              aria-label="Demo tabs (uncontrolled)"
              defaultActiveKey="b"
              items={[
                { key: 'a', label: 'Uncontrolled A', content: <Text tone="muted">Panel A</Text> },
                { key: 'b', label: 'Starts here (B)', content: <Text tone="muted">Panel B</Text> },
                { key: 'c', label: 'Panel C', content: <Text tone="muted">Panel C</Text> },
              ]}
            />
          </div>
        </Section>

        {/* Loading */}
        <Section title="Spinner & skeleton">
          <Stack gap={4}>
            <Row>
              <Spinner size="sm" />
              <Spinner size="md" />
              <Spinner size="lg" />
              <Spinner size="md" tone="muted" />
            </Row>
            <Card>
              <Stack gap={3}>
                <Skeleton shape="line" width="40%" />
                <Skeleton shape="line" width="80%" />
                <Skeleton shape="line" width="65%" />
                <Stack direction="row" gap={3} align="center">
                  <Skeleton shape="circle" width={40} height={40} />
                  <Skeleton shape="block" width={160} height={40} />
                </Stack>
              </Stack>
            </Card>
          </Stack>
        </Section>

        {/* Tooltip */}
        <Section title="Tooltip">
          <Row>
            <Tooltip label="Tooltip on top" placement="top">
              <Button variant="ghost" size="sm">Top</Button>
            </Tooltip>
            <Tooltip label="Tooltip on bottom" placement="bottom">
              <Button variant="ghost" size="sm">Bottom</Button>
            </Tooltip>
            <Tooltip label="Tooltip on the left" placement="left">
              <Button variant="ghost" size="sm">Left</Button>
            </Tooltip>
            <Tooltip label="Tooltip on the right side" placement="right">
              <Button variant="ghost" size="sm">Right</Button>
            </Tooltip>
          </Row>
        </Section>

        {/* Empty */}
        <Section title="Empty state">
          <Card>
            <Empty
              icon={<IconInbox />}
              title="No contexts yet"
              description="Store your first memory to see it here — full width, rendered, front and center."
              action={<Button variant="primary" iconLeft={<IconPlus />}>Store context</Button>}
            />
          </Card>
        </Section>

        {/* Layout */}
        <Section title="Layout primitives">
          <Stack gap={4}>
            <Text variant="label" tone="faint">Stack (row, gap 2 → 8)</Text>
            {([2, 4, 6, 8] as const).map((g) => (
              <Stack key={g} direction="row" gap={g}>
                <Card style={{ padding: 'var(--sp-3)' }}>A</Card>
                <Card style={{ padding: 'var(--sp-3)' }}>B</Card>
                <Card style={{ padding: 'var(--sp-3)' }}>C</Card>
              </Stack>
            ))}
            <Text variant="label" tone="faint">Grid (auto-fill, min 160px)</Text>
            <Grid minColumnWidth="160px" gap={3}>
              {Array.from({ length: 5 }).map((_, i) => (
                <Card key={i} style={{ padding: 'var(--sp-3)' }}>
                  <Text tone="muted">Cell {i + 1}</Text>
                </Card>
              ))}
            </Grid>
            <Text variant="label" tone="faint">Divider (with + without label)</Text>
            <Divider />
            <Divider label="Section rule" />
            <Stack direction="row" gap={3} align="center">
              <Text tone="muted">left</Text>
              <Divider orientation="vertical" />
              <Text tone="muted">right</Text>
            </Stack>
          </Stack>
        </Section>

        {/* ── PASS 2 — interactive / overlay set ─────────────────────────── */}

        {/* Form + inputs */}
        <Section title="Form controls & fields">
          <Grid columns={2} gap={6}>
            <Form onSubmit={(e) => e.preventDefault()}>
              <Field label="Title" hint="A short, human name for the context">
                <Input placeholder="e.g. Sessions foundation" />
              </Field>
              <Field label="Context id" hint="Mono for ids & tokens">
                <Input mono placeholder="0b7cf00d" />
              </Field>
              <Field label="Summary">
                <Textarea placeholder="What happened, and why it matters…" />
              </Field>
              <Field label="Token budget">
                <NumberInput defaultValue={8} min={0} max={64} step={4} />
              </Field>
              <Field label="Type" error="Please choose a context type" required>
                <Select
                  options={[
                    { value: 'code', label: 'Code' },
                    { value: 'decision', label: 'Decision' },
                    { value: 'completion', label: 'Completion' },
                    { value: 'milestone', label: 'Milestone' },
                    { value: 'handoff', label: 'Handoff' },
                    { value: 'legacy', label: 'Legacy (disabled)', disabled: true },
                  ]}
                  value={selectValue}
                  onChange={setSelectValue}
                  aria-label="Context type"
                />
              </Field>
              <FormActions>
                <Button variant="subtle" type="button">
                  Cancel
                </Button>
                <Button variant="primary" type="submit">
                  Store context
                </Button>
              </FormActions>
            </Form>

            <Stack gap={5}>
              <div>
                <Text variant="label" tone="faint">Toggles</Text>
                <Stack gap={3} style={{ marginTop: 'var(--sp-3)' }}>
                  <Checkbox defaultChecked>Auto-thread to current task</Checkbox>
                  <Checkbox>Pin to project overview</Checkbox>
                  <Checkbox indeterminate>Partial selection</Checkbox>
                  <Checkbox disabled>Disabled option</Checkbox>
                  <Switch defaultChecked>Notify on chat</Switch>
                  <Switch>Shadow mode</Switch>
                  <Switch disabled>Disabled switch</Switch>
                </Stack>
              </div>
              <div>
                <Text variant="label" tone="faint">Radio group</Text>
                <div style={{ marginTop: 'var(--sp-3)' }}>
                  <RadioGroup
                    aria-label="Risk rung"
                    value={radioValue}
                    onChange={setRadioValue}
                  >
                    <Radio value="first">FREE — act, self-checks catch it</Radio>
                    <Radio value="second">NOTIFY — act, tell the operator after</Radio>
                    <Radio value="third">GATE — the operator approves first</Radio>
                    <Radio value="fourth" disabled>DISABLE — the operator does it</Radio>
                  </RadioGroup>
                </div>
              </div>
              <div>
                <Text variant="label" tone="faint">
                  ProjectSelect — THE project selector (pair with usePageProject)
                </Text>
                <Stack gap={3} style={{ marginTop: 'var(--sp-3)' }}>
                  <ProjectSelect
                    projects={galleryProjects}
                    value={galleryProjectId}
                    onChange={setGalleryProjectId}
                    aria-label="Project (gallery)"
                  />
                  <ProjectSelect
                    projects={galleryProjects}
                    value={galleryAllProjectId}
                    onChange={setGalleryAllProjectId}
                    allowAll
                    aria-label="Project with All projects (gallery)"
                  />
                  <ProjectSelect
                    projects={galleryProjects}
                    value={undefined}
                    onChange={() => undefined}
                    loading
                    aria-label="Project loading (gallery)"
                  />
                  <ProjectSelect
                    projects={[]}
                    value={undefined}
                    onChange={() => undefined}
                    aria-label="Project empty (gallery)"
                  />
                </Stack>
              </div>
              <div>
                <Text variant="label" tone="faint">Inline select + invalid input</Text>
                <Stack gap={3} style={{ marginTop: 'var(--sp-3)' }}>
                  <Select
                    options={[
                      { value: 'project-alpha', label: 'project-alpha' },
                      { value: 'project-beta', label: 'project-beta' },
                      { value: 'project-gamma', label: 'project-gamma' },
                    ]}
                    defaultValue="project-alpha"
                    aria-label="Project"
                  />
                  <Input invalid placeholder="Invalid input state" defaultValue="not-a-valid-value" />
                </Stack>
              </div>
            </Stack>
          </Grid>
        </Section>

        {/* Overlays */}
        <Section title="Overlays — Modal & Drawer">
          <Row>
            <Button variant="primary" onClick={() => setModalOpen(true)}>
              Open modal
            </Button>
            <Button variant="ghost" onClick={() => setDrawerOpen(true)}>
              Open drawer
            </Button>
          </Row>
          <Modal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            title="Delete context?"
            footer={
              <>
                <Button variant="subtle" onClick={() => setModalOpen(false)}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={() => setModalOpen(false)}>
                  Delete
                </Button>
              </>
            }
          >
            <Text variant="body">
              This permanently removes the context from the project. Focus is
              trapped in this dialog — Tab cycles within, Esc closes, and focus
              returns to the button that opened it.
            </Text>
          </Modal>
          <Drawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            title="Context detail"
            footer={
              <Button variant="primary" onClick={() => setDrawerOpen(false)}>
                Done
              </Button>
            }
          >
            <Stack gap={4}>
              <Field label="Title">
                <Input defaultValue="Sessions foundation" />
              </Field>
              <Field label="Notes">
                <Textarea defaultValue="Edit panel sliding from the right edge." />
              </Field>
            </Stack>
          </Drawer>
        </Section>

        {/* DataTable */}
        <Section title="DataTable">
          <Stack gap={4}>
            <Row>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setTableLoading(true);
                  setTimeout(() => setTableLoading(false), 1400);
                }}
              >
                Simulate loading
              </Button>
              <Text tone="faint" variant="label">
                Selected: {selectedRows.length}
              </Text>
            </Row>
            <DataTable
              columns={tableColumns}
              data={sortedRows}
              rowKey={(r) => r.id}
              sort={sort}
              onSortChange={setSort}
              loading={tableLoading}
              selectable
              selectedKeys={selectedRows}
              onSelectionChange={setSelectedRows}
              caption="Recent contexts — click a header to sort, tick to select"
            />
            <Text variant="label" tone="faint">Empty state</Text>
            <DataTable columns={tableColumns} data={[]} rowKey={(r) => r.id} />
          </Stack>
        </Section>

        {/* ── P0.6 charting layer — dark + light side-by-side ────────────── */}
        <Section title="Charts (P0.6) — dark ‖ light, one page">
          <Text tone="faint" variant="body">
            Each island forces its own theme (via token CSS-var islands); charts
            resolve concrete hex from the P0.2 tokens through the shared chartTheme
            — so both themes render at once for verification. recharts (2D) +
            @xyflow/react v12 (graph) + a dependency-free SVG heatmap.
          </Text>
          <div style={{ marginTop: 'var(--sp-4)' }}>
            <Grid columns={2} gap={4}>
              <ThemeIsland theme="dark">
                <ChartsShowcase theme="dark" />
              </ThemeIsland>
              <ThemeIsland theme="light">
                <ChartsShowcase theme="light" />
              </ThemeIsland>
            </Grid>
          </div>
        </Section>

        <div style={{ height: 'var(--sp-10)' }} />
      </div>
    </div>
  );
};

export default PrimitivesGallery;
