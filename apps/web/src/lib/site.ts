/**
 * The origin this page was served from, as the engine wrote it into index.html's canonical link: PUBLIC_URL
 * when the operator set one, otherwise the validated request host (the dev server leaves it relative).
 * Copy that tells people where to sign or register names this, never a hardcoded domain, so the site can't
 * point anyone at a domain its operator doesn't hold.
 */
export function siteOrigin(): string {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  return new URL(canonical ?? '/', window.location.href).origin;
}

/** Host part of {@link siteOrigin}, for prose: `example.com`. */
export function siteHost(): string {
  return new URL(siteOrigin()).host;
}
