'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Tabs as links, with the current one marked. Client-side only because the active
 * tab is a function of the URL, which a server layout cannot read without turning
 * every tab into a separate layout.
 */
export function Tabs({ items }: { items: { href: string; label: string }[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-border text-sm">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'border-b-2 border-brand px-3 py-2 font-medium text-brand'
                : 'border-b-2 border-transparent px-3 py-2 text-text-muted hover:border-border-strong hover:text-text'
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
