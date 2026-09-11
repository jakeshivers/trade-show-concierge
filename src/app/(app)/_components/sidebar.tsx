'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from './cn';
import { GROUPS, visibleItems } from './nav';
import { setPref, usePref } from './pref';
import { ThemeToggle } from './theme-toggle';

/**
 * The app shell's navigation.
 *
 * A flat top bar with seven entries was fine at seven and is the wrong shape for
 * what is coming: steps 13–18 each add screens, and a horizontal bar answers
 * that by cramming. A sidebar grows *down*, which is the whole reason to build
 * it once now rather than restructure twice — the objection that the nav should
 * be laid out against the final set of screens is answered by picking a shape
 * that absorbs them.
 *
 * The groups are not decoration either. Show detail already nests ten tabs under
 * one entry, so orientation is the thing to get right, and the active state is
 * therefore a real contrast change — a tinted fill, brand text and a left bar —
 * rather than the subtle shift dense products reach for and users miss.
 *
 * The entries themselves live in `nav.ts`, because the overview reads the same
 * list. See that file for why one of them cannot be added without a sentence.
 */

export function Sidebar({
  isAdmin,
  isApprover,
  outstandingAlerts,
}: {
  isAdmin: boolean;
  isApprover: boolean;
  /**
   * `feed.summary.outstanding` — the same number the overview prints, passed
   * down rather than counted again. What counts as outstanding is
   * `standingOf`'s decision in `alerts/feed.ts`, and a SQL predicate here
   * agreeing with it today is the `SOURCE_LABEL` trap waiting to happen.
   */
  outstandingAlerts: number;
}) {
  const pathname = usePathname();
  const collapsed = usePref('nav-collapsed', '0') === '1';

  function toggle() {
    setPref('nav-collapsed', collapsed ? '0' : '1');
  }

  return (
    <aside
      className={cn(
        'sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-panel transition-[width] duration-150',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <div className={cn('flex items-center gap-2 px-3 py-4', collapsed && 'justify-center')}>
        {!collapsed && (
          <Link href="/" className="min-w-0 flex-1 truncate font-semibold tracking-tight">
            Trade Show Concierge
          </Link>
        )}
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!collapsed}
          className="rounded-md p-1.5 text-text-muted hover:bg-muted hover:text-text"
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          <span className="sr-only">{collapsed ? 'Expand navigation' : 'Collapse navigation'}</span>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {GROUPS.map((group) => {
          const items = visibleItems(group.items, { isAdmin, isApprover });
          if (items.length === 0) return null;
          return (
            <div key={group.label} className="mb-4">
              {!collapsed && (
                <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  {group.label}
                </p>
              )}
              <ul className="space-y-0.5">
                {items.map(({ href, label, Icon }) => (
                  <li key={href}>
                    <Link
                      href={href}
                      title={collapsed ? label : undefined}
                      aria-current={isActive(pathname, href) ? 'page' : undefined}
                      className={cn(
                        'relative flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-text-muted transition-colors',
                        'hover:bg-muted hover:text-text',
                        collapsed && 'justify-center px-0',
                        isActive(pathname, href) &&
                          'bg-brand-soft font-medium text-brand hover:bg-brand-soft hover:text-brand',
                      )}
                    >
                      <Icon size={16} className="shrink-0" aria-hidden />
                      {!collapsed && <span className="truncate">{label}</span>}
                      {href === '/alerts' && outstandingAlerts > 0 && (
                        <AlertCount n={outstandingAlerts} collapsed={collapsed} />
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-border p-2">
        <ThemeToggle collapsed={collapsed} />
      </div>
    </aside>
  );
}

/**
 * How many alerts are waiting, on the one nav entry that can act on it.
 *
 * The count is the product's reason to be opened tomorrow, and until now it was
 * legible only on the overview — so anybody who landed anywhere else had no way
 * to know anything was waiting. Zero renders nothing rather than a `0`: a badge
 * that is always on is the badge nobody reads, which is `outbox.ts`'s rule about
 * a permanently-lit indicator.
 *
 * Collapsed, it is a dot on the rail with the count in the accessible name,
 * because a two-digit pill inside a 64px icon rail is illegible and a truncated
 * one would be a wrong number.
 */
function AlertCount({ n, collapsed }: { n: number; collapsed: boolean }) {
  const label = `${n} outstanding ${n === 1 ? 'alert' : 'alerts'}`;
  if (collapsed) {
    return (
      <span
        aria-label={label}
        title={label}
        className="absolute right-3 top-1.5 h-2 w-2 rounded-full bg-bad ring-2 ring-panel"
      />
    );
  }
  return (
    <span
      aria-label={label}
      className="tabular ml-auto rounded-full bg-bad-soft px-1.5 py-0.5 text-[11px] font-semibold text-bad"
    >
      {n > 99 ? '99+' : n}
    </span>
  );
}

/**
 * Exact match, except for section roots that own a subtree.
 *
 * `/travel` must not light up on `/travel/approvals` — they are siblings in the
 * nav, and two entries highlighted at once tells you less than none. But
 * `/shows` should stay lit while you are five tabs deep in a show, because that
 * is where you are.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  if (href === '/shows') return pathname === '/shows' || pathname.startsWith('/shows/');
  return pathname === href;
}
