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
  const move = (dir: 1 | -1) => {
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + dir + options.length) % options.length];
    if (next) onChange(next.value);
  };
  return (
    <div
      className={`segmented segmented--${size}`}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(-1);
        else return;
        e.preventDefault();
        const group = e.currentTarget;
        requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
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
