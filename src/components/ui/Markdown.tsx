import type { ReactNode } from 'react';

/**
 * Minimal Markdown for assistant answers: paragraphs, headings, bullet/numbered lists,
 * pipe tables, **bold**, *italic* and `code`. Builds React elements only (never HTML
 * strings), so model output can't inject markup.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="flex flex-col gap-2 text-ink-100">{blocks(text)}</div>;
}

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      out.push(<p key={i} className="font-semibold text-white">{inline(h[2])}</p>);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      const start = i;
      const rows: string[][] = [];
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        <div key={start} className="overflow-x-auto">
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-ink-400"><tr className="border-b border-ink-700">{head.map((c, k) => <th key={k} className="py-1 pr-3 font-medium">{inline(c)}</th>)}</tr></thead>
            <tbody>{rows.map((r, j) => <tr key={j} className="border-b border-ink-800">{r.map((c, k) => <td key={k} className="py-1 pr-3 tabular-nums">{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const start = i;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ''));
      const cls = `ml-4 flex flex-col gap-0.5 ${ordered ? 'list-decimal' : 'list-disc'}`;
      const children = items.map((t, k) => <li key={k}>{inline(t)}</li>);
      out.push(ordered ? <ol key={start} className={cls}>{children}</ol> : <ul key={start} className={cls}>{children}</ul>);
      continue;
    }
    const start = i;
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !bullet.test(lines[i]) && !numbered.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) para.push(lines[i++]);
    out.push(<p key={start} className="whitespace-pre-wrap">{inline(para.join('\n'))}</p>);
  }
  return out;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = m.index;
    if (tok.startsWith('**')) out.push(<strong key={key} className="font-semibold text-white">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={key} className="rounded bg-ink-800 px-1 text-[12px]">{tok.slice(1, -1)}</code>);
    else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
