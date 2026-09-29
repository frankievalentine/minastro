# Analytics

Cloudflare Web Analytics is the recommended default for production sites
deployed from this template. It needs no script tag, token, or Worker binding in
the repository: you enable it in the Cloudflare dashboard once the site is live
on its custom domain, and Cloudflare injects the beacon into your responses. The
beacon loads from `static.cloudflareinsights.com` and posts measurements to your
own origin at `/cdn-cgi/rum`.

## Enable Cloudflare Web Analytics

After the site responds on its final HTTPS hostname:

1. In the Cloudflare dashboard for the zone that owns your hostname, open **Web
   Analytics** and add the site. This is the proxied-hostname flow; it requires
   the hostname to be proxied through Cloudflare, which is how this template
   attaches its custom domain.
2. Verify it is live rather than assuming. Load a public page and check the
   network panel for the beacon script, then navigate within the site or hide
   the tab and confirm the `POST /cdn-cgi/rum` request fires. Allow some delay
   for ingestion before the dashboard shows data.
3. Auto-injection covers the whole zone, so it also applies to
   `/_emdash/admin`, and SPA navigation is tracked with no extra configuration.
   If the beacon never appears, check that responses do not send
   `Cache-Control: public, no-transform` on the public HTML, which suppresses
   automatic injection; if they do, remove that directive.

Because Cloudflare injects the site-wide beacon itself, leave the custom
analytics hook in `src/site.config.ts` disabled (`analytics.enabled: false`)
when you choose Cloudflare Web Analytics. Never put a Cloudflare token, account
ID, or snippet into the config for this option, and do not also add a custom
script: that only produces duplicate tracking.

## Use another provider, or none

- **Another provider:** set `analytics.enabled: true` with its `url`, and set
  `domain` only if the provider reads a `data-domain` attribute. The template
  loads it through the Partytown `text/partytown` script in
  `src/layouts/Layout.astro`, so it stays off the main thread. Provider snippets
  that need more than a script `src` plus `data-domain` (extra inline config, a
  different attribute such as `data-website-id`, an `async` loader) require
  editing `Layout.astro`; the current hook only covers the plain script-tag
  case.
- **None:** leave `analytics.enabled: false` and also disable or skip Cloudflare
  Web Analytics in the dashboard. Cloudflare injection is independent of this
  config, so the hook alone does not turn analytics off.
