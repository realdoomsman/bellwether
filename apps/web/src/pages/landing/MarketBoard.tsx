import { Link } from 'react-router';
import { Board } from '../../components/Board';

/** Landing's market table: the shared Board plus the route into the launch wizard. */
export function MarketBoard() {
  return (
    <section className="hero-board" aria-labelledby="board-title">
      <h2 id="board-title" className="label">
        The board
      </h2>
      <Board limit={8} />
      <Link to="/launch" className="tertiary">
        Pick a market for your token <span className="arrow">→</span>
      </Link>
    </section>
  );
}
