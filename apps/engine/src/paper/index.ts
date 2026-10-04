/**
 * Paper integrations: every read goes to the real networks (via the read-only integrations),
 * every write is simulated and returns `paper:<id>` refs. Wallet balances are derived from the
 * ledger plus the paper venue, so paper reconciliation checks the simulation's own consistency.
 */
import { LAUNCHPAD_IDS, type Address, type LaunchpadId } from '@bellwether/shared';
import { kvGet, kvSet, type Db } from '../db.ts';
import type { Ledger } from '../ledger.ts';
import type { Bridge, Dex, Integrations, Launchpad, TokenData, Wallet } from '../ports.ts';
import { getToken } from '../tokens.ts';
import { gweiToEth, weiToEth } from '../units.ts';
import { DEMO_SUPPLY, applyDemoSwap, demoClaimable, demoPool, demoPriceEth, demoQuote, markDemoClaimed } from './demo.ts';
import { paperRef } from './refs.ts';
import { createPaperVenue, paperVenueEquity, paperVenueState, setPaperVenueState } from './venue.ts';

/** Relay-style ETH→USDC haircut applied by the paper bridge. */
export const PAPER_BRIDGE_HAIRCUT = 0.003;

export interface PaperDeps {
  db: Db;
  ledger: Ledger;
  clock: () => number;
  /** ETH the simulated RHC wallet keeps on top of the ledger for gas. */
  rhcGasReserveEth: number;
}

export function createPaperIntegrations(readOnly: Integrations, deps: PaperDeps): Integrations {
  const { db, clock } = deps;
  const isDemo = (token: Address) => getToken(db, token)?.demo === true;
  const marketVenue = readOnly.venues[0];
  if (!marketVenue) throw new Error('paper mode needs a read-only venue for market data');

  const launchpads = Object.fromEntries(
    LAUNCHPAD_IDS.map((id) => [id, paperLaunchpad(readOnly.launchpads[id], db, clock, isDemo)]),
  ) as Record<LaunchpadId, Launchpad>;

  const dex: Dex = {
    async quote(token, amountInWei) {
      if (isDemo(token)) return { amountOut: demoQuote(db, token, amountInWei), feeTier: 3000 };
      return readOnly.dex.quote(token, amountInWei);
    },
    // Paper swaps price nothing against a reference: no V4 samples are needed.
    async spotPrice() {
      return null;
    },
    async buyAndBurn(token, amountInWei) {
      const q = await dex.quote(token, amountInWei);
      if (!q || q.amountOut <= 0n) throw new Error('paper dex: no liquidity');
      if (isDemo(token)) applyDemoSwap(db, token, amountInWei, q.amountOut);
      return {
        amountInWei,
        amountOut: q.amountOut,
        swapTx: { chain: 'rhc', hash: paperRef() },
        burnTx: { chain: 'rhc', hash: paperRef() },
        gasWei: 0n,
      };
    },
    async burnHeld(_token, amount) {
      // Paper buybacks always burn, so the simulated wallet never holds bought tokens.
      return { amount, tx: { chain: 'rhc', hash: paperRef() }, gasWei: 0n };
    },
    // Paper txs settle synchronously and never leave a broadcast to resolve.
    async lookupTx() {
      return { status: 'dropped' };
    },
  };

  const bridge: Bridge = {
    async quote(amountWei) {
      const ethUsd = await readOnly.prices.ethUsd();
      return { expectedUsdc: weiToEth(amountWei) * ethUsd * (1 - PAPER_BRIDGE_HAIRCUT), impactPct: PAPER_BRIDGE_HAIRCUT };
    },
    async ethToUsdc(amountWei, _maxImpactPct, _minUsdc, hooks) {
      const q = (await bridge.quote(amountWei))!;
      hooks?.prepared?.({ requestId: paperRef(), expectedUsdc: q.expectedUsdc });
      const tx = { chain: 'rhc' as const, hash: paperRef() };
      const state = paperVenueState(db);
      setPaperVenueState(db, { ...state, arbitrumUsdc: state.arbitrumUsdc + q.expectedUsdc });
      hooks?.broadcast?.(tx);
      return { expectedUsdc: q.expectedUsdc, tx, gasWei: 0n };
    },
    // A simulated deposit credits the paper venue in the same step that records its hash.
    async depositStatus({ hash }) {
      return hash === null ? { state: 'unknown' } : { state: 'landed', tx: { chain: 'rhc', hash }, gasWei: 0n, filled: true };
    },
  };

  const venue = createPaperVenue({ db, market: marketVenue, prices: readOnly.prices, clock });

  const tokenData: TokenData = {
    async market(token) {
      if (!isDemo(token)) return readOnly.tokenData.market(token);
      const ethUsd = await readOnly.prices.ethUsd();
      const priceUsd = demoPriceEth(db, token) * ethUsd;
      return {
        priceUsd,
        change24hPct: null,
        fdvUsd: priceUsd * Number(DEMO_SUPPLY / 10n ** 18n),
        volume24hUsd: null,
        liquidityUsd: 2 * weiToEth(demoPool(db, token).ethWei) * ethUsd,
      };
    },
    async candles(token, interval, limit) {
      return isDemo(token) ? [] : readOnly.tokenData.candles(token, interval, limit);
    },
  };

  const wallet: Wallet = {
    address: readOnly.wallet.address,
    async balances() {
      const t = deps.ledger.totals();
      const state = paperVenueState(db);
      return {
        rhcEth: gweiToEth(t.trading_eth + t.token_buyback_eth + t.protocol_buyback_eth) + deps.rhcGasReserveEth,
        arbitrumEth: 0,
        arbitrumUsdc: state.arbitrumUsdc,
        venueEquityUsd: await paperVenueEquity(db, venue),
      };
    },
    // Every paper buy is burned; the simulated wallet never holds tokens.
    tokenBalance: async () => 0n,
  };

  return {
    launchpads,
    dex,
    venues: [venue],
    bridge,
    prices: readOnly.prices,
    tokenData,
    wallet,
    discovery: readOnly.discovery,
  };
}

