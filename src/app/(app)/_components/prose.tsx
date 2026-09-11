import Link from 'next/link';
import { parseMarkdown, type Block, type Inline } from '@/lib/markdown';
import { isAppPath } from './nav';

export function Prose({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text, isAppPath);
  // An answer that parses to nothing still had something in it — show it rather
  // than rendering a silent gap where a reply should be.
  if (blocks.length === 0) {
    return <p className={className}>{text}</p>;
  }
  return (
    <div className={className}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} first={i === 0} />
      ))}
    </div>
  );
}

function BlockView({ block, first }: { block: Block; first: boolean }) {
  const top = first ? '' : 'mt-3';
  switch (block.kind) {
    case 'heading': {
      const size = block.level === 1 ? 'text-base' : 'text-sm';
      return (
        <p className={`${top} ${size} font-semibold text-text`}>
          <Spans spans={block.spans} />
        </p>
      );
    }
    case 'bullets':
      return (
        <ul className={`${top} list-disc space-y-1 pl-5`}>
          {block.items.map((item, i) => (
            <li key={i}>
              <Spans spans={item} />
            </li>
          ))}
        </ul>
      );
    case 'numbers':
      return (
        <ol className={`${top} list-decimal space-y-1 pl-5`}>
          {block.items.map((item, i) => (
            <li key={i}>
              <Spans spans={item} />
            </li>
          ))}
        </ol>
      );
    case 'code':
      return (
        <pre
          className={`${top} overflow-x-auto rounded border border-border bg-muted p-2 text-xs`}
        >
          {block.text}
        </pre>
      );
    default:
      return (
        <p className={top}>
          <Spans spans={block.spans} />
        </p>
      );
  }
}

function Spans({ spans }: { spans: Inline[] }) {
  return (
    <>
      {spans.map((s, i) => {
        switch (s.kind) {
          case 'bold':
            return (
              <strong key={i} className="font-semibold text-text">
                <Spans spans={s.spans} />
              </strong>
            );
          case 'italic':
            return (
              <em key={i}>
                <Spans spans={s.spans} />
              </em>
            );
          case 'code':
            return (
              <code key={i} className="rounded bg-muted px-1 py-0.5 text-[0.9em]">
                {s.text}
              </code>
            );
          case 'link':
            // Relative hrefs are our own screens and get client navigation;
            // anything external is a plain anchor that leaves.
            return s.href.startsWith('/') ? (
              <Link key={i} href={s.href} className="underline hover:no-underline">
                {s.text}
              </Link>
            ) : (
              <a
                key={i}
                href={s.href}
                rel="noreferrer noopener"
                target="_blank"
                className="underline hover:no-underline"
              >
                {s.text}
              </a>
            );
          default:
            return <span key={i}>{s.text}</span>;
        }
      })}
    </>
  );
}
