/**
 * Brand constants: the single source of truth for names, copy and links used by both the engine
 * (alerts, API metadata, impersonation guard) and the web app. Code and data model are brand-neutral
 * ("protocol token", "protocol buyback"); only this module says what the brand is.
 */
export const BRAND = {
  name: 'Bellwether',
  protocolName: 'Bellwether Protocol',
  ticker: 'BELL',
  domain: 'bellwether.fun',
  tagline: 'Ring the bell on every fee.',
  pitch:
    'Launch a memecoin on Robinhood Chain and route its creator fees to Bellwether. The engine trades US-stock perps with part of every fee and buys back and burns your token with the rest. Every burn rings the bell, with a receipt.',
  links: {
    site: 'https://bellwether.fun',
    x: 'https://x.com/bellwetherfun',
    github: 'https://github.com/realdoomsman/bellwether',
  },
  /** Brand palette ("Opening Bell"); mirrored as CSS custom properties in the web app. */
  colors: {
    paper: '#F5F2EA',
    ink: '#16140F',
    night: '#0E0D0B',
    brass: '#B8862B',
    up: '#0B6B3C',
    down: '#B42318',
  },
} as const;

/** Tokens are sent here to be burned. Permanently unrecoverable. */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;
