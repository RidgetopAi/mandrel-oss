/**
 * GUARD — no page renders a project selector of its own.
 * "Remove Project Selectors from each page and return the master selector to
 * top menu."
 *
 * ── POPULATION (stated, per C3) ──────────────────────────────────────────────────────
 * Every product `.tsx` under `src/` — pages, parts, shell, components — excluding test
 * files. It is the whole population because a per-page selector can only exist as a JSX
 * element somewhere under `src/`, and the primitive is one named component.
 *
 * ── RECOGNIZER ───────────────────────────────────────────────────────────────────────
 * The TypeScript parser, not a regex: the local name(s) the file imported the shared
 * `ProjectSelect` under (named, aliased, or default import) and every JSX opening /
 * self-closing element using one of them (a comment, a string, or a bare import line
 * cannot match, and an alias cannot evade it). The files
 * allowed to render it are enumerated EXACTLY — a form field that files a record into a
 * project is not a page scope selector, and each one is named with its reason — and the
 * set is asserted with equality, so a new renderer fails and a deleted one does too
 * (the list is a snapshot, and a snapshot that silently shrinks is a hollow guard).
 *
 * ── WITNESS THAT THE WALKER WORKS ────────────────────────────────────────────────────
 * The shell switch MUST be found. An AST walk that found nothing would pass a
 * "no page renders it" assertion vacuously; requiring the switch in the set is the
 * non-empty-population probe.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import ts from 'typescript';

const SRC = resolve(__dirname, '..');

/** Every non-test .tsx under src/, as src-relative POSIX paths. */
function productTsxFiles(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'generated') {
        continue;
      }
      productTsxFiles(full, out);
    } else if (entry.endsWith('.tsx') && !/\.test\.tsx$/.test(entry)) {
      out.push(relative(SRC, full).split('\\').join('/'));
    }
  }
  return out;
}

/**
 * True if `text` renders the component exported as `exportName` from a module whose
 * specifier ends with `moduleSuffix` — under WHATEVER local name the file imported it as.
 * Resolves `import { X }`, `import { X as Y }`, and `import Y from '.../X'` from the
 * import declarations, then matches JSX tags against those local names (walkthrough
 * ed6ae449 N1: matching the literal tag let `import { ProjectSelect as PS }` through).
 */
export function rendersImported(
  text: string,
  exportName: string,
  moduleSuffix: string,
  fileName = 'probe.tsx',
): boolean {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const localNames = new Set<string>();
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) {
      continue;
    }
    const spec = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause) {
      continue;
    }
    // `import Y from '.../ProjectSelect'` — the default export IS the component.
    if (clause.name && spec.endsWith(moduleSuffix)) {
      localNames.add(clause.name.text);
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (imported === exportName) {
          localNames.add(el.name.text);
        }
      }
    }
  }
  if (localNames.size === 0) {
    return false;
  }
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (localNames.has(node.tagName.getText(source))) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The file at `relPath` renders the shared ProjectSelect (however it imported it). */
const rendersProjectSelect = (relPath: string): boolean =>
  rendersImported(readFileSync(join(SRC, relPath), 'utf8'), 'ProjectSelect', 'ProjectSelect', relPath);

/** The file at `relPath` renders the shell switch. */
const rendersProjectSwitch = (relPath: string): boolean =>
  rendersImported(readFileSync(join(SRC, relPath), 'utf8'), 'ProjectSwitch', 'ProjectSwitch', relPath);

/**
 * The ONLY files allowed to render <ProjectSelect>, each with its reason. A PAGE is not
 * on this list and must never be.
 */
const ALLOWED_RENDERERS: Record<string, string> = {
  'components/shell/ProjectSwitch.tsx': 'THE switch — the one control that scopes every page',
  'pages/punch/PunchForm.tsx': 'the "Where" field of the punch FORM — chooses where a record files, not what a page shows',
  'pages/sessions/NewSessionModal.tsx': 'the new-session FORM — pre-selected from the page scope, overridable per record',
  'pages/PrimitivesGallery.tsx': 'the unauthenticated /dev/ui gallery — inline fixtures, no ProjectProvider',
};

describe('GUARD — the ONE project switch lives in the shell; no page renders its own', () => {
  const files = productTsxFiles();
  const renderers = files.filter(rendersProjectSelect).sort();

  it('walks a real population (not an empty directory)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('components/shell/ProjectSwitch.tsx');
  });

  it('finds the shell switch — the witness that the AST walk actually recognises the tag', () => {
    expect(renderers).toContain('components/shell/ProjectSwitch.tsx');
  });

  it('the set of <ProjectSelect> renderers is EXACTLY the allowed forms + the shell switch', () => {
    expect(renderers).toEqual(Object.keys(ALLOWED_RENDERERS).sort());
  });

  it('no page or page part renders one (the pages/ subset, stated on its own so the failure names the page)', () => {
    const pageRenderers = renderers.filter(
      (f) => f.startsWith('pages/') && !(f in ALLOWED_RENDERERS),
    );
    expect(pageRenderers).toEqual([]);
  });

  it('the Topbar renders the switch, and nothing under pages/ does', () => {
    expect(rendersProjectSwitch('components/shell/Topbar.tsx')).toBe(true);
    const pagesRenderingSwitch = files.filter((f) => f.startsWith('pages/') && rendersProjectSwitch(f));
    expect(pagesRenderingSwitch).toEqual([]);
  });
});

describe('GUARD — the recognizer follows the IMPORT, not the literal tag (N1)', () => {
  const alias = `
import React from 'react';
import { ProjectSelect as PS } from '../components/ui';
export const Page = () => <PS projects={[]} value={undefined} onChange={() => undefined} />;
`;
  const dflt = `
import React from 'react';
import Picker from '../components/ui/ProjectSelect';
export const Page = () => <Picker projects={[]} value={undefined} onChange={() => undefined} />;
`;
  const importedNotRendered = `
import React from 'react';
import { ProjectSelect } from '../components/ui';
export const Page = () => <div>{typeof ProjectSelect}</div>;
`;
  const sameNameNotImported = `
import React from 'react';
const ProjectSelect = () => null;
export const Page = () => <ProjectSelect />;
`;

  it('catches an ALIASED named import', () => {
    expect(rendersImported(alias, 'ProjectSelect', 'ProjectSelect')).toBe(true);
  });
  it('catches a DEFAULT import under another name', () => {
    expect(rendersImported(dflt, 'ProjectSelect', 'ProjectSelect')).toBe(true);
  });
  it('does not fire on an import that is never rendered (the empty population)', () => {
    expect(rendersImported(importedNotRendered, 'ProjectSelect', 'ProjectSelect')).toBe(false);
  });
  it('does not fire on a local component that merely shares the name', () => {
    expect(rendersImported(sameNameNotImported, 'ProjectSelect', 'ProjectSelect')).toBe(false);
  });
});
