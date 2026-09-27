export type CheckState = 'todo' | 'checking' | 'ok' | 'warn' | 'fail' | 'skipped';

const LABEL: Record<CheckState, string> = {
  todo: 'Not checked yet',
  checking: 'Checking',
  ok: 'Passed',
  warn: 'Needs attention',
  fail: 'Failed',
  skipped: 'Not checked',
};

/** 20 px status glyph for checklists: an engraved ring that is struck (scaled in) when its state resolves. */
export function CheckMark({ state }: { state: CheckState }) {
  return (
    <span className={`lw-cm lw-cm--${state}`} role="img" aria-label={LABEL[state]}>
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
        <circle className="lw-cm__ring" cx="10" cy="10" r="9" />
        {state === 'checking' && <path className="lw-cm__arc" d="M10 1a9 9 0 0 1 9 9" />}
        {state === 'ok' && (
          <g className="lw-cm__struck">
            <circle className="lw-cm__disc" cx="10" cy="10" r="9.75" />
            <path className="lw-cm__glyph" d="m5.8 10.4 2.8 2.8 5.6-6" />
          </g>
        )}
        {state === 'fail' && <path className="lw-cm__struck lw-cm__glyph" d="m6.8 6.8 6.4 6.4m0-6.4-6.4 6.4" />}
        {state === 'warn' && <path className="lw-cm__struck lw-cm__glyph" d="M10 5.6v5.6m0 2.6v.6" />}
        {state === 'skipped' && <path className="lw-cm__glyph" d="M6.5 10h7" />}
      </svg>
    </span>
  );
}
