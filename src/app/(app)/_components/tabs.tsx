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
    <nav className="flex gap-1 overflow-x-auto border-b border-zinc-200 text-sm dark:border-zinc-800">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'border-b-2 border-zinc-900 px-3 py-2 font-medium text-zinc-950 dark:border-zinc-100 dark:text-zinc-50'
                : 'border-b-2 border-transparent px-3 py-2 text-zinc-600 hover:border-zinc-300 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50'
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
