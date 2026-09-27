import { useEffect, type ComponentType } from 'react';
import { useLocation } from 'react-router';
import { WalkthroughChapter } from '../../components/Walkthrough';
import { Bellwethers } from './Bellwethers';
import { Closing } from './Closing';
import { EngineToday } from './EngineToday';
import { FeeSplit } from './FeeSplit';
import { HowItWorks } from './HowItWorks';
import { Ledger } from './Ledger';
import { Markets } from './Markets';
import { ProofCheck } from './ProofCheck';
import { Questions } from './Questions';
import { Risks } from './Risks';
import { Strategies } from './Strategies';

/**
 * The numbered chapters under the hero and tape, in page order. Each renders one <Section> and
 * takes its editorial number ("§2") from its position here, so adding a chapter renumbers the rest.
 */
const CHAPTERS: ComponentType<{ n: number }>[] = [
  Ledger,
  FeeSplit,
  HowItWorks,
  WalkthroughChapter,
  Markets,
  Strategies,
  ProofCheck,
  Bellwethers,
  Questions,
];

/** Everything below the tape: its own chunk, so the first paint only ships the hero (see Landing). */
export default function Chapters() {
  const { hash } = useLocation();

  // Deep links like /#faq: every target lives in this chunk and exists once it has rendered.
  useEffect(() => {
    if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [hash]);

  return (
    <>
      {CHAPTERS.map((Chapter, i) => (
        <Chapter key={i} n={i + 1} />
      ))}
      <Risks />
      <Closing />
      <EngineToday />
    </>
  );
}
