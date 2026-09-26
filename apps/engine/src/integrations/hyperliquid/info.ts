/** Hyperliquid info API (read-only, unauthenticated) with small caches. */
import type { Address } from 'viem';
import { fetchJson, TtlCache } from '../http.ts';
import { builderAssetId } from './format.ts';

export interface HlAsset {
  /** Venue-native coin, e.g. `xyz:AAPL`. */
  coin: string;
  symbol: string;
  assetId: number;
  szDecimals: number;
  maxLeverage: number;
  isDelisted: boolean;
  markPx: number;
  prevDayPx: number;
}

export interface HlDex {
  name: string;
  /** Position in `perpDexs` (0 is the validator-operated default dex). */
  index: number;
  assets: HlAsset[];
  /** Spot token index of the collateral, e.g. 0 = USDC. */
  collateralToken: number;
}

export interface HlPosition {
  coin: string;
  szi: string;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  marginUsed: string;
  liquidationPx: string | null;
  leverage: { type: 'isolated' | 'cross'; value: number };
}

export interface HlClearinghouse {
  marginSummary: { accountValue: string };
  withdrawable: string;
  assetPositions: { position: HlPosition }[];
}

export interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: 'A' | 'B';
  time: number;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  fee: string;
  feeToken: string;
}

export interface HlCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

interface RawMeta {
  universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[];
  collateralToken: number;
}
interface RawCtx {
  markPx: string | null;
  midPx: string | null;
  prevDayPx: string;
}

const DEX_TTL_MS = 10_000;
const DEX_LIST_TTL_MS = 10 * 60_000;

/** Only this host is testnet; any other URL (mainnet or a mainnet proxy) signs for mainnet. */
const TESTNET_API_HOST = 'api.hyperliquid-testnet.xyz';

export class HlInfo {
  readonly apiUrl: string;
  /** Selects the L1 signing source (`a`/`b`) and `hyperliquidChain` (`Mainnet`/`Testnet`). */
  readonly isMainnet: boolean;
  readonly #dexIndex = new TtlCache<number>(DEX_LIST_TTL_MS);
  readonly #dex = new TtlCache<HlDex>(DEX_TTL_MS);
  readonly #spotTokens = new TtlCache<string>(DEX_LIST_TTL_MS);
  readonly #mids = new TtlCache<Record<string, string>>(DEX_TTL_MS);

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl;
    this.isMainnet = new URL(apiUrl).hostname !== TESTNET_API_HOST;
  }

  post<T>(body: Record<string, unknown>): Promise<T> {
    return fetchJson<T>(`Hyperliquid info ${String(body.type)}`, `${this.apiUrl}/info`, { body });
  }

  /** Universe + live marks. `fresh` bypasses the cache (order pricing must not use a stale mark). */
  dex(name: string, fresh = false): Promise<HlDex> {
    const load = async (): Promise<HlDex> => {
      const [index, [meta, ctxs]] = await Promise.all([
        this.#dexIndexOf(name),
        this.post<[RawMeta, RawCtx[]]>({ type: 'metaAndAssetCtxs', dex: name }),
      ]);
      const assets = meta.universe.map((u, i): HlAsset => {
        const ctx = ctxs[i];
        return {
          coin: u.name,
          symbol: u.name.startsWith(`${name}:`) ? u.name.slice(name.length + 1) : u.name,
          assetId: builderAssetId(index, i),
          szDecimals: u.szDecimals,
          maxLeverage: u.maxLeverage,
          isDelisted: u.isDelisted === true,
          markPx: Number(ctx?.markPx ?? ctx?.midPx ?? 0) || 0,
          prevDayPx: Number(ctx?.prevDayPx ?? 0) || 0,
        };
      });
      return { name, index, assets, collateralToken: meta.collateralToken };
    };
    return fresh ? this.#dex.refresh(name, load) : this.#dex.get(name, load);
  }

  #dexIndexOf(name: string): Promise<number> {
    return this.#dexIndex.get(name, async () => {
      const dexes = await this.post<({ name: string } | null)[]>({ type: 'perpDexs' });
      const index = dexes.findIndex((d) => d?.name === name);
      if (index < 1) throw new Error(`Hyperliquid perp dex "${name}" is not listed in perpDexs`);
      return index;
    });
  }

  /** `sendAsset` token identifier (`name:tokenId`) of a spot token index. */
  spotTokenId(index: number): Promise<string> {
    return this.#spotTokens.get(String(index), async () => {
      const meta = await this.post<{ tokens: { index: number; name: string; tokenId: string }[] }>({ type: 'spotMeta' });
      const token = meta.tokens.find((t) => t.index === index);
      if (!token) throw new Error(`Hyperliquid spot token ${index} not found`);
      return `${token.name}:${token.tokenId}`;
    });
  }

  allMids(): Promise<Record<string, string>> {
    return this.#mids.get('', () => this.post<Record<string, string>>({ type: 'allMids' }));
  }

  /** `dex` null = the default (validator-operated) perp dex. */
  clearinghouse(user: Address, dex: string | null): Promise<HlClearinghouse> {
    return this.post<HlClearinghouse>({ type: 'clearinghouseState', user, ...(dex ? { dex } : {}) });
  }

  userFillsSince(user: Address, startTime: number): Promise<HlFill[]> {
    return this.post<HlFill[]>({ type: 'userFillsByTime', user, startTime, aggregateByTime: false });
  }

  candles(coin: string, interval: string, startTime: number, endTime: number): Promise<HlCandle[]> {
    return this.post<HlCandle[]>({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } });
  }
}
