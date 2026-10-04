import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, isAddress, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, EngineMode, WorkerId } from '@bellwether/shared';
import type { AlertConfig } from './alerts.ts';
import { DEFAULT_RELAY_API_URL, DEFAULT_RELAY_DEPOSIT_CONTRACTS } from './integrations/relay.ts';
import type { Hex, LiveConfig, NetworkConfig } from './ports.ts';

export interface RiskConfig {
  /** Max slippage for perp orders, basis points. */
  slippageBps: number;
  /** Max slippage for DEX buybacks, basis points. */
  buybackSlippageBps: number;
  /** Refuse a buyback whose execution price is worse than the pool TWAP by more than this, basis points. */
  buybackMaxTwapDeviationBps: number;
  /** Refuse a buyback whose own price impact exceeds this, basis points. */
  buybackMaxPriceImpactBps: number;
  minCollateralUsd: number;
  maxPoolCollateralUsd: number;
  maxTotalDeployedUsd: number;
  maxConcurrentPositions: number;
  /** Reduce 50% when mark is within this fraction of the entry→liquidation distance. */
  liquidationBufferPct: number;
  /** Loss made within one UTC day (realized today + unrealized change since the day's baseline) that trips the kill switch. */
  globalDailyLossUsd: number;
  claimMinEth: number;
  buybackMinEth: number;
  bridgeMinEth: number;
  /** Max price impact for ETH→USDC bridging, fraction. */
  bridgeMaxImpactPct: number;
  rhcGasReserveEth: number;
  baseSignalThreshold: number;
  /** Notional fee headroom kept in each token's trading budget when sizing opens, basis points. */
  feeBufferBps: number;
}

