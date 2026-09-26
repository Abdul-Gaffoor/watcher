import { Node, mergeAttributes, type JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * A collapsible section.
 *
 * Markdown has no spelling for one, but GitHub-flavoured Markdown allows raw
 * HTML, and `<details>`/`<summary>` is what everything from GitHub to Confluence
 * exports. So that is what gets stored:
 *
 *     <details>
 *     <summary>Why the count matters</summary>
 *
 *     The **body**, still Markdown.
 *
 *     </details>
 *
 * The blank lines are load-bearing: an HTML block ends at a blank line, so the
 * body between them is parsed as Markdown rather than passed through as text.
 *
 * Three nodes rather than one, because a section has two parts that behave
 * differently -- a one-line title you cannot put a table in, and a body you can
 * put anything in.
 */

/** The section. Its two children are required, and in that order. */
export const Details = Node.create({
  name: 'details',
  group: 'block',
  content: 'detailsSummary detailsContent',
  defining: true,

  parseHTML() {
    return [{ tag: 'details' }, { tag: 'div[data-type="details"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    // A div, not a <details>. While writing, a section that can collapse itself
    // out from under the cursor is a section you cannot edit -- so in the editor
    // it is always open, and it becomes a real <details> on the way to storage.
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'details' }), 0];
  },
});

/** The title. One line, no formatting: that is what a summary is. */
export const DetailsSummary = Node.create({
  name: 'detailsSummary',
  content: 'text*',
  marks: '',
  defining: true,
  selectable: false,
  isolating: true,

  parseHTML() {
    return [{ tag: 'summary' }, { tag: 'div[data-type="detailsSummary"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'detailsSummary' }), 0];
  },

  addKeyboardShortcuts() {
    return {
      // The title is one line, so Enter means "on with the body" rather than
      // "another line of title".
      Enter: () => {
        const { selection } = this.editor.state;
        const { $from } = selection;
        if ($from.parent.type.name !== this.name) return false;

        // Just inside the content node that follows this summary.
        return this.editor.commands.focus($from.after($from.depth) + 2);
      },
    };
  },
});

/** The body. Anything a note can hold, including another section. */
export const DetailsContent = Node.create({
  name: 'detailsContent',
  content: 'block+',
  defining: true,
  selectable: false,

  parseHTML() {
    return [{ tag: 'div[data-type="detailsContent"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'detailsContent' }), 0];
  },
});

/**
 * What the toolbar inserts: an empty section.
 *
 * The title is empty rather than pre-filled, because a pre-filled one has to be
 * selected and deleted before it can be replaced. The placeholder says what
 * belongs there instead.
 */
export const EMPTY_DETAILS: JSONContent = {
  type: 'details',
  content: [{ type: 'detailsSummary' }, { type: 'detailsContent', content: [{ type: 'paragraph' }] }],
};

/**
 * The position of the empty title in a section just inserted at `from`.
 *
 * `insertContent` leaves the cursor past the whole section, which is the one
 * place in it nobody wants to be typing.
 */
export function emptySummaryAfter(doc: ProseMirrorNode, from: number): number | null {
  let found: number | null = null;
  doc.descendants((node, at) => {
    if (found !== null) return false;
    if (at >= from - 1 && node.type.name === 'detailsSummary' && node.content.size === 0) {
      found = at + 1;
      return false;
    }
    return true;
  });
  return found;
}
