import type { Address } from '@floor/shared';
import { useCallback, useEffect, useState } from 'react';

/** Minimal EIP-1193 surface; no wallet library needed for connect + personal_sign. */
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: 'accountsChanged', handler: (accounts: string[]) => void): void;
  removeListener?(event: 'accountsChanged', handler: (accounts: string[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

interface ProviderRpcError {
  code: number;
  message: string;
}

export function walletErrorMessage(err: unknown): string {
  const code = (err as Partial<ProviderRpcError> | null)?.code;
  if (code === 4001) return 'You rejected the request in your wallet.';
  if (code === -32002) return 'Your wallet already has a pending request. Open it to continue.';
  if (err instanceof Error) return err.message;
  return (err as Partial<ProviderRpcError> | null)?.message ?? 'The wallet request failed.';
}

function toHex(text: string): `0x${string}` {
  let hex = '';
  for (const b of new TextEncoder().encode(text)) hex += b.toString(16).padStart(2, '0');
  return `0x${hex}`;
}

export interface Wallet {
  available: boolean;
  account: Address | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  /** EIP-191 personal_sign of a UTF-8 message by the connected account. */
  sign: (message: string) => Promise<`0x${string}`>;
}

export function useWallet(): Wallet {
  const provider = typeof window === 'undefined' ? undefined : window.ethereum;
  const [account, setAccount] = useState<Address | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!provider) return;
    const onAccounts = (accounts: string[]) => setAccount((accounts[0] as Address | undefined) ?? null);
    // Pick up an existing authorization silently (no popup).
    provider
      .request({ method: 'eth_accounts' })
      .then((a) => onAccounts(a as string[]))
      .catch(() => {});
    provider.on?.('accountsChanged', onAccounts);
    return () => provider.removeListener?.('accountsChanged', onAccounts);
  }, [provider]);

  const connect = useCallback(async () => {
    if (!provider) return;
    setConnecting(true);
    setError(null);
    try {
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      setAccount((accounts[0] as Address | undefined) ?? null);
    } catch (err) {
      setError(walletErrorMessage(err));
    } finally {
      setConnecting(false);
    }
  }, [provider]);

  const sign = useCallback(
    async (message: string) => {
      if (!provider || !account) throw new Error('Connect your wallet first.');
      return (await provider.request({ method: 'personal_sign', params: [toHex(message), account] })) as `0x${string}`;
    },
    [provider, account],
  );

  return { available: Boolean(provider), account, connecting, error, connect, sign };
}
