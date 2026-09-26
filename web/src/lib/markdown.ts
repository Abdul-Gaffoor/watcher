/**
 * Markdown to HTML, for reading and for editing.
 *
 * One module for both, because a note has to come out of storage looking the
 * same whether it is about to be read or about to be changed -- and because the
 * checklist fix below is needed in both places and is easy to apply in only one.
 */

/**
 * Rewrites a checklist into the shape the editor understands.
 *
 * `marked` renders `- [x] done` as a plain `<ul>` whose items begin with a
 * disabled checkbox. TipTap's task list is a different spelling of the same
 * thing: `<ul data-type="taskList">`, `data-checked` on each item, and the
 * checkbox in a label beside a block of content. Left alone, opening a note in
 * the editor turns every checklist back into bullets and loses which boxes were
 * ticked.
 *
 * The editor's spelling is the one produced here, for both readers and the
 * editor, so a checklist looks identical either way and one set of styles
 * covers it. The editor ignores the label on the way in and renders its own.
 */
function normaliseTaskLists(html: string): string {
  const holder = document.createElement('div');
  holder.innerHTML = html;

  for (const list of holder.querySelectorAll('ul')) {
    const items = [...list.children].filter((item) => item.tagName === 'LI');
    const boxed = items.filter((item) => item.querySelector(':scope > input[type="checkbox"]'));
    // A list is a checklist only if it is one throughout. A stray checkbox in
    // an ordinary list is somebody's content, not a structure.
    if (boxed.length === 0 || boxed.length !== items.length) continue;

    list.setAttribute('data-type', 'taskList');

    for (const item of items) {
      const box = item.querySelector(':scope > input[type="checkbox"]') as HTMLInputElement;
      const checked = box.checked || box.hasAttribute('checked');
      box.remove();

      // The content has to sit in a block, because that is what a task item
      // holds -- and a reader needs a box to look at, not just the state.
      const content = document.createElement('div');
      while (item.firstChild) content.append(item.firstChild);
      if (!content.querySelector(':scope > p')) {
        const paragraph = document.createElement('p');
        while (content.firstChild) paragraph.append(content.firstChild);
        content.append(paragraph);
      }

      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.disabled = true;
      if (checked) checkbox.setAttribute('checked', '');
      label.append(checkbox);

      item.setAttribute('data-type', 'taskItem');
      item.setAttribute('data-checked', String(checked));
      item.append(label, content);
    }
  }

  return holder.innerHTML;
}

/** Parses Markdown, reconciles checklists, and sanitises what comes out. */
export async function renderMarkdown(text: string): Promise<string> {
  const [{ marked }, { default: DOMPurify }] = await Promise.all([
    import('marked'),
    import('dompurify'),
  ]);

  const html = await marked.parse(text, { gfm: true, breaks: false });
  return DOMPurify.sanitize(normaliseTaskLists(html), { USE_PROFILES: { html: true } });
}

/**
 * Sanitises stored HTML -- a note converted from a `.docx`.
 *
 * It was sanitised before it was stored as well. The store is not a trust
 * boundary, and one of those two passes being enough is not worth relying on.
 */
export async function sanitiseHtml(html: string): Promise<string> {
  const { default: DOMPurify } = await import('dompurify');
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