export interface EngineConfig {
  mode: EngineMode;
  port: number;
  dbPath: string;
  adminToken: string | null;
  autoApprove: boolean;
  corsOrigins: string[];
  trustProxy: boolean;
  demoSeed: boolean;
  /** Built web app served as static files when it exists. */
  webDist: string;
  /** Public site origin used for absolute social-card URLs and settings challenges, e.g. `https://bellwether.fun`. Null = from each request (paper only). */
  publicUrl: string | null;
  /**
   * False until PROTOCOL_ADDRESS (or a live key) is set. While false, `network.protocolAddress` is the zero
   * address, registration/verification answer `wallet_not_configured`, and discovery stays off.
   */
  walletConfigured: boolean;
  network: NetworkConfig;
  live: LiveConfig | null;
  protocolToken: Address | null;
  risk: RiskConfig;
  /** Worker base intervals, milliseconds. */
  intervals: Record<WorkerId, number>;
  alerts: AlertConfig;
  /** Valid but risky settings (live mode), logged at startup. */
  warnings: string[];
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid engine configuration:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

const INTERVAL_DEFAULTS_SEC: Record<WorkerId, { normal: number; demo: number }> = {
  claimer: { normal: 600, demo: 45 },
  treasury: { normal: 900, demo: 90 },
  trader: { normal: 120, demo: 60 },
  guardian: { normal: 45, demo: 20 },
  buyback: { normal: 600, demo: 60 },
  discovery: { normal: 900, demo: 900 },
  reconciler: { normal: 300, demo: 60 },
};

/** First Pons V2 launch (TokenLaunched on the V2 factory); fee-escrow scans start here. */
const PONS_V2_FROM_BLOCK_DEFAULT = 27_800_000;
/** Public, rate-limited endpoints: fine for paper, warned about in live mode. */
const PUBLIC_RHC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const PUBLIC_ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): EngineConfig {
  const problems: string[] = [];
  const read = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v === '' ? undefined : v;
  };

  const num = (name: string, def: number, opts: { min?: number; max?: number; integer?: boolean } = {}): number => {
    const raw = read(name);
    if (raw === undefined) return def;
    const n = Number(raw);
    const bad =
      !Number.isFinite(n) ||
      (opts.integer && !Number.isInteger(n)) ||
      (opts.min !== undefined && n < opts.min) ||
      (opts.max !== undefined && n > opts.max);
    if (bad) {
      const range = [opts.min !== undefined ? `>= ${opts.min}` : '', opts.max !== undefined ? `<= ${opts.max}` : '']
        .filter(Boolean)
        .join(' and ');
      problems.push(`${name}=${raw} must be a${opts.integer ? 'n integer' : ' number'}${range ? ` ${range}` : ''}`);
      return def;
    }
    return n;
  };

  const bool = (name: string, def: boolean): boolean => {
    const raw = read(name)?.toLowerCase();
    if (raw === undefined) return def;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    problems.push(`${name}=${raw} must be true/false`);
    return def;
  };

  const url = (name: string, def: string): string => {
    const raw = read(name) ?? def;
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
    } catch {
      problems.push(`${name}=${raw} must be an http(s) URL`);
    }
    return raw.replace(/\/+$/, '');
  };

  /** Endpoints whose answers are trusted to build signed transactions: TLS only. */
  const httpsUrl = (name: string, def: string): string => {
    const value = url(name, def);
    if (!value.startsWith('https://')) problems.push(`${name}=${value} must be an https URL`);
    return value;
  };

  const addr = (name: string, def: Address): Address => {
    const raw = read(name) ?? def;
    if (!isAddress(raw, { strict: false })) {
      problems.push(`${name}=${raw} is not a valid EVM address`);
      return def;
    }
    return getAddress(raw);
  };

  const optAddr = (name: string): Address | null => {
    const raw = read(name);
    if (raw === undefined) return null;
    if (!isAddress(raw, { strict: false })) {
      problems.push(`${name}=${raw} is not a valid EVM address`);
      return null;
    }
    return getAddress(raw);
  };

  const addrList = (name: string, def: readonly Address[]): Address[] => {
    const raw = read(name);
    if (raw === undefined) return def.map((a) => getAddress(a));
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = parts.filter((p) => !isAddress(p, { strict: false }));
    if (bad.length || parts.length === 0) {
      problems.push(`${name}=${raw} must be a comma-separated list of EVM addresses`);
      return def.map((a) => getAddress(a));
    }
    return parts.map((p) => getAddress(p));
  };

  const modeRaw = read('ENGINE_MODE') ?? 'paper';
  if (modeRaw !== 'paper' && modeRaw !== 'live') problems.push(`ENGINE_MODE=${modeRaw} must be "paper" or "live"`);
  const mode: EngineMode = modeRaw === 'live' ? 'live' : 'paper';

  let signer: { privateKey: Hex; address: Address } | null = null;
  const pk = read('PROTOCOL_PRIVATE_KEY');
  if (mode === 'live') {
    if (read('LIVE_CONFIRM') !== 'real-funds') problems.push('ENGINE_MODE=live requires LIVE_CONFIRM=real-funds');
    if (!pk) problems.push('ENGINE_MODE=live requires PROTOCOL_PRIVATE_KEY');
    else if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) problems.push('PROTOCOL_PRIVATE_KEY must be 0x-prefixed 32-byte hex');
    else signer = { privateKey: pk as Hex, address: privateKeyToAccount(pk as Hex).address };
  }

  const configuredProtocol = optAddr('PROTOCOL_ADDRESS');
  if (signer && configuredProtocol && configuredProtocol !== signer.address) {
    problems.push(`PROTOCOL_ADDRESS ${configuredProtocol} does not match PROTOCOL_PRIVATE_KEY address ${signer.address}`);
  }
  const protocolAddress = signer?.address ?? configuredProtocol ?? zeroAddress;

  const network: NetworkConfig = {
    protocolAddress,
    rhcRpcUrl: url('ROBINHOOD_RPC_URL', PUBLIC_RHC_RPC_URL),
    arbitrumRpcUrl: url('ARBITRUM_RPC_URL', PUBLIC_ARBITRUM_RPC_URL),
    blockscoutUrl: url('BLOCKSCOUT_URL', 'https://robinhoodchain.blockscout.com'),
    geckoterminalUrl: url('GECKOTERMINAL_API_URL', 'https://api.geckoterminal.com/api/v2'),
    geckoterminalNetwork: read('GECKOTERMINAL_NETWORK') ?? 'robinhood',
    hyperliquidApiUrl: url('HYPERLIQUID_API_URL', 'https://api.hyperliquid.xyz'),
    hyperliquidDex: read('HYPERLIQUID_DEX') ?? 'xyz',
    contracts: {
      weth: addr('WETH_ADDRESS', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
      uniswapRouter: addr('UNISWAP_ROUTER', '0xcaf681a66d020601342297493863e78c959e5cb2'),
      uniswapQuoter: addr('UNISWAP_QUOTER', '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7'),
      // Uniswap's Robinhood Chain V4 deployment (developers.uniswap.org/docs/protocols/v4/deployments).
      uniswapV4Quoter: addr('UNISWAP_V4_QUOTER', '0x8dc178efb8111bb0973dd9d722ebeff267c98f94'),
      uniswapV4StateView: addr('UNISWAP_V4_STATE_VIEW', '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'),
      uniswapUniversalRouter: addr('UNISWAP_UNIVERSAL_ROUTER', '0x204FAca1764B154221e35c0d20aBb3c525710498'),
      arbitrumUsdc: addr('ARBITRUM_USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
      ponsFactory: addr('PONS_FACTORY', '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB'),
      ponsLocker: addr('PONS_LOCKER', '0x736D76699C26D0d966744cAe304C000d471f7F35'),
      // Pons V2 (docs.ponsfamily.com/v2): bonding curve → Uniswap V4 pool behind a shared fee hook; fees paid via an escrow.
      ponsV2Factory: addr('PONS_V2_FACTORY', '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'),
      ponsV2Hook: addr('PONS_V2_HOOK', '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044'),
      ponsV2FeeEscrow: addr('PONS_V2_FEE_ESCROW', '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e'),
      launchhoodFactory: addr('LAUNCHHOOD_FACTORY', '0x62B33A039D289CBDa50EbeB72Fe4261449E61Bcf'),
      launchhoodLocker: optAddr('LAUNCHHOOD_LOCKER'),
      hyperliquidBridge: addr('HYPERLIQUID_BRIDGE', '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7'),
    },
    ponsV2FromBlock: num('PONS_V2_FROM_BLOCK', PONS_V2_FROM_BLOCK_DEFAULT, { min: 0, integer: true }),
  };

  const demoSeed = bool('DEMO_SEED', false);
  if (demoSeed && mode === 'live') problems.push('DEMO_SEED is only allowed in paper mode');

  const risk: RiskConfig = {
    slippageBps: num('SLIPPAGE_BPS', 50, { min: 1, max: 1000, integer: true }),
    buybackSlippageBps: num('BUYBACK_SLIPPAGE_BPS', 150, { min: 1, max: 2000, integer: true }),
    buybackMaxTwapDeviationBps: num('BUYBACK_MAX_TWAP_DEVIATION_BPS', 300, { min: 1, max: 5000, integer: true }),
    buybackMaxPriceImpactBps: num('BUYBACK_MAX_PRICE_IMPACT_BPS', 500, { min: 1, max: 5000, integer: true }),
    minCollateralUsd: num('MIN_COLLATERAL_USD', 10, { min: 1 }),
    maxPoolCollateralUsd: num('MAX_POOL_COLLATERAL_USD', 500, { min: 1 }),
    maxTotalDeployedUsd: num('MAX_TOTAL_DEPLOYED_USD', 1500, { min: 1 }),
    maxConcurrentPositions: num('MAX_CONCURRENT_POSITIONS', 3, { min: 1, max: 50, integer: true }),
    liquidationBufferPct: num('LIQUIDATION_BUFFER_PCT', 0.15, { min: 0, max: 0.9 }),
    globalDailyLossUsd: num('GLOBAL_DAILY_LOSS_USD', 300, { min: 1 }),
    claimMinEth: num('CLAIM_MIN_ETH', 0.0005, { min: 0 }),
    buybackMinEth: num('BUYBACK_MIN_ETH', 0.0005, { min: 0.000001 }),
    // Demo tokens accrue small synthetic fees; a lower default gets them trading within minutes.
    bridgeMinEth: num('BRIDGE_MIN_ETH', demoSeed ? 0.01 : 0.05, { min: 0.000001 }),
    bridgeMaxImpactPct: num('BRIDGE_MAX_IMPACT_PCT', 0.01, { min: 0, max: 0.2 }),
    rhcGasReserveEth: num('RHC_GAS_RESERVE_ETH', 0.01, { min: 0 }),
    baseSignalThreshold: num('BASE_SIGNAL_THRESHOLD', 30, { min: -100, max: 100 }),
    feeBufferBps: num('FEE_BUFFER_BPS', 20, { min: 0, max: 500 }),
  };
  if (risk.minCollateralUsd > risk.maxPoolCollateralUsd) {
    problems.push('MIN_COLLATERAL_USD must not exceed MAX_POOL_COLLATERAL_USD');
  }


  const intervals = {} as Record<WorkerId, number>;
  for (const [id, def] of Object.entries(INTERVAL_DEFAULTS_SEC) as [WorkerId, { normal: number; demo: number }][]) {
    const sec = num(`${id.toUpperCase()}_INTERVAL_SEC`, demoSeed ? def.demo : def.normal, { min: 5, max: 86_400 });
    intervals[id] = sec * 1000;
  }

  const adminToken = read('ADMIN_TOKEN') ?? null;
  if (adminToken !== null && adminToken.length < 24) problems.push('ADMIN_TOKEN must be at least 24 characters');
  // The kill switch and token pause are admin routes: live mode must never run without a way to reach them.
  if (mode === 'live' && adminToken === null) problems.push('ENGINE_MODE=live requires ADMIN_TOKEN (the kill switch is an admin route)');

  const alerts: AlertConfig = {
    telegramBotToken: read('ALERT_TELEGRAM_BOT_TOKEN') ?? null,
    telegramChatId: read('ALERT_TELEGRAM_CHAT_ID') ?? null,
    discordWebhookUrl: read('ALERT_DISCORD_WEBHOOK_URL') ?? null,
  };
  if ((alerts.telegramBotToken === null) !== (alerts.telegramChatId === null)) {
    problems.push('ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID must be set together');
  }
  if (alerts.discordWebhookUrl !== null && !/^https?:\/\//.test(alerts.discordWebhookUrl)) {
    problems.push('ALERT_DISCORD_WEBHOOK_URL must be an http(s) URL');
  }

  const warnings: string[] = [];
  const pubUrl = publicUrl(read('PUBLIC_URL'), problems);
  // Live mode never trusts the request's Host: the origin is embedded in the settings text creators sign.
  if (mode === 'live') {
    if (read('PUBLIC_URL') === undefined) problems.push('ENGINE_MODE=live requires PUBLIC_URL (e.g. https://bellwether.fun)');
    else if (pubUrl !== null && !pubUrl.startsWith('https://')) problems.push('ENGINE_MODE=live requires an https PUBLIC_URL');
  }
  // Unreviewed tokens trading real funds must be an explicit choice in live mode.
  const autoApprove = bool('AUTO_APPROVE', mode !== 'live');
  if (mode === 'live') {
    if (autoApprove) warnings.push('AUTO_APPROVE=true: every verified token registered through the API trades real funds without operator review');
    if (network.rhcRpcUrl === PUBLIC_RHC_RPC_URL) warnings.push('ROBINHOOD_RPC_URL is the public endpoint: rate limits will fail claims, buybacks and burns; use a private RPC');
    if (network.arbitrumRpcUrl === PUBLIC_ARBITRUM_RPC_URL) warnings.push('ARBITRUM_RPC_URL is the public endpoint: rate limits will fail margin top-ups and reconciliation; use a private RPC');
    if (alerts.telegramBotToken === null && alerts.discordWebhookUrl === null) {
      warnings.push('no alerts configured (ALERT_TELEGRAM_* or ALERT_DISCORD_WEBHOOK_URL): stops, liquidations and the kill switch page nobody');
    }
  }

  const config: EngineConfig = {
    mode,
    port: num('PORT', 8787, { min: 1, max: 65_535, integer: true }),
    dbPath: read('DB_PATH') ?? 'data/bellwether.db',
    adminToken,
    autoApprove,
    corsOrigins: (read('CORS_ORIGINS') ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: bool('TRUST_PROXY', false),
    demoSeed,
    webDist: read('WEB_DIST') ?? DEFAULT_WEB_DIST,
    publicUrl: pubUrl,
    walletConfigured: protocolAddress !== zeroAddress,
    network,
    live: signer
      ? {
          ...network,
          privateKey: signer.privateKey,
          relayApiUrl: httpsUrl('RELAY_API_URL', DEFAULT_RELAY_API_URL),
          relayDepositContracts: addrList('RELAY_DEPOSIT_CONTRACTS', DEFAULT_RELAY_DEPOSIT_CONTRACTS),
          minRhcGasEth: risk.rhcGasReserveEth,
          buybackMaxTwapDeviationBps: risk.buybackMaxTwapDeviationBps,
          buybackMaxPriceImpactBps: risk.buybackMaxPriceImpactBps,
        }
      : null,
    protocolToken: optAddr('PROTOCOL_TOKEN_ADDRESS'),
    risk,
    intervals,
    alerts,
    warnings,
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return deepFreeze(config);
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}

/** Accepts a bare http(s) origin; paths, queries and credentials are rejected so it is safe to embed in HTML. */
function publicUrl(raw: string | undefined, problems: string[]): string | null {
  if (raw === undefined) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    problems.push(`PUBLIC_URL=${raw} is not a URL`);
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    problems.push(`PUBLIC_URL=${raw} must be a bare origin like https://bellwether.fun`);
    return null;
  }
  return u.origin;
}
