/**
 * Dot-matrix display numerals (Doto). Doto's punctuation is drawn as large dot clusters that read
 * as "+" at display sizes, so separators are set in the mono face instead.
 */
export function Led({ text, className = '' }: { text: string; className?: string }) {
  return (
    <span className={`led ${className}`}>
      {text.split(/([.,:])/).map((part, i) =>
        /^[.,:]$/.test(part) ? (
          <span key={i} className="led__sep">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  );
}
