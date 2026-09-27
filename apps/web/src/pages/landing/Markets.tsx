import { Link } from 'react-router';
import { Board } from '../../components/Board';
import { Arrow, Muted, Section } from '../../components/Primitives';

/** §4 The board: every stock perp a token can trade, typeset like the stock table it is. */
export function Markets({ n }: { n: number }) {
  return (
    <Section
      id="board"
      n={n}
      label="The board"
      className="ld-markets"
      title={
        <>
          Your token picks a stock. <Muted>The engine trades its perp.</Muted>
        </>
      }
      lede="Live prices from Hyperliquid’s equity perps, with the engine’s current entry signal for each. Sort any column."
      aside={
        <Link to="/launch?step=2" className="tertiary">
          <Arrow>Pick a market for your token</Arrow>
        </Link>
      }
    >
      <Board />
    </Section>
  );
}
