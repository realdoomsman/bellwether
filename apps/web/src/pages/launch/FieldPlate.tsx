import { BRAND, type LaunchpadInfo } from '@bellwether/shared';
import { shortAddr } from '../../lib/format';
import { FORM_SPEC } from './formSpec';

function Ghost({ label, value, note }: { label: string; value?: string; note?: string | null }) {
  return (
    <span className="lw-plate__field">
      <span className="lw-plate__label">{label}</span>
      <span className="lw-plate__input" data-value={value ? '' : undefined}>
        {value}
      </span>
      {note && <span className="lw-plate__note">{note}</span>}
    </span>
  );
}

/**
 * An engraved plate of the launchpad's create form: the ordinary fields as ghosts, the one setting that
 * matters in ink, and numbered marks matching the three instructions beside it. Once the visitor copies
 * the wallet the field shows it filled in, so the copy and the paste target are visibly the same thing.
 */
export function FieldPlate({ lp, wallet, filled }: { lp: LaunchpadInfo; wallet: string | null; filled: boolean }) {
  const spec = FORM_SPEC[lp.id];
  const showWallet = filled && wallet !== null;
  return (
    <figure className="lw-plate">
      <div className="lw-plate__sheet" aria-hidden="true">
        <p className="lw-plate__chrome num">{spec.page}</p>
        <div className="lw-plate__form">
          <p className="lw-plate__title">{spec.title}</p>
          <div className="lw-plate__group">
            <span className="lw-plate__mark num">1</span>
            {spec.rows.map((row) => (
              <span key={row.join()} className="lw-plate__row">
                {row.map((label) => (
                  <Ghost key={label} label={label} />
                ))}
              </span>
            ))}
            {spec.keep && <Ghost label={spec.keep.label} value={spec.keep.value} note={spec.keep.note} />}
          </div>
          <div className="lw-plate__group">
            <span className="lw-plate__mark num">2</span>
            <p className="lw-plate__adv">
              Advanced
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                <path d="m2.5 7.5 3.5-3.5 3.5 3.5" />
              </svg>
            </p>
            {spec.advanced.map((a) => (
              <span key={a.label} className="lw-plate__field lw-plate__field--setting">
                <span className="lw-plate__switch" />
                <span className="lw-plate__label">{a.label}</span>
                <span className="lw-plate__state">{a.value}</span>
                {a.note && <span className="lw-plate__note">{a.note}</span>}
              </span>
            ))}
            <span className="lw-plate__hot" data-filled={showWallet || undefined}>
              <span className="lw-plate__label">
                {lp.feeField}
                {spec.optional && ' (optional)'}
              </span>
              <span className="lw-plate__input lw-plate__input--hot">
                <span key={showWallet ? 'wallet' : 'empty'} className={showWallet ? 'lw-plate__value num' : 'lw-plate__placeholder'}>
                  {showWallet ? shortAddr(wallet, 14, 8) : spec.placeholder}
                </span>
              </span>
              <span className="lw-plate__hint">{spec.hint}</span>
              <span className="lw-plate__pin">{showWallet ? 'Copied. Paste it here' : `Paste the ${BRAND.name} wallet here`}</span>
            </span>
          </div>
          <div className="lw-plate__group lw-plate__group--end">
            <span className="lw-plate__mark num">3</span>
            <span className="lw-plate__submit">{spec.submit}</span>
          </div>
        </div>
      </div>
      <figcaption className="lw-plate__cap">
        Illustration of {lp.name}’s create form, {lp.feeFieldLocation}, as it looked in September 2026. Only the field in ink is {BRAND.name}-specific.
      </figcaption>
    </figure>
  );
}
