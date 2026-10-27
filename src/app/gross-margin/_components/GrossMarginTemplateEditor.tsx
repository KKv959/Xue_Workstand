"use client";

import { useEffect, useRef } from "react";
import { EditorContent, Node, useEditor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { grossMarginReviewTemplateVariables } from "@/lib/gross-margin-template";

const labels = new Map<string, string>(grossMarginReviewTemplateVariables.map(({ name, label }) => [name, label]));

function templateDocument(value: string): JSONContent {
  return {
    type: "doc",
    content: value.replace(/\r\n?/g, "\n").split("\n").map((line) => {
      const content: JSONContent[] = [];
      let cursor = 0;
      for (const match of line.matchAll(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g)) {
        if (!labels.has(match[1])) continue;
        if (match.index > cursor) content.push({ type: "text", text: line.slice(cursor, match.index) });
        content.push({ type: "templateField", attrs: { name: match[1], token: match[0] } });
        cursor = match.index + match[0].length;
      }
      if (cursor < line.length) content.push({ type: "text", text: line.slice(cursor) });
      return { type: "paragraph", content };
    })
  };
}

const TemplateField = Node.create({
  name: "templateField",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes: () => ({ name: { default: "" }, token: { default: "" } }),
  parseHTML: () => [{ tag: "span[data-template-field]" }],
  renderHTML: ({ node }) => ["span", {
    "data-template-field": node.attrs.name,
    name: node.attrs.name,
    token: node.attrs.token,
    class: "gross-template-field",
    contenteditable: "false"
  }, labels.get(node.attrs.name) || node.attrs.name],
  renderText: ({ node }) => node.attrs.token || `{{${node.attrs.name}}}`
});

export function GrossMarginTemplateEditor({ value, disabled, onChange }: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const lastEmitted = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit.configure({
      heading: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false,
      blockquote: false, codeBlock: false, horizontalRule: false,
      bold: false, italic: false, strike: false, code: false, link: false, underline: false
    }), TemplateField],
    content: templateDocument(value),
    editorProps: {
      attributes: {
        class: "gross-template-input", role: "textbox", "aria-label": "模板内容",
        "aria-multiline": "true", "aria-describedby": "gross-template-help"
      },
      clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, "\n", (node) =>
        node.type.name === "templateField" ? node.attrs.token || `{{${node.attrs.name}}}` : "\n"),
      handlePaste: (_view, event) => {
        const text = event.clipboardData?.getData("text/plain");
        if (!text || !editor) return false;
        event.preventDefault();
        editor.commands.insertContent(templateDocument(text).content!);
        return true;
      }
    },
    onUpdate: ({ editor }) => {
      const text = editor.getText({ blockSeparator: "\n" });
      lastEmitted.current = text;
      onChangeRef.current(text);
    }
  });

  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);
  useEffect(() => {
    if (editor && value !== lastEmitted.current) {
      editor.commands.setContent(templateDocument(value), { emitUpdate: false });
      lastEmitted.current = value;
    }
  }, [editor, value]);

  return <>
    <div className="field gross-template-editor">
      <span>模板内容</span>
      <EditorContent editor={editor} />
    </div>
    <p className="subtle" id="gross-template-help">蓝色字段会自动填入对应数据；可编辑周围文字，或点击下方字段插入到光标处。</p>
    <div className="gross-template-variable-list" aria-label="可插入字段">
      {grossMarginReviewTemplateVariables.map(({ name, label }) => (
        <button className="btn compact" disabled={disabled || !editor} key={name}
          onClick={() => editor?.chain().focus().insertContent({ type: "templateField", attrs: { name, token: `{{${name}}}` } }).run()}
          type="button">{label}</button>
      ))}
    </div>
  </>;
}
