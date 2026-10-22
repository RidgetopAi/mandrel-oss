/**
 * THE RECORDING DIRECTIVE — contract tests.
 *
 * WHAT IS BEING GUARDED, and why a test can guard it at all.
 *
 * The defect is MEASURED and it is behavioural: injecting this briefing cut a session's
 * Mandrel tool calls ~5x against an arm that fetched its own state at boot (44/45/57 ->
 * 9/10/17; one replicate made ZERO calls across all eight sessions). The loss was not
 * confined to the boot READS the injection was designed to replace — the same sessions
 * stopped WRITING. No unit test can re-measure that; the confirming measurement is a fourth
 * eval arm and is named in the task.
 *
 * What a test CAN pin is the property the fix turns on, which is a property of the document:
 * the briefing must carry, in its own text, a WRITE-side instruction that (a) is present,
 * (b) is present even when there is nothing to report, (c) names the write tools, (d) says
 * in as many words that "do not re-fetch" is about READING, and (e) is the LAST thing in the
 * document. Before this change the render contained no write-side text at all — the whole
 * document is a report of past state — so every assertion below is a real before/after.
 *
 * PURE-RENDERER ONLY. renderBriefing() is a pure function of (data, config, now), which is
 * what lets these cases drive the SHIPPED entry point with a fabricated corpus rather than
 * re-building the composition the product performs (C3).
 */

import { describe, test, expect } from 'vitest';
import {
  renderBriefing,
  briefingConfig,
  type BriefingData,
  type BriefingConfig,
} from '../services/projectBriefing.js';
import {
  BRIEFING_RECORDING_DIRECTIVE_DEFAULT,
  READ_BRIEFING_RECORDING_DIRECTIVE_ENABLED,
} from '../config/briefingConfig.js';
import { NO_HANDOFF_STAMPS } from '../services/handoffStamp.js';
import { NO_CARRIED_FIELDS } from '../services/handoffCarriedFields.js';
import { EMOJI_RE } from './helpers/emojiScan.js';
import { resolvedHead } from './helpers/handoffHeadFixture.js';
import { censusFor } from './helpers/briefingCensus.js';

const HANDOFF_ID = '77777777-0000-0000-0000-000000000000';

/**
 * The shipped config, with only the size cap under test control. Everything else — the
 * directive flag INCLUDED — is read from the real config, because "is it on by default" is
 * one of the things under test and a fixture that pinned it would answer that question for
 * the renderer rather than asking it.
 */
function cfg(over: Partial<BriefingConfig> = {}): BriefingConfig {
  return { ...briefingConfig(), ...over };
}

function fabTask(n: number) {
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    title: `RD-T${n}`,
    description: `RD-T${n}-body ${'y'.repeat(600)}`,
    status: 'todo',
    priority: 'medium',
    createdAt: new Date('2026-08-10T00:00:00Z'),
    trustSignal: 'trust:test score:0.50',
    trustScore: 0.5,
    metadata: null,
    tags: [] as string[],
  };
}

function fabData(taskCount: number): BriefingData {
  const tasks = Array.from({ length: taskCount }, (_, i) => fabTask(i + 1));
  return {
    projectId: '99999999-0000-0000-0000-000000000000',
    projectName: 'rd-fab',
    handoffHead: resolvedHead({ id: HANDOFF_ID }),
    handoff: {
      id: HANDOFF_ID,
      content: 'RD-HANDOFF resume point',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      trustSignal: 'trust:unproven score:1.00',
      stamps: NO_HANDOFF_STAMPS,
      carried: NO_CARRIED_FIELDS,
      spineResolved: null,
    },
    tasks,
    decisions: [],
    conventions: [],
    deadEnds: [],
    branch: null,
    waiting: null,
    census: censusFor({ tasks, decisions: [], conventions: [], deadEnds: [] }),
  };
}

/**
 * THE EMPTY DOCUMENT — the corpus that matters most here, and the reason it is not merely a
 * C3 box-tick. The eval replicate that made ZERO Mandrel calls for all eight sessions was
 * being handed a 214-BYTE empty-shell briefing: nothing had ever been written, so there was
 * nothing to report, and the injected block still read as "memory is handled". A directive
 * that only appears once a project has content would be absent from exactly that session.
 */
function emptyData(): BriefingData {
  return {
    projectId: '99999999-0000-0000-0000-000000000000',
    projectName: 'rd-empty',
    handoffHead: resolvedHead(null),
    handoff: null,
    tasks: [],
    decisions: [],
    conventions: [],
    deadEnds: [],
    branch: null,
    waiting: null,
    census: censusFor({ tasks: [], decisions: [], conventions: [], deadEnds: [] }),
  };
}

