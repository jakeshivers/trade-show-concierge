'use client';

import { useEffect } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from './cn';
import { setPref, usePref } from './pref';

/**
 * Light / dark / system.
 *
 * Three states, not two, because "follow the system" is a real answer and a
 * two-way toggle silently destroys it the first time it is pressed — the app
 * would stop tracking a laptop that switches at sunset, with nothing on screen
 * saying it had.
 *
 * `null` in storage *is* system: absence is the state, so clearing the key is
 * how you go back, and a fresh browser starts where the app started.
 * `globals.css` reads the `.dark` class, and the script in the root layout
 * applies it before first paint; this component keeps the two in step.
 */
type Choice = 'light' | 'dark' | 'system';

const OPTIONS: { value: Choice; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

export function ThemeToggle({ collapsed }: { collapsed?: boolean }) {
  const stored = usePref('theme', 'system');
  const choice: Choice = stored === 'light' || stored === 'dark' ? stored : 'system';

  // Follow the system while the choice *is* system, so a laptop that flips at
  // sunset flips the app with it without a reload.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = choice === 'dark' || (choice === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [choice]);

  function pick(next: Choice) {
    setPref('theme', next === 'system' ? null : next);
  }

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className={cn(
        'flex gap-0.5 rounded-lg border border-border bg-panel p-0.5',
        collapsed && 'flex-col',
      )}
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => pick(value)}
          aria-pressed={choice === value}
          title={label}
          className={cn(
            'flex flex-1 items-center justify-center rounded-md p-1.5 text-text-muted transition-colors',
            'hover:bg-muted hover:text-text',
            choice === value && 'bg-brand-soft text-brand hover:bg-brand-soft',
          )}
        >
          <Icon size={15} aria-hidden />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
