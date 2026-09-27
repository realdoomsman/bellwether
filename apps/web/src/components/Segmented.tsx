/** Single-choice button group (radio semantics, arrow-key navigation). */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  size = 'md',
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
}) {
  // Focus moves to the new option directly: when `value` comes from the URL, the re-render that
  // marks it checked can land after the next frame.
  const move = (dir: 1 | -1, group: HTMLElement) => {
    const i = options.findIndex((o) => o.value === value);
    const n = (i + dir + options.length) % options.length;
    const next = options[n];
    if (!next) return;
    onChange(next.value);
    group.querySelectorAll<HTMLElement>('[role="radio"]')[n]?.focus();
  };
  return (
    <div
      className={`segmented segmented--${size}`}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(1, e.currentTarget);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(-1, e.currentTarget);
        else return;
        e.preventDefault();
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className="segmented__opt"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
