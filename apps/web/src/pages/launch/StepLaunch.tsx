import { BRAND, LAUNCHPADS } from '@bellwether/shared';
import { useState } from 'react';
import { ErrorNotice } from '../../components/DataState';
import { ExtLink } from '../../components/Links';
import { useConfig } from '../../lib/queries';
import type { Draft } from './draft';
import { FieldPlate } from './FieldPlate';
import { launchFeeText } from './LaunchpadMark';
import { StepHead, StepNav } from './StepFrame';
import { WalletCopy } from './WalletCopy';

export function StepLaunch({ draft, update, back, next }: { draft: Draft; update: (p: Partial<Draft>) => void; back: () => void; next: () => void }) {
  const config = useConfig();
  const [copied, setCopied] = useState(false);
  const lp = draft.launchpad ? LAUNCHPADS[draft.launchpad] : null;
  if (!lp) return null;
  const wallet = config.data?.protocolWallet ?? null;
  const edges = wallet ? { head: wallet.slice(0, 6), tail: wallet.slice(-4) } : null;

  return (
    <form
      className="lw-step"
      onSubmit={(e) => {
        e.preventDefault();
        if (!wallet) return;
        update({ walletConfirmed: true });
        next();
      }}
    >
      <StepHead
        n={3}
        title={`Launch on ${lp.name}`}
        lede={
          <>
            Create your token on {lp.name} as you normally would. The only {BRAND.name}-specific part is one field, <strong>{lp.feeField}</strong>: it decides who receives the creator fees.
          </>
        }
      />

      {wallet ? (
        <WalletCopy wallet={wallet} lp={lp} onCopy={() => setCopied(true)} />
      ) : config.error ? (
        <ErrorNotice
          error={config.error}
          onRetry={config.refresh}
          what={`The ${BRAND.name} wallet address`}
          offlineHint="The address comes straight from the engine. Wait for it to reconnect; never copy it from anywhere else."
        />
      ) : (
        <div className="lw-wallet lw-wallet--pending" role="status">
          <p className="lw-wallet__label">
            Paste this as the <strong>{lp.feeField}</strong> on {lp.name}
          </p>
          <p className="lw-wallet__addr lw-wallet__addr--empty">Connecting to the engine for the wallet address…</p>
        </div>
      )}

      <div className="lw-howto">
        <ol className="lw-howto__steps">
          <li className="lw-howto__step">
            <span className="lw-howto__n num" aria-hidden="true">
              1
            </span>
            <div>
              <h3 className="lw-howto__title">Open {lp.name} and fill in your token</h3>
              <p>Name, ticker, image and socials are all yours to choose.</p>
              {lp.requirements.length > 0 && (
                <ul className="lw-howto__reqs">
                  {lp.requirements.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <ExtLink href={lp.url} className="lw-howto__open">
                Open {lp.name}
              </ExtLink>
            </div>
          </li>
          <li className="lw-howto__step">
            <span className="lw-howto__n num" aria-hidden="true">
              2
            </span>
            <div>
              <h3 className="lw-howto__title">Paste the wallet into {lp.feeField}</h3>
              <p>
                It’s under {lp.feeFieldLocation}. Don’t leave it blank: an empty {lp.feeField} pays the fees to your own wallet, and {BRAND.name} never receives them.
              </p>
              {edges && (
                <p className="lw-howto__check">
                  After pasting, check it starts <span className="num">{edges.head}</span> and ends <span className="num">{edges.tail}</span>.
                </p>
              )}
            </div>
          </li>
          <li className="lw-howto__step">
            <span className="lw-howto__n num" aria-hidden="true">
              3
            </span>
            <div>
              <h3 className="lw-howto__title">Launch, then copy the token’s address</h3>
              <p>
                Confirm in your wallet ({lp.launchFeeEth === null ? 'gas only' : launchFeeText(lp)}). You’ll paste the new token’s contract address in the next step, where {BRAND.name} checks it on-chain.
              </p>
            </div>
          </li>
        </ol>
        {/* Media slot: a per-launchpad silent loop of this form goes here, alongside or in place of the plate. */}
        <div className="lw-howto__media">
          <FieldPlate lp={lp} wallet={wallet} filled={copied || draft.walletConfirmed} />
        </div>
      </div>

      {lp.caveats.length > 0 && (
        <aside className="lw-caveats" aria-label={`About ${lp.name}`}>
          <p className="lw-caveats__title">Good to know about {lp.name}</p>
          <ol>
            {lp.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
        </aside>
      )}

      <StepNav onBack={back} next="I’ve launched" canNext={wallet !== null} why={config.error ? 'Waiting for the engine to share the wallet address.' : 'Loading the wallet address…'} />
    </form>
  );
}
