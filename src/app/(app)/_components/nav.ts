import {
  Boxes,
  CalendarDays,
  ClipboardCheck,
  Inbox,
  LifeBuoy,
  LayoutDashboard,
  Luggage,
  MessagesSquare,
  BellRing,
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
  Scale,
  UserRound,
  Wallet,
} from 'lucide-react';

/**
 * The one list of screens this app has, read by two things.
 *
 * It lived inside `sidebar.tsx` until the overview was found to be advertising
 * the product as it stood at step 8 — a hand-written bullet list of seven
 * capabilities, beside a nav that had grown to twenty-three entries over
 * sixteen steps, with nothing able to fail when the two disagreed. That is
 * `alerts/store.ts`'s `SOURCE_LABEL` bug in prose: a second copy of an enum,
 * correct on the day it was written and quietly wrong afterwards.
 *
 * So `does` is **required**. A new screen cannot be added to the navigation
 * without saying, in one sentence, what a person does there — and the overview
 * renders those sentences rather than keeping its own. The compiler is what
 * makes that true, exactly as `ENGINE_NOUN` does for the alert engines.
 *
 * This file is deliberately free of `'use client'` and of every React import
 * beyond the icon components themselves, so a Server Component may read it.
 */

export type NavItem = {
  href: string;
  label: string;
  Icon: typeof LayoutDashboard;
  /**
   * What somebody does on this screen, in the second person, for the overview's
   * "What you can do here". Page copy, not a doc comment: it is addressed to
   * whoever lives with the screen rather than to whoever maintains it.
   */
  does: string;
  adminOnly?: boolean;
  /**
   * Travel Manager and Admin. Not the same gate as `adminOnly`, and the
   * difference is §3's line rather than a convenience: a true-cost figure is
   * every colleague's fare added up, which is the thing `travelerScope` narrows
   * a Member's own queries to avoid showing them.
   */
  approverOnly?: boolean;
};

export type NavGroup = { label: string; items: NavItem[] };

/**
 * Still one entry per screen that exists. A nav advertising unbuilt pages reads
 * as a broken product rather than an unfinished one.
 */
