import type { LaunchpadId, LaunchpadInfo } from '@bellwether/shared';

/** "0.0005 ETH + gas" / "Gas only": what launching costs on the launchpad itself. */
export function launchFeeText(lp: LaunchpadInfo): string {
  return lp.launchFeeEth === null ? 'Gas only' : `${lp.launchFeeEth} ETH + gas`;
}

/** The launchpad's own logomark, printed in ink (one-color) on a paper tile so it sits in both themes. */
export function LaunchpadMark({ id, size = 44 }: { id: LaunchpadId; size?: number }) {
  return (
    <span className={`lw-mark lw-mark--${id}`} style={{ width: size, height: size }} aria-hidden="true">
      <span className="lw-mark__logo" />
    </span>
  );
}
