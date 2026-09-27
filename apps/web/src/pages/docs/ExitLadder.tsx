import type { ExitLadder as Ladder } from '@bellwether/shared';
import type { CSSProperties } from 'react';
import { pct, pct0 } from '../../lib/format';

/** Sub-percent underlying moves keep one decimal. */
const move = (n: number) => pct(n, { digits: 1 });

/**
 * The exit ladder drawn on the underlying's price axis, from the same constants the engine runs.
 * Decorative: the ordered list next to it carries the same facts for assistive tech.
 */
export function ExitLadderDiagram({ ladder }: { ladder: Ladder }) {
  const axisMax = ladder.tp2Move + ladder.trailPullback * 2;
  const x = (m: number) => ({ '--x': m / axisMax }) as CSSProperties;
  const first = ladder.breakevenArmMove === ladder.tp1Move ? [`Stop to breakeven`, `take ${pct0(ladder.tp1Fraction)}`] : [`Take ${pct0(ladder.tp1Fraction)}`];
  const ticks = Array.from({ length: Math.floor(axisMax / 0.0025 + 1e-9) + 1 }, (_, i) => i * 0.0025);
  return (
    <figure className="ladder" aria-hidden="true">
      <div className="ladder__plot">
        <span className="ladder__axis" />
        {ticks.map((t) => (
          <span key={t} className={`ladder__tick${t % 0.005 < 1e-9 ? ' ladder__tick--major' : ''}`} style={x(t)}>
            {t % 0.005 < 1e-9 && <span className="ladder__tick-label num">{t === 0 ? 'Entry' : `+${move(t)}`}</span>}
          </span>
        ))}
        {ladder.breakevenArmMove !== ladder.tp1Move && (
          <span className="ladder__mark" style={x(ladder.breakevenArmMove)}>
            <span className="ladder__note">Stop to breakeven</span>
          </span>
        )}
        <span className="ladder__mark" style={x(ladder.tp1Move)}>
          <span className="ladder__note">
            {first.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        </span>
        <span className="ladder__mark" style={x(ladder.tp2Move)}>
          <span className="ladder__note">
            <span>Take {pct0(ladder.tp2Fraction)}</span>
            <span>of the rest</span>
          </span>
        </span>
        <span className="ladder__trail" style={{ ...x(axisMax - ladder.trailPullback), '--w': ladder.trailPullback / axisMax } as CSSProperties}>
          <span className="ladder__trail-label">Trails {move(ladder.trailPullback)} behind the best price</span>
        </span>
      </div>
    </figure>
  );
}