describe('recording directive — the WRITE half of the injected block', () => {
  test('SHIPPED DEFAULT IS ON — a fix that defaults off is not a fix', () => {
    // Read through the config function the renderer itself calls, not a literal: this is the
    // value a deployment gets when nobody sets anything, which is every deployment today.
    expect(READ_BRIEFING_RECORDING_DIRECTIVE_ENABLED()).toBe(true);
    expect(briefingConfig().recordingDirectiveEnabled).toBe(true);
  });

  test('the rendered document carries a write-side directive naming the WRITE tools', () => {
    const { markdown } = renderBriefing(fabData(2), cfg());
    // (c) the tools are NAMED — this also removes the discovery step in harnesses where MCP
    // tools load on demand, which is fix candidate 3 on the task.
    expect(markdown).toContain("decision({action:'record'");
    expect(markdown).toContain("context({action:'store'");
    expect(markdown).toContain("task({action:'create'");
    expect(markdown).toContain("type:'handoff'");
  });

  test('it separates READ from WRITE explicitly — the measured generalisation is the defect', () => {
    const { markdown } = renderBriefing(fabData(2), cfg());
    // (d) The whole mechanism is a READ-side prohibition generalising to all Mandrel use. The
    // document must scope that prohibition IN ITS OWN TEXT, so the words are asserted rather
    // than trusted to survive a future edit that "tightens the wording".
    expect(markdown).toContain('do not spend turns re-fetching it');
    expect(markdown).toContain('an instruction about');
    expect(markdown).toContain('it does not extend to recording');
    expect(markdown).toContain('Recording is not optional and is not done.');
  });

  test('IT IS LAST — recency is load-bearing, so position is asserted, not assumed', () => {
    const { markdown } = renderBriefing(fabData(6), cfg());
    // (e) `endsWith` and not `indexOf > x`: "somewhere near the end" is not the property. The
    // directive is the final thing a reader passes before starting work, and a later section
    // appended after it would silently take that position back.
    expect(markdown.endsWith(BRIEFING_RECORDING_DIRECTIVE_DEFAULT)).toBe(true);
  });

  test('it survives an EMPTY project — the 214-byte replicate that made zero calls', () => {
    const { markdown } = renderBriefing(emptyData(), cfg());
    expect(markdown).toContain('the WRITE half is yours');
    expect(markdown.endsWith(BRIEFING_RECORDING_DIRECTIVE_DEFAULT)).toBe(true);
    // And the rest of the empty document is still the honest minimal one.
    expect(markdown).toContain('## Handoff');
    expect(markdown).toContain('none recorded');
  });

  test('it is FRAME, not a record: the size cap is still honoured with it on', () => {
    // 40 fat tasks against a small cap. If the directive were exempted from the cap loop —
    // or pushed after the loop's last assemble() — the document would come back over cap.
    const cap = 6000;
    const { markdown } = renderBriefing(fabData(40), cfg({ maxChars: cap }));
    expect(markdown.length).toBeLessThanOrEqual(cap);
    expect(markdown.endsWith(BRIEFING_RECORDING_DIRECTIVE_DEFAULT)).toBe(true);
  });

  test('THE COMPONENT COST is stated as a number a reader can check (scoring rule a2243a8d)', () => {
    // Not an assertion about goodness — an assertion that the block is BOUNDED and that the
    // number quoted in briefingConfig.ts and in the task report is the number that ships.
    // A directive that grows silently is paid for in evicted records on every saturated
    // project, so the cost is pinned here rather than described.
    expect(BRIEFING_RECORDING_DIRECTIVE_DEFAULT.length).toBeLessThanOrEqual(1200);
    // The cost the document actually pays: the block, plus the two newlines the blank-line
    // separator and the block itself contribute when `lines` is joined. Asserted as an exact
    // subtraction rather than a remembered figure, so the number in the docs cannot drift
    // away from the number that ships.
    const on = renderBriefing(fabData(2), cfg()).markdown;
    const off = renderBriefing(fabData(2), cfg({ recordingDirectiveEnabled: false })).markdown;
    expect(on.length - off.length).toBe(BRIEFING_RECORDING_DIRECTIVE_DEFAULT.length + 2);
    expect(on.length - off.length).toBe(1030);
  });

  test('OFF is byte-identical to the pre-cfd2ec6c document', () => {
    // The kill switch has to be a real one: everything else in the render must be untouched
    // by this change. `off` is what the renderer produced before the block existed.
    const on = renderBriefing(fabData(3), cfg()).markdown;
    const off = renderBriefing(fabData(3), cfg({ recordingDirectiveEnabled: false })).markdown;
    expect(on.startsWith(off)).toBe(true);
    expect(off).not.toContain("decision({action:'record'");
  });

  test('an operator can re-spell it for a different tool surface', () => {
    // The default names the GATEWAY surface. A deployment whose clients are on the flat
    // per-tool surface must be able to say `context_store` instead of being told to call a
    // tool it cannot see — that is why the text is a knob and not a literal in the renderer.
    const { markdown } = renderBriefing(
      fabData(2),
      cfg({ recordingDirective: '## Recording\ncall context_store before you stop.' }),
    );
    expect(markdown).toContain('call context_store before you stop.');
    expect(markdown).not.toContain("decision({action:'record'");
  });

  test('the directive is machine-lean: no emoji (WS1 D2 applies to frame we author)', () => {
    // Record CONTENT passes through verbatim, but this block is text THIS MODULE authors, so
    // the lean rule binds it exactly as it binds every other heading and footer here.
    expect(EMOJI_RE.test(BRIEFING_RECORDING_DIRECTIVE_DEFAULT)).toBe(false);
  });
});
