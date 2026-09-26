import type {
  ActivityResponse,
  Address,
  ApiError,
  CandleInterval,
  CandlesResponse,
  ConfigResponse,
  HealthResponse,
  LaunchpadId,
  LeaderboardBy,
  LeaderboardResponse,
  MarketsResponse,
  PositionsResponse,
  ProofResponse,
  RegisterRequest,
  RegisterResponse,
  SettingsChallenge,
  SettingsUpdateRequest,
  StatsResponse,
  StatusResponse,
  TokenCandlesResponse,
  TokenDetailResponse,
  TokensResponse,
  TokenSummary,
  TradesResponse,
  VerifyResponse,
} from '@floor/shared';

export const API_BASE = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/+$/, '');

export function isAddress(v: string): v is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

/** `engine_offline` means we never got a JSON answer from the engine (down, proxy error, wrong host). */
const OFFLINE = 'engine_offline';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get offline(): boolean {
    return this.code === OFFLINE;
  }
}

function isApiError(v: unknown): v is ApiError {
  return typeof v === 'object' && v !== null && typeof (v as ApiError).code === 'string' && typeof (v as ApiError).error === 'string';
}

function offline(status: number): ApiRequestError {
  return new ApiRequestError(status, OFFLINE, 'The Floor engine is unreachable right now.');
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      ...init,
      headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw offline(0);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // Non-JSON (proxy error page, static host fallback): the engine did not answer.
    throw offline(res.status);
  }
  if (!res.ok) {
    if (isApiError(body)) throw new ApiRequestError(res.status, body.code, body.error, body.details);
    throw offline(res.status);
  }
  return body as T;
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal });
const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });

function qs(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const api = {
  health: (s?: AbortSignal) => get<HealthResponse>('/health', s),
  status: (s?: AbortSignal) => get<StatusResponse>('/status', s),
  stats: (s?: AbortSignal) => get<StatsResponse>('/stats', s),
  config: (s?: AbortSignal) => get<ConfigResponse>('/config', s),
  markets: (s?: AbortSignal) => get<MarketsResponse>('/markets', s),
  marketCandles: (symbol: string, interval: CandleInterval, s?: AbortSignal) =>
    get<CandlesResponse>(`/markets/${encodeURIComponent(symbol)}/candles${qs({ interval })}`, s),
  tokens: (s?: AbortSignal) => get<TokensResponse>('/tokens', s),
  token: (address: string, s?: AbortSignal) => get<TokenDetailResponse>(`/tokens/${encodeURIComponent(address)}`, s),
  tokenCandles: (address: string, interval: CandleInterval, s?: AbortSignal) =>
    get<TokenCandlesResponse>(`/tokens/${encodeURIComponent(address)}/candles${qs({ interval })}`, s),
  verify: (address: string, launchpad: LaunchpadId, s?: AbortSignal) =>
    get<VerifyResponse>(`/tokens/${encodeURIComponent(address)}/verify${qs({ launchpad })}`, s),
  register: (body: RegisterRequest) => post<RegisterResponse>('/tokens', body),
  settingsChallenge: (address: Address) => get<SettingsChallenge>(`/tokens/${address}/settings/challenge`),
  updateSettings: (address: Address, body: SettingsUpdateRequest) =>
    post<TokenSummary>(`/tokens/${address}/settings`, body),
  positions: (s?: AbortSignal) => get<PositionsResponse>('/positions', s),
  trades: (limit: number, s?: AbortSignal) => get<TradesResponse>(`/trades${qs({ limit })}`, s),
  activity: (q: { before?: number; limit?: number; token?: string }, s?: AbortSignal) =>
    get<ActivityResponse>(`/activity${qs(q)}`, s),
  leaderboard: (by: LeaderboardBy, s?: AbortSignal) => get<LeaderboardResponse>(`/leaderboard${qs({ by })}`, s),
  proof: (s?: AbortSignal) => get<ProofResponse>('/proof', s),
};