export const GROUPS: NavGroup[] = [
  {
    label: 'Plan',
    items: [
      {
        href: '/',
        label: 'Overview',
        Icon: LayoutDashboard,
        does: 'See what is owed to you and what is coming up',
      },
      // Second, and above everything that plans a show, because it is the only
      // entry here somebody opens while standing up. It is also the one screen
      // that has to be found *before* it is needed — an offline page nobody
      // visited on wifi is an offline page that is not there.
      {
        href: '/day-of',
        label: 'Day of',
        Icon: ScanLine,
        does: 'Work the booth with no signal — your shift, the crates, and lead capture',
      },
      // First in Plan rather than last in Travel: §1's corollary is that a
      // Member should barely have to learn this app, and for them this screen
      // is most of it.
      {
        href: '/assistant',
        label: 'Assistant',
        Icon: MessagesSquare,
        does: 'Ask about your shows and trips in plain language',
      },
      {
        href: '/shows',
        label: 'Shows',
        Icon: CalendarDays,
        does: 'Propose a show, and plan the ones you have committed to',
      },
      // Above Readiness because it is the screen a person opens first: seven
      // engines write to it and, until step 17, nothing read any of them.
      {
        href: '/alerts',
        label: 'Alerts',
        Icon: BellRing,
        does: 'Read what needs doing, and when it stops being true',
      },
      {
        href: '/readiness',
        label: 'Readiness',
        Icon: ClipboardCheck,
        does: 'Track checklists and the deadlines a service manual sets',
      },
      // Beside True cost rather than under Travel: they are the two halves of
      // §8's question, and both are a number that has to say what it is missing.
      {
        href: '/leads',
        label: 'Leads',
        Icon: UserPlus,
        does: 'Capture leads at the booth, import a scanner file, and see who has not',
      },
      {
        href: '/cost',
        label: 'True cost',
        Icon: Receipt,
        approverOnly: true,
        does: 'See what a show really cost, and what is still missing from the figure',
      },
      // Last in Plan, and after both of its inputs, because that is what it is:
      // cost divided by leads. An ROI figure contains a cost figure, so it
      // inherits the cost gate rather than choosing a new one.
      {
        href: '/roi',
        label: 'ROI',
        Icon: TrendingUp,
        approverOnly: true,
        does: 'Weigh cost against the pipeline a show sourced',
      },
    ],
  },
  {
    label: 'Travel',
    items: [
      {
        href: '/itinerary',
        label: 'My itinerary',
        Icon: Luggage,
        does: 'See your own flights, room and shifts for each show',
      },
      {
        href: '/travel',
        label: 'Travel',
        Icon: Plane,
        does: 'Request a trip and watch the booking agent price it against policy',
      },
      {
        href: '/flights',
        label: 'Flight board',
        Icon: Radar,
        does: 'Follow booked legs, and see a delay that costs somebody their move-in',
      },
      {
        href: '/shipping',
        label: 'Shipping',
        Icon: PackageSearch,
        does: 'Track crates and packages, and confirm one reached the booth',
      },
      {
        href: '/assets',
        label: 'Assets',
        Icon: Boxes,
        does: 'Sign out a booth, check it back in, and count what is on the shelf',
      },
      // Everyone has an approvals page; for a Member it is their own requests
      // waiting on somebody else, which is worth an entry — "where has my
      // request got to" is the question the queue exists to answer.
      {
        href: '/travel/approvals',
        label: 'Approvals',
        Icon: Inbox,
        does: 'See what is waiting on a person, including your own requests',
      },
      // Under Travel rather than Plan, because that is what it is about: the
      // people this app sent somewhere. Not approver-only — see
      // `lib/safety/access.ts`; a Member who has to ask permission to see who is
      // unaccounted for is a Member who goes and looks instead.
      {
        href: '/safety',
        label: 'Duty of care',
        Icon: LifeBuoy,
        does: 'Run a roll call, and see who to call first when something happens',
      },
    ],
  },
  {
    label: 'Settings',
    items: [
      // Not admin-only, like Notifications and for the same reason: these are
      // the subject's own facts, and nobody else may type them.
      {
        href: '/settings/profile',
        label: 'Your details',
        Icon: UserRound,
        does: 'Set the traveler details an airline needs before you can be ticketed',
      },
      // Not admin-only either. Where your own alerts go is yours to set — see
      // `notify/access.ts` — and hiding it from a Member would mean the one
      // person the app is meant to be almost invisible to is the one it can
      // never reach.
      {
        href: '/settings/notifications',
        label: 'Notifications',
        Icon: BellRing,
        does: 'Choose where your own alerts are sent',
      },
      {
        href: '/settings/travel-policy',
        label: 'Travel policy',
        Icon: Scale,
        adminOnly: true,
        does: 'Set the spend and schedule limits the booking agent buys within',
      },
      {
        href: '/settings/cost-centers',
        label: 'Cost centers',
        Icon: Wallet,
        adminOnly: true,
        does: 'Define where money filed in this workspace lands',
      },
      {
        href: '/settings/security',
        label: 'Security',
        Icon: ShieldCheck,
        adminOnly: true,
        does: 'Restrict which sign-in methods this organization permits',
      },
      {
        href: '/settings/intake',
        label: 'Lead intake',
        Icon: KeyRound,
        adminOnly: true,
        does: 'Issue a key so a badge scanner can post leads straight in',
      },
      {
        href: '/settings/crm',
        label: 'CRM',
        Icon: Share2,
        approverOnly: true,
        does: 'Match leads to your CRM so a show can be weighed against pipeline',
      },
    ],
  },
];

/** The one role filter, so the nav and the overview cannot disagree about it. */
export function visibleItems(
  items: NavItem[],
  { isAdmin, isApprover }: { isAdmin: boolean; isApprover: boolean },
): NavItem[] {
  return items.filter((i) => (!i.adminOnly || isAdmin) && (!i.approverOnly || isApprover));
}