interface RealClaimState {
  /** Real claimable already booked as paper claims; only growth beyond it is claimable again. */
  baselineWei: string;
}

function paperLaunchpad(real: Launchpad, db: Db, clock: () => number, isDemo: (t: Address) => boolean): Launchpad {
  const claimable = async (token: Address): Promise<bigint | null> => {
    if (isDemo(token)) return demoClaimable(db, token, clock());
    const onChain = await real.claimable(token);
    if (onChain === null) return null;
    const baseline = BigInt(kvGet<RealClaimState>(db, `paper.claim.${token}`)?.baselineWei ?? '0');
    // A real claim by someone else resets the on-chain counter below our baseline.
    return onChain >= baseline ? onChain - baseline : onChain;
  };

  return {
    id: real.id,
    async verify(token) {
      const t = getToken(db, token);
      if (!t?.demo) return real.verify(token);
      return {
        ok: true,
        failure: null,
        detail: 'Paper demo token',
        deployer: t.deployer,
        metadata: { name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: t.totalSupply ?? DEMO_SUPPLY, image: t.image },
      };
    },
    claimable,
    async claim(token) {
      const amountWei = await claimable(token);
      if (amountWei === null || amountWei <= 0n) return null;
      if (isDemo(token)) {
        markDemoClaimed(db, token, clock());
      } else {
        const onChain = (await real.claimable(token)) ?? 0n;
        kvSet(db, `paper.claim.${token}`, { baselineWei: onChain.toString() } satisfies RealClaimState);
      }
      return { amountWei, gasWei: 0n, tx: { chain: 'rhc', hash: paperRef() }, tokensBurned: null };
    },
  };
}
