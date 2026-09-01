'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Boxes,
  CalendarDays,
  ClipboardCheck,
  Inbox,
  LayoutDashboard,
  Luggage,
  MessagesSquare,
  BellRing,
  PanelLeftClose,
  PanelLeftOpen,
  PackageSearch,
  Plane,
  Receipt,
  Radar,
  ScanLine,
  TrendingUp,
  ShieldCheck,
  KeyRound,
  Share2,
  UserPlus,
} from 'lucide-react';
import { cn } from './cn';
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
 * The groups are not decoration either. Show detail already nests six tabs under
 * one entry, so orientation is the thing to get right, and the active state is
 * therefore a real contrast change — a tinted fill, brand text and a left bar —
 * rather than the subtle shift dense products reach for and users miss.
 */

type Item = {
  href: string;
  label: string;
  Icon: typeof LayoutDashboard;
  adminOnly?: boolean;
  /**
   * Travel Manager and Admin. Not the same gate as `adminOnly`, and the
   * difference is §3's line rather than a convenience: a true-cost figure is
   * every colleague's fare added up, which is the thing `travelerScope` narrows
   * a Member's own queries to avoid showing them.
   */
  approverOnly?: boolean;
};
type Group = { label: string; items: Item[] };

/**
 * Still one entry per screen that exists. A nav advertising unbuilt pages reads
 * as a broken product rather than an unfinished one.
 */
const GROUPS: Group[] = [
  {
    label: 'Plan',
    items: [
      { href: '/', label: 'Overview', Icon: LayoutDashboard },
      // Second, and above everything that plans a show, because it is the only
      // entry here somebody opens while standing up. It is also the one screen
      // that has to be found *before* it is needed — an offline page nobody
      // visited on wifi is an offline page that is not there.
      { href: '/day-of', label: 'Day of', Icon: ScanLine },
      // First in Plan rather than last in Travel: §1's corollary is that a
      // Member should barely have to learn this app, and for them this screen
      // is most of it.
      { href: '/assistant', label: 'Assistant', Icon: MessagesSquare },
      { href: '/shows', label: 'Shows', Icon: CalendarDays },
      // Above Readiness because it is the screen a person opens first: five
      // engines write to it and, until step 17, nothing read any of them.
      { href: '/alerts', label: 'Alerts', Icon: BellRing },
      { href: '/readiness', label: 'Readiness', Icon: ClipboardCheck },
      // Beside True cost rather than under Travel: they are the two halves of
      // §8's question, and both are a number that has to say what it is missing.
      { href: '/leads', label: 'Leads', Icon: UserPlus },
      { href: '/cost', label: 'True cost', Icon: Receipt, approverOnly: true },
      // Last in Plan, and after both of its inputs, because that is what it is:
      // cost divided by leads. An ROI figure contains a cost figure, so it
      // inherits the cost gate rather than choosing a new one.
      { href: '/roi', label: 'ROI', Icon: TrendingUp, approverOnly: true },
    ],
  },
  {
    label: 'Travel',
    items: [
      { href: '/itinerary', label: 'My itinerary', Icon: Luggage },
      { href: '/travel', label: 'Travel', Icon: Plane },
      { href: '/flights', label: 'Flight board', Icon: Radar },
      { href: '/shipping', label: 'Shipping', Icon: PackageSearch },
      { href: '/assets', label: 'Assets', Icon: Boxes },
      // Everyone has an approvals page; for a Member it is their own requests
      // waiting on somebody else, which is worth an entry — "where has my
      // request got to" is the question the queue exists to answer.
      { href: '/travel/approvals', label: 'Approvals', Icon: Inbox },
    ],
  },
  {
    label: 'Settings',
    items: [
      { href: '/settings/security', label: 'Security', Icon: ShieldCheck, adminOnly: true },
      { href: '/settings/intake', label: 'Lead intake', Icon: KeyRound, adminOnly: true },
      { href: '/settings/crm', label: 'CRM', Icon: Share2, approverOnly: true },
    ],
  },
];

export function Sidebar({ isAdmin, isApprover }: { isAdmin: boolean; isApprover: boolean }) {
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
          const items = group.items.filter(
            (i) => (!i.adminOnly || isAdmin) && (!i.approverOnly || isApprover),
          );
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
                        'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-text-muted transition-colors',
                        'hover:bg-muted hover:text-text',
                        collapsed && 'justify-center px-0',
                        isActive(pathname, href) &&
                          'bg-brand-soft font-medium text-brand hover:bg-brand-soft hover:text-brand',
                      )}
                    >
                      <Icon size={16} className="shrink-0" aria-hidden />
                      {!collapsed && <span className="truncate">{label}</span>}
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
