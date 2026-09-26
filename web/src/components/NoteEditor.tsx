import { useCallback, type ReactNode } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TableKit } from '@tiptap/extension-table';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Image } from '@tiptap/extension-image';
import { uploadNoteImage } from '../lib/note-editing';
import { Details, DetailsContent, DetailsSummary, EMPTY_DETAILS, emptySummaryAfter } from './details';

/**
 * The writing surface.
 *
 * Rich rather than a Markdown textarea, because the ask was Confluence: people
 * writing notes should not have to know a syntax. What it stores is still
 * Markdown — see note-editing.ts for why — so the editor is an interface to
 * the format rather than a replacement for it.
 *
 * Loaded as its own chunk. Nobody reading a note pays for an editor.
 */

interface Props {
  /** Needed before the first image can be uploaded, since assets live under it. */
  noteId: string;
  initialHtml: string;
  onChange: (html: string) => void;
  onError: (message: string) => void;
}

function Button({
  onClick,
  active,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={active ? 'tb__button is-on' : 'tb__button'}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function Toolbar({ editor, noteId, onError }: { editor: Editor; noteId: string; onError: (m: string) => void }) {
  const pickImage = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const src = await uploadNoteImage(noteId, file);
        editor.chain().focus().setImage({ src, alt: file.name }).run();
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : 'That image could not be added');
      }
    };
    input.click();
  }, [editor, noteId, onError]);

  const addSection = useCallback(() => {
    const from = editor.state.selection.from;
    editor.chain().focus().insertContent(EMPTY_DETAILS).run();

    const title = emptySummaryAfter(editor.state.doc, from);
    if (title !== null) editor.commands.focus(title);
  }, [editor]);

  const setLink = useCallback(() => {
    const previous = editor.getAttributes('link').href ?? '';
    const href = window.prompt('Link to', previous);
    if (href === null) return;
    if (href === '') {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().setLink({ href, target: '_blank', rel: 'noreferrer' }).run();
  }, [editor]);

  return (
    <div className="tb" role="toolbar" aria-label="Formatting">
      <select
        className="tb__select"
        aria-label="Text style"
        value={
          editor.isActive('heading', { level: 1 }) ? 'h1'
          : editor.isActive('heading', { level: 2 }) ? 'h2'
          : editor.isActive('heading', { level: 3 }) ? 'h3'
          : 'p'
        }
        onChange={(event) => {
          const value = event.target.value;
          const chain = editor.chain().focus();
          if (value === 'p') chain.setParagraph().run();
          else chain.setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }).run();
        }}
      >
        <option value="p">Body</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>

      <span className="tb__rule" />

      <Button label="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
        <strong>B</strong>
      </Button>
      <Button label="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <em>I</em>
      </Button>
      <Button label="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <s>S</s>
      </Button>
      <Button label="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
        {'<>'}
      </Button>
      <Button label="Link" active={editor.isActive('link')} onClick={setLink}>
        ⛓
      </Button>

      <span className="tb__rule" />

      <Button label="Bulleted list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        •
      </Button>
      <Button label="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        1.
      </Button>
      <Button label="Checklist" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}>
        ☑
      </Button>

      <span className="tb__rule" />

      <Button label="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        ❝
      </Button>
      <Button label="Code block" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        {'{}'}
      </Button>
      <Button label="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
        —
      </Button>
      <Button
        label="Table"
        onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      >
        ▦
      </Button>
      <Button label="Image" onClick={pickImage}>
        ▣
      </Button>
      <Button label="Collapsible section" active={editor.isActive('details')} onClick={addSection}>
        ▾
      </Button>

      <span className="tb__rule" />

      <Button label="Undo" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
        ↺
      </Button>
      <Button label="Redo" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
        ↻
      </Button>
    </div>
  );
}

export function NoteEditor({ noteId, initialHtml, onChange, onError }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      // An empty document otherwise gives no sign that it is the thing to type
      // into, which on a page with no border around it is most of the problem.
      // A section's empty title needs saying out loud for the same reason.
      Placeholder.configure({
        includeChildren: true,
        placeholder: ({ node }) =>
          node.type.name === 'detailsSummary' ? 'Section title' : 'Start writing…',
      }),
      TableKit.configure({ table: { resizable: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Image,
      Details,
      DetailsSummary,
      DetailsContent,
    ],
    content: initialHtml,
    // The prose class is the reader's, deliberately: what you type should look
    // like what a reader will see, not like a form field.
    editorProps: {
      attributes: { class: 'prose editor__surface', spellcheck: 'true' },
      handlePaste: (view, event) => {
        const file = [...(event.clipboardData?.files ?? [])][0];
        if (!file?.type.startsWith('image/')) return false;
        // Pasted screenshots are the common case for trading notes.
        event.preventDefault();
        void uploadNoteImage(noteId, file)
          .then((src) => {
            const node = view.state.schema.nodes.image.create({ src });
            view.dispatch(view.state.tr.replaceSelectionWith(node));
          })
          .catch((cause) =>
            onError(cause instanceof Error ? cause.message : 'That image could not be added'),
          );
        return true;
      },
    },
    onUpdate: ({ editor: current }) => onChange(current.getHTML()),
  });

  if (!editor) return null;

  return (
    <div className="editor">
      <Toolbar editor={editor} noteId={noteId} onError={onError} />
      <EditorContent editor={editor} />
    </div>
  );
}
