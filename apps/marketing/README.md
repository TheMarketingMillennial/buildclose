# BuildClose — marketing site (buildclose.app)

Standalone commercial landing page. **No build step, no dependencies, no
framework.** Plain HTML, CSS and ES modules so the page cannot be broken by a
dependency update and costs nothing to serve.

## Deploy to Netlify

- Netlify site name: `buildclose-web`
- **Base directory: `apps/marketing`**
- Build command: *(none — leave empty)*
- Publish directory: `.`

```bash
cd apps/marketing
netlify deploy --dir .          # preview
netlify deploy --prod --dir .   # production
```

Then add the DNS record (RUNBOOK §10):

```
buildclose.app   CNAME   <buildclose-web>.netlify.app
```

Do this **last**. The marketing site is not needed for the Abrica pilot — the
pilot runs from a single proposal link.

## Independence

This site shares nothing with the other three apps. No imports, no shared
config, no cookies, no scripts from `app.buildclose.app` or
`agent.buildclose.app`. The only outbound link is the customer sign-in, which
points at `https://app.buildclose.app` and carries no state.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The page |
| `styles.css` | All styling (no inline styles — the CSP forbids them) |
| `app.js` | The interactive demo, nothing else |
| `thanks.html` | Form success page |
| `netlify.toml` | Headers, CSP, caching |
| `assets/logo.png` | Approved logo, original |
| `assets/logo-transparent.png` | Transparent background, for light surfaces |
| `assets/logo-white.png` | Navy knocked out to white, for dark surfaces |

## Brand

| Token | Value | Source |
| --- | --- | --- |
| Navy | `#01338c` | Sampled from the approved logo |
| Green | `#69c002` | Sampled from the approved logo |

## Demo data

The interactive demonstration uses **fictional** data: a fictional agency
("Meridian Studio") and a fictional client ("Northwind & Co."). It runs entirely
client-side with scripted answers — there is no API call and no model. It is
labelled as a demonstration on the page, because a visitor must not mistake a
scripted answer for a live assistant.

## Claims policy

The page contains **no** testimonials, customer counts, conversion rates,
revenue figures, or pricing. Nothing on it asserts a measurable outcome. If a
figure is ever added, it needs a real source and the user's sign-off — do not
add one speculatively.

## Request-a-demo form

Uses **Netlify Forms** (`data-netlify="true"`), so submissions appear under
Forms in the Netlify dashboard with no backend and no third-party service.
A `mailto:` fallback link is shown beneath it. The form only functions once the
site is deployed to Netlify; on a preview server the submit button just
navigates. Netlify Form submissions are **not** enabled until the deploy is
done and the form is detected.

**Important:** because the form collects a prospect's name, email and company,
it is a personal-data entry point. Check that your privacy notice covers it
before the site goes live publicly.
