import { BRAND, STRATEGIES, type TokenDetailResponse } from '@bellwether/shared';
import { useEffect, useState } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { compact, etDateTime, leverage, shortAddr } from '../../lib/format';
import { usePaperMode } from '../../lib/queries';
import { siteHost } from '../../lib/site';
import { burnedLabel } from './burn';

type Token = TokenDetailResponse['token'];

/* The card travels without the site, so it is always the Paper edition of the brand. */
const PAPER = BRAND.colors.paper;
const INK = BRAND.colors.ink;
const BRASS = BRAND.colors.brass;
const PAPER_2 = '#ECE7DB';
const INK_2 = '#4A463D';
const INK_3 = '#655F52';
const RULE = '#D8D1C0';
const RULE_STRONG = '#BDB4A0';
const ETCH = '#1B150C';
const SERIF = '"Newsreader Display", Georgia, serif';
const SANS = '"Geist Variable", system-ui, sans-serif';
const MONO = '"Geist Mono Variable", ui-monospace, monospace';
const W = 1200;
const H = 630;

/* Geometry: the candle-bell from Logo.tsx and the engraved bell from Bell.tsx / public/og.svg. */
const MONOGRAM_BODY = 'M6 18C7.3 16.4 7.8 13.8 8 11V9.6C8 7.6 9.8 6 12 6s4 1.6 4 3.6V11c.2 2.8.7 5.4 2 7Z';
const BELL_BODY =
  'M160 64C186 64 196 72 198 92C200 114 200 140 206 170C212 200 228 216 252 226C262 230 264 236 258 240H62C56 236 58 230 68 226C92 216 108 200 114 170C120 140 120 114 122 92C124 72 134 64 160 64Z';

function stroke(ctx: CanvasRenderingContext2D, path: string | Path2D, color: string, width: number, alpha = 1): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.stroke(typeof path === 'string' ? new Path2D(path) : path);
  ctx.restore();
}

