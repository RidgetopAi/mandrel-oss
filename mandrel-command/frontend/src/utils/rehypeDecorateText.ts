/**
 * Composable text-node decoration layer for the MarkdownContent rehype pipeline.
 *
 * WHY THIS EXISTS (the composability contract): rendered record content is decorated
 * by MORE THAN ONE independent transform — Feature C linkifies id-shaped tokens, and
 * a later Feature B will HIGHLIGHT search terms — and both operate on the SAME text
 * nodes of the SAME produced HAST. Rather than let either feature "own" the text
 * pipeline (which would force the other to reach inside it), each is expressed as a
 * `TextDecorator`: a pure `(text) => HastNode[]` that splits one text string into a
 * mix of plain-text and wrapper-element nodes. This factory turns any decorator into
 * a rehype plugin that walks the tree and applies it to every eligible text node.
 *
 * HOW TWO DECORATORS COMPOSE: because each plugin only ever REPLACES a text node with
 * text + wrapper nodes (whose own text children are themselves plain text nodes), a
 * SECOND decorate-text plugin added AFTER the first will naturally visit the text
 * that now sits inside the first's wrappers. So Feature B's highlight, added after
 * rehypeLinkifyNavIds, will highlight terms even inside a link — no special casing.
 * ORDER MATTERS: linkify must run BEFORE highlight (a <mark> splitting an id token
 * would defeat detection); see navIdLinkify.ts for exactly where B hooks in.
 *
 * SKIP SUBTREES: a decorator declares tag names whose subtrees it must not touch
 * (e.g. linkify skips <a> so it never double-links, and <pre> so it never rewrites
 * code blocks). The walk does not descend into a skipped element.
 *
 * SECURITY: this only ever reads `text` node string values and builds NEW element
 * nodes from decorator output; it never sets innerHTML and never moves untrusted
 * text into an attribute. It is intended to run BEFORE rehype-sanitize so the
 * sanitizer remains the final authority over the whole tree (defense in depth).
 */

/** Minimal HAST shapes we touch — kept local so we need no @types/hast dependency. */
export interface HastText {
  type: 'text';
  value: string;
}
export interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}
/** Any node in the tree; only text and element carry the fields we use. */
export type HastNode =
  | HastText
  | HastElement
  | { type: string; value?: string; children?: HastNode[]; tagName?: string };

/**
 * Split one plain-text string into a sequence of HAST nodes (plain text and/or
 * wrapper elements). Returning a single unchanged text node is a valid no-op.
 */
export type TextDecorator = (value: string) => HastNode[];

export interface DecorateOptions {
  /** Element tag names whose subtrees are left completely untouched. */
  skipTags?: string[];
}

function hasChildren(node: HastNode): node is HastNode & { children: HastNode[] } {
  return Array.isArray((node as { children?: unknown }).children);
}

/**
 * Recursively apply `decorator` to every text node in `node`'s subtree, skipping
 * any element whose tagName is in `skipTags`. Mutates children arrays in place.
 */
export function decorateTextTree(
  node: HastNode,
  decorator: TextDecorator,
  skipTags: Set<string>,
): void {
  if (!hasChildren(node)) return;

  const nextChildren: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text') {
      const value = (child as HastText).value ?? '';
      const replacement = decorator(value);
      nextChildren.push(...replacement);
      continue;
    }
    if (
      child.type === 'element' &&
      typeof (child as HastElement).tagName === 'string' &&
      skipTags.has((child as HastElement).tagName)
    ) {
      // Do not descend into or rewrite a skipped subtree (e.g. <a>, <pre>).
      nextChildren.push(child);
      continue;
    }
    // Recurse into any other container, then keep it.
    decorateTextTree(child, decorator, skipTags);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

/**
 * Build a rehype plugin from a TextDecorator. Usage in a rehypePlugins list:
 *   [ rehypeDecorateText(myDecorator, { skipTags: ['a','pre'] }), ... ]
 */
export function rehypeDecorateText(decorator: TextDecorator, opts: DecorateOptions = {}) {
  const skipTags = new Set(opts.skipTags ?? []);
  return function attacher() {
    return function transformer(tree: HastNode): void {
      decorateTextTree(tree, decorator, skipTags);
    };
  };
}
