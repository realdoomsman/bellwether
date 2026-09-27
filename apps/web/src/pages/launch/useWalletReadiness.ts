import { CHAINS, type Address } from '@bellwether/shared';
import { useCallback, useEffect, useState } from 'react';
import { walletErrorMessage } from '../../lib/wallet';

/** The slice of EIP-1193 this check needs; events are untyped because wallets differ in what they send. */
interface Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (value: unknown) => void): void;
  removeListener?(event: string, handler: (value: unknown) => void): void;
}

export const RHC_CHAIN_ID = CHAINS.rhc.chainId ?? 4663;

export interface WalletReadiness {
  /** A browser wallet is installed. Without one nothing can be checked automatically. */
  available: boolean;
  chainId: number | null;
  account: Address | null;
  /** ETH on Robinhood Chain; read only while the wallet is on that chain. */
  balanceEth: number | null;
  connecting: boolean;
  error: string | null;
  /** Asks the wallet for an account (a user gesture: it opens the wallet). */
  connect: () => void;
}

/**
 * Read-only look at the visitor's browser wallet for the "Before you start" list: which chain it's on,
 * and (once an account is shared) how much ETH it holds there. Nothing is requested without a click.
 */
export function useWalletReadiness(): WalletReadiness {
  const [chainId, setChainId] = useState<number | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [balanceEth, setBalanceEth] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = typeof window === 'undefined' ? undefined : (window.ethereum as Provider | undefined);

  useEffect(() => {
    if (!p) return;
    let alive = true;
    const onChain = (v: unknown) => {
      if (alive) setChainId(typeof v === 'string' ? Number.parseInt(v, 16) : null);
    };
    const onAccounts = (v: unknown) => {
      if (alive) setAccount(Array.isArray(v) && typeof v[0] === 'string' ? (v[0] as Address) : null);
    };
    p.request({ method: 'eth_chainId' }).then(onChain, () => {});
    // eth_accounts never prompts: it only returns an account the visitor already shared with this site.
    p.request({ method: 'eth_accounts' }).then(onAccounts, () => {});
    p.on?.('chainChanged', onChain);
    p.on?.('accountsChanged', onAccounts);
    return () => {
      alive = false;
      p.removeListener?.('chainChanged', onChain);
      p.removeListener?.('accountsChanged', onAccounts);
    };
  }, [p]);

  useEffect(() => {
    setBalanceEth(null);
    if (!p || !account || chainId !== RHC_CHAIN_ID) return;
    let alive = true;
    p.request({ method: 'eth_getBalance', params: [account, 'latest'] }).then(
      (wei) => {
        if (alive && typeof wei === 'string') setBalanceEth(Number(BigInt(wei)) / 1e18);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [p, account, chainId]);

  const connect = useCallback(() => {
    if (!p) return;
    setConnecting(true);
    setError(null);
    p.request({ method: 'eth_requestAccounts' })
      .then((v) => setAccount(Array.isArray(v) && typeof v[0] === 'string' ? (v[0] as Address) : null))
      .catch((err: unknown) => setError(walletErrorMessage(err)))
      .finally(() => setConnecting(false));
  }, [p]);

  return { available: Boolean(p), chainId, account, balanceEth, connecting, error, connect };
}