function drawMonogram(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  stroke(ctx, 'M12 1.5V6', INK, 1.5);
  ctx.fillStyle = INK;
  ctx.fill(new Path2D(MONOGRAM_BODY));
  stroke(ctx, 'M5 18.1H19', INK, 1.5);
  stroke(ctx, 'M12 18.5V20', INK, 1.5);
  ctx.fillStyle = BRASS;
  ctx.beginPath();
  ctx.arc(12, 21.5, 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The engraved bell on its beam, as in the site's social card. */
function drawBell(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
  const circle = (cx: number, cy: number, r: number) => {
    const p = new Path2D();
    p.arc(cx, cy, r, 0, Math.PI * 2);
    return p;
  };
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  stroke(ctx, circle(160, 160, 150), BRASS, 1, 0.28);
  stroke(ctx, circle(160, 160, 196), BRASS, 1, 0.14);
  // Beam, strap, clapper, hanger and canon.
  const beam = new Path2D();
  beam.roundRect(20, 16, 280, 20, 1.5);
  ctx.fillStyle = PAPER_2;
  ctx.fill(beam);
  stroke(ctx, beam, INK, 1.25);
  stroke(ctx, 'M26 21.5C90 20.5 150 22.5 214 21.5S284 20.8 294 21.5M26 26C80 27 140 25 200 26.2S270 27 294 26M26 30.5H294M26 33H294', INK, 0.6, 0.45);
  const strap = new Path2D();
  strap.roundRect(146, 13, 28, 26, 2);
  ctx.fillStyle = INK;
  ctx.fill(strap);
  stroke(ctx, 'M160 80V250', INK, 3);
  ctx.fill(circle(160, 258, 9));
  ctx.fill(new Path2D('M155.5 39H164.5V66H155.5Z'));
  stroke(ctx, 'M149 66V60A11 11 0 0 1 171 60V66', INK, 3);
  // Body in brass with banknote hatching, bands and a highlight, clipped to the bell.
  const body = new Path2D(BELL_BODY);
  ctx.fillStyle = BRASS;
  ctx.fill(body);
  ctx.save();
  ctx.clip(body);
  let hatch = '';
  for (let yy = 66; yy < 241; yy += 2.5) hatch += `M${186 + (yy - 66) * 0.2} ${yy}H270`;
  stroke(ctx, hatch, ETCH, 0.75, 0.5);
  stroke(ctx, 'M184 70C192 76 192 96 192 112C192 140 194 166 200 186C206 206 220 220 244 232', ETCH, 0.8, 0.35);
  stroke(ctx, 'M136 76C131 96 130 128 128 160C126 188 118 210 100 226', '#FFF6DF', 5, 0.4);
  stroke(ctx, 'M110 98C140 104 180 104 210 98M110 112C140 118 180 118 210 112M90 204C130 214 190 214 230 204M76 218C120 229 200 229 244 218', ETCH, 0.9, 0.7);
  ctx.restore();
  stroke(ctx, body, INK, 1.5);
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = ETCH;
  ctx.beginPath();
  ctx.ellipse(160, 240, 98, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = PAPER;
  ctx.fill(circle(160, 44, 4.5));
  stroke(ctx, circle(160, 44, 4.5), INK, 1.5);
  ctx.restore();
}

function loadImage(src: string, cors: boolean): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * The token's mark: its image when the host allows it on a canvas (CORS), otherwise the engraved
 * medallion traced from the one in the page header (same rosette, drawn in the card's colors).
 */
async function drawMark(ctx: CanvasRenderingContext2D, t: Token, x: number, y: number, size: number): Promise<void> {
  const disc = new Path2D();
  disc.arc(x + size / 2, y + size / 2, size / 2 - 0.5, 0, Math.PI * 2);
  const img = t.image ? await loadImage(t.image, true) : null;
  ctx.save();
  ctx.clip(disc);
  ctx.fillStyle = PAPER_2;
  ctx.fill(disc);
  if (img) {
    ctx.drawImage(img, x, y, size, size);
  } else {
    const k = size / 100;
    const at = new DOMMatrix([k, 0, 0, k, x, y]);
    for (const ring of document.querySelectorAll<SVGPathElement>('.tkn-head__medal .medallion__rose path')) {
      const p = new Path2D();
      p.addPath(new Path2D(ring.getAttribute('d') ?? ''), at);
      stroke(ctx, p, INK, 0.8, 0.26);
    }
    const bossR = Number(document.querySelector('.tkn-head__medal .medallion__boss')?.getAttribute('r') ?? 21) * k;
    const boss = new Path2D();
    boss.arc(x + size / 2, y + size / 2, bossR, 0, Math.PI * 2);
    ctx.fillStyle = PAPER_2;
    ctx.fill(boss);
    stroke(ctx, boss, INK, 1, 0.45);
    ctx.fillStyle = INK;
    ctx.font = `400 ${Math.round(27 * k)}px ${SERIF}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.symbol.charAt(0).toUpperCase(), x + size / 2, y + size / 2 + 1);
  }
  ctx.restore();
  stroke(ctx, disc, RULE_STRONG, 1);
}

/** Log-scale burn rule, as on the page: 0.01% … 100%, brass up to the current share. */
function drawGauge(ctx: CanvasRenderingContext2D, frac: number, x: number, y: number, w: number): void {
  const at = (v: number) => x + (v <= 0.0001 ? 0 : (Math.log10(Math.min(1, v)) + 4) / 4) * w;
  ctx.fillStyle = RULE;
  ctx.fillRect(x, y - 1, w, 2);
  ctx.fillStyle = BRASS;
  ctx.fillRect(x, y - 2, at(frac) - x, 4);
  ctx.font = `400 15px ${MONO}`;
  ctx.textBaseline = 'top';
  for (const [v, label] of [
    [0.0001, '0.01%'],
    [0.001, '0.1%'],
    [0.01, '1%'],
    [0.1, '10%'],
    [1, '100%'],
  ] as const) {
    ctx.fillStyle = frac >= v ? INK : RULE_STRONG;
    ctx.fillRect(at(v) - 0.5, y - 7, 1, 14);
    ctx.fillStyle = INK_3;
    ctx.textAlign = v === 0.0001 ? 'left' : v === 1 ? 'right' : 'center';
    ctx.fillText(label, at(v), y + 14);
  }
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.moveTo(at(frac), y - 6);
  ctx.lineTo(at(frac) + 7, y - 16);
  ctx.lineTo(at(frac) - 7, y - 16);
  ctx.closePath();
  ctx.fill();
}

/** Draws the 1200×630 card for `t` and returns it as a PNG. */
async function drawCard(t: Token, paper: boolean, asOf: number): Promise<Blob> {
  await Promise.all([document.fonts.load(`300 160px ${SERIF}`), document.fonts.load(`400 30px ${MONO}`), document.fonts.load(`400 22px ${SANS}`)]);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  const burned = t.book.tokensBurned > 0;
  const s = STRATEGIES[t.strategy];

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = RULE;
  ctx.fillRect(80, 0, 1, H);
  ctx.fillRect(1119, 0, 1, H);
  ctx.fillRect(80, 540, 1040, 1);

  drawMonogram(ctx, 96, 64, 40);
  ctx.fillStyle = INK;
  ctx.font = `380 34px ${SERIF}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(BRAND.name, 144, 97);

  await drawMark(ctx, t, 96, 142, 60);
  ctx.fillStyle = INK;
  ctx.font = `500 28px ${MONO}`;
  ctx.fillText(`$${t.symbol}`, 172, 170);
  ctx.fillStyle = INK_2;
  ctx.font = `400 20px ${SANS}`;
  ctx.fillText(`${t.name} · ${t.market} ${t.side} · ${s.trades ? `${s.label} ≤ ${leverage(t.maxLeverage)}` : s.label}`, 172, 199);

  ctx.fillStyle = INK;
  if (burned) {
    ctx.font = `300 164px ${SERIF}`;
    ctx.letterSpacing = '-5px';
    ctx.fillText(burnedLabel(t.book.supplyBurnedPct), 88, 382);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = INK_2;
    ctx.font = `360 36px ${SERIF}`;
    ctx.fillText(`of $${t.symbol} supply burned for good`, 96, 432);
    drawGauge(ctx, t.book.supplyBurnedPct, 96, 486, 560);
  } else {
    ctx.font = `320 92px ${SERIF}`;
    ctx.letterSpacing = '-2px';
    ctx.fillText(`Every $${t.symbol} fee`, 90, 344);
    ctx.fillText('rings the bell.', 90, 432);
    ctx.letterSpacing = '0px';
  }

  drawBell(ctx, 752, 104, 1.08);

  ctx.font = `400 19px ${MONO}`;
  ctx.fillStyle = INK_3;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${siteHost()}/t/${shortAddr(t.address)}`, 96, 590);
  ctx.textAlign = 'right';
  const facts = burned ? `${compact(t.book.tokensBurned)} $${t.symbol} burned · as of ${etDateTime(asOf)}` : `As of ${etDateTime(asOf)}`;
  ctx.fillText(paper ? `${facts} · PAPER` : facts, 1104, 590);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The card could not be drawn.'))), 'image/png'));
}

/** Share: a dialog with the generated card (download), a prefilled post on X and the page link. */
export function ShareButton({ t, asOf }: { t: Token; asOf: number | null }) {
  const paper = usePaperMode();
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<{ url: string } | { error: string } | null>(null);
  const link = `${window.location.origin}/t/${t.address}`;
  const handle = `@${BRAND.links.x.split('/').pop() ?? ''}`;
  const text =
    t.book.tokensBurned > 0
      ? `${burnedLabel(t.book.supplyBurnedPct)} of $${t.symbol} supply bought back and burned by ${handle}${paper ? ' (paper mode, simulated)' : ''}. Every burn has a receipt.`
      : `$${t.symbol} creator fees trade ${t.market} perps on ${handle}, then buy back and burn $${t.symbol}${paper ? ' (paper mode, simulated)' : ''}.`;
  const stamp = asOf ?? Date.now();

  useEffect(() => {
    if (!open) return;
    let url: string | null = null;
    let live = true;
    setCard(null);
    drawCard(t, paper, stamp).then(
      (blob) => {
        url = URL.createObjectURL(blob);
        if (live) setCard({ url });
        else URL.revokeObjectURL(url);
      },
      (err: unknown) => live && setCard({ error: err instanceof Error ? err.message : 'The card could not be drawn.' }),
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
    // Redraw per opening; the figures are read at that moment.
  }, [open]);

  return (
    <>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>
        <Icon name="share" /> Share
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Share $${t.symbol}`} className="share-dialog">
        <figure className="share__card">
          {card && 'url' in card ? (
            <img src={card.url} width={W} height={H} alt={`Share card: ${t.book.tokensBurned > 0 ? `${burnedLabel(t.book.supplyBurnedPct)} of $${t.symbol} supply burned` : `$${t.symbol} on ${BRAND.name}`}`} />
          ) : (
            <span className="share__wait">{card ? card.error : 'Drawing the card…'}</span>
          )}
        </figure>
        <p className="share__text">{text}</p>
        <div className="share__actions">
          <a className="btn btn--primary btn--sm" href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`} target="_blank" rel="noopener noreferrer">
            Post on X<span className="sr-only"> (opens in a new tab)</span>
          </a>
          {card && 'url' in card ? (
            <a className="btn btn--secondary btn--sm" href={card.url} download={`${t.symbol.toLowerCase()}-${BRAND.name.toLowerCase()}.png`}>
              Download image
            </a>
          ) : (
            <button type="button" className="btn btn--secondary btn--sm" disabled>
              Download image
            </button>
          )}
          <CopyButton text={link} what="page link" label="Copy link" className="btn btn--ghost btn--sm" />
        </div>
        <p className="share__note">
          Drawn in your browser from this page’s figures, as of {etDateTime(stamp)}.{paper ? ' Paper mode: the amounts are simulated and the card says so.' : ''}
        </p>
      </Dialog>
    </>
  );
}
