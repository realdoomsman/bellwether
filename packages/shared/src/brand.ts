/**
 * Brand constants: the single source of truth for names, copy and links used by both the engine
 * (alerts, API metadata, impersonation guard) and the web app. Code and data model are brand-neutral
 * ("protocol token", "protocol buyback"); only this module says what the brand is.
 */
export const BRAND = {
  name: 'Stepup',
  protocolName: 'Stepup Protocol',
  ticker: 'STEP',
  domain: 'stepup.fun',
  tagline: 'Every fee is a step up.',
  pitch:
    'Creator fees trade tokenized-stock perps. Every fee and every profitable trade buys back and burns your token, so its floor only steps up.',
  links: {
    site: 'https://stepup.fun',
    x: 'https://x.com/stepupdotfun',
    github: 'https://github.com/realdoomsman/stepup',
  },
  /** Brand palette; mirrored as CSS custom properties in the web app. */
  colors: {
    ink: '#0B0B0C',
    paper: '#F4F1EA',
    amber: '#FFB23F',
    amberDeep: '#E08A00',
    up: '#2BD67B',
    down: '#FF5A5F',
  },
} as const;

/** Tokens are sent here to be burned. Permanently unrecoverable. */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;
