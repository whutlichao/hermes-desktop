import { Fragment } from "react";

interface MarkdownBlock {
  kind: "text" | "code";
  content: string;
  language?: string;
}

function splitMarkdownBlocks(raw: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const fenceRe = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ kind: "text", content: raw.slice(lastIndex, match.index) });
    }
    blocks.push({
      kind: "code",
      language: match[1] || undefined,
      content: match[2].replace(/\n$/, ""),
    });
    lastIndex = fenceRe.lastIndex;
  }

  if (lastIndex < raw.length) {
    blocks.push({ kind: "text", content: raw.slice(lastIndex) });
  }

  return blocks;
}

function renderInlineSegments(line: string, keyPrefix: string) {
  const parts: Array<string | { kind: "code" | "bold"; text: string }> = [];
  const inlineRe = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRe.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(line.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push({ kind: "code", text: token.slice(1, -1) });
    } else {
      parts.push({ kind: "bold", text: token.slice(2, -2) });
    }
    lastIndex = inlineRe.lastIndex;
  }
  if (lastIndex < line.length) {
    parts.push(line.slice(lastIndex));
  }

  return parts.map((part, idx) => {
    if (typeof part === "string") {
      return <Fragment key={`${keyPrefix}-t-${idx}`}>{part}</Fragment>;
    }
    if (part.kind === "code") {
      return (
        <code key={`${keyPrefix}-c-${idx}`} className="msg-inline-code">
          {part.text}
        </code>
      );
    }
    return <strong key={`${keyPrefix}-b-${idx}`}>{part.text}</strong>;
  });
}

export function MarkdownText({ text }: { text: string }) {
  if (!text) return null;
  const blocks = splitMarkdownBlocks(text);

  return (
    <div className="msg-markdown">
      {blocks.map((block, bIdx) => {
        if (block.kind === "code") {
          return (
            <div key={`code-${bIdx}`} className="msg-code-wrap">
              {block.language && <span className="msg-code-lang">{block.language}</span>}
              <pre className="msg-code-block">
                <code>{block.content}</code>
              </pre>
            </div>
          );
        }

        const paragraphs = block.content.split(/\n{2,}/);
        return paragraphs.map((para, pIdx) => {
          const trimmed = para.trim();
          if (!trimmed) return null;
          const lines = trimmed.split("\n");
          return (
            <p key={`p-${bIdx}-${pIdx}`} className="msg-paragraph">
              {lines.map((line, lIdx) => (
                <Fragment key={`l-${bIdx}-${pIdx}-${lIdx}`}>
                  {lIdx > 0 && <br />}
                  {renderInlineSegments(line, `s-${bIdx}-${pIdx}-${lIdx}`)}
                </Fragment>
              ))}
            </p>
          );
        });
      })}
    </div>
  );
}
