import { setBellSound } from '../lib/bellSound';
import { setTheme, usePref, useTheme } from '../lib/prefs';
import { Icon } from './Icon';
import { Segmented } from './Segmented';

/** Paper / After Hours. `icon` for the header, `labeled` (segmented) for menus and settings. */
export function ThemeToggle({ variant = 'icon' }: { variant?: 'icon' | 'labeled' }) {
  const theme = useTheme();
  if (variant === 'labeled') {
    return (
      <Segmented
        label="Theme"
        size="sm"
        value={theme}
        onChange={setTheme}
        options={[
          { value: 'paper', label: 'Paper' },
          { value: 'after-hours', label: 'After hours' },
        ]}
      />
    );
  }
  const next = theme === 'paper' ? 'after-hours' : 'paper';
  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      onClick={() => setTheme(next)}
      aria-label={next === 'after-hours' ? 'Switch to the After Hours (dark) theme' : 'Switch to the Paper (light) theme'}
      title={next === 'after-hours' ? 'After hours' : 'Paper'}
    >
      <Icon name={theme === 'paper' ? 'moon' : 'sun'} size={18} />
    </button>
  );
}

/** Bell sound: off by default; the click itself unlocks audio. */
export function SoundToggle({ className = 'toggle' }: { className?: string }) {
  const [on] = usePref('sound');
  return (
    <button type="button" className={className} aria-pressed={on} onClick={() => setBellSound(!on)}>
      <Icon name={on ? 'sound' : 'mute'} size={16} />
      <span>{on ? 'Sound on' : 'Sound off'}</span>
    </button>
  );
}

/** Screen-reader burn announcements (throttled, polite). Off by default. */
export function AnnounceToggle({ className = 'toggle' }: { className?: string }) {
  const [on, set] = usePref('announce');
  return (
    <button type="button" className={className} aria-pressed={on} onClick={() => set(!on)}>
      <Icon name="announce" size={16} />
      <span>{on ? 'Announcing burns' : 'Announce burns'}</span>
    </button>
  );
}
