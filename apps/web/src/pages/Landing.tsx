import { useEffect, type ComponentType } from 'react';
import { useLocation } from 'react-router';
import { Tape } from '../components/Tape';
import { WalkthroughChapter } from '../components/Walkthrough';
import { useTitle } from '../lib/hooks';
import '../styles/landing.css';
import { Bellwethers } from './landing/Bellwethers';
import { Closing } from './landing/Closing';
import { EngineToday } from './landing/EngineToday';
import { FeeSplit } from './landing/FeeSplit';
import { Hero } from './landing/Hero';
import { HowItWorks } from './landing/HowItWorks';
import { Ledger } from './landing/Ledger';
import { Markets } from './landing/Markets';
import { ProofCheck } from './landing/ProofCheck';
import { Questions } from './landing/Questions';
import { Risks } from './landing/Risks';
import { Strategies } from './landing/Strategies';

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

export default function Landing() {
  useTitle(null);
  const { hash } = useLocation();

  // Deep links like /#faq: the section exists on first render, so a single scroll is enough.
  useEffect(() => {
    if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [hash]);

  return (
    <div className="ld">
      <Hero />
      <Tape className="ld__tape" />
      <div className="ld__after-tape" data-today-start aria-hidden="true" />
      {CHAPTERS.map((Chapter, i) => (
        <Chapter key={i} n={i + 1} />
      ))}
      <Risks />
      <Closing />
      <EngineToday />
    </div>
  );
}
