/**
 * Brand constants. Single source of truth for names, copy and links used by
 * both the engine (notifications, API metadata) and the web app.
 */
export const BRAND = {
  name: 'Floor',
  protocolName: 'Floor Protocol',
  ticker: 'FLOOR',
  domain: 'floor.fun',
  tagline: 'Memecoins with a trading floor.',
  pitch:
    'Creator fees trade tokenized-stock perps. Every fee and every profitable trade buys back and burns your token. The floor only goes one way.',
  links: {
    site: 'https://floor.fun',
    x: 'https://x.com/floordotfun',
    github: 'https://github.com/floordotfun/floor',
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
