# TV10 India newsroom automation

A separate GitHub Actions project for the TV10 India website. Upload this folder's
contents to a new repository; do not upload the entire TV10 website or any real
environment files. No website files need changing.

## What it does

- Targets 18 Hindi articles: two each for `up`, `uk`, `delhi`, `world`, `dharma`,
  `business`, `sports`, `national`, and `lifestyle`. Mystery is excluded.
- Uses TV10's `national` category instead of Aaj Ka Sach's `others` category.
- Accepts smaller batches: at least one validated article is required. Zero valid
  articles still fails without publishing. Eighteen is a target, not a guarantee.
- Keeps valid articles when another draft fails and gives failed drafts one
  correction, with bounded retries for malformed Gemini responses.
- Retains evidence, length, Hindi-text, source and duplicate checks.
- Uses a relevant CC0/public-domain real photo when available; otherwise omits the
  image. No AI pictures, headline cards, overlays, captions or image notices are
  generated. TV10's existing frontend may show its logo when a photo is absent.
- Writes TV10's `editorialStatus: "published"`, `priority: 0`, `isBreaking: false`,
  and its existing `author-news-desk` reference. It does not invent a named author.
- Pins the destination to project `uh81euwc`, dataset `production`; another site's
  project ID is rejected. It never modifies Aaj Ka Sach's project or local files.
- Uses independent `tv10-newsroom-...` document IDs. If a batch already exists for
  that IST day, rerunning verifies it instead of adding more articles. A partial
  batch is not topped up later that day. One-article tests use a separate ID prefix.
- Public verification checks Sanity documents, the priority-ordered homepage lead,
  and up to three new article pages. Existing priority stories remain ahead of
  normal-priority automation posts.

Automated validation does not establish factual accuracy. Review the report,
article facts, source relevance and photo relevance before choosing publish mode.

## Set up using GitHub in your browser

1. Create a new repository, for example `tv10-india-newsroom`.
2. Upload the contents of this folder at the repository root. Confirm that the
   workflow is at `.github/workflows/newsroom.yml`, not inside an extra outer folder.
   If the upload dialog omits the hidden `.github` folder, create that file using
   **Add file > Create new file** and paste its contents.
3. Commit all files to the repository's default branch.
4. Open **Settings > Secrets and variables > Actions**.

### Repository secrets

| Name | Value |
| --- | --- |
| `GEMINI_API_KEY` | Your Gemini API key from AI Studio. |
| `SANITY_API_TOKEN` | A token with document and image-write access to TV10 project `uh81euwc`. Do not copy a token that only grants access to Aaj Ka Sach. |

The Sanity token is only passed to the runner in publish mode. Public dataset
queries are still made during a dry-run. Never paste either key into source files,
repository variables, screenshots or chat.

### Repository variables

| Name | Initial value |
| --- | --- |
| `GEMINI_MODEL` | Exact supported model ID from your AI Studio account, without the `models/` prefix. |
| `SANITY_PROJECT_ID` | `uh81euwc` |
| `SANITY_DATASET` | `production` |
| `NEWSROOM_ENABLED` | `false` until manual testing is complete. |
| `NEWSROOM_PUBLISH` | `false` until you want scheduled runs to publish. |
| `NEWSROOM_REQUEST_INTERVAL_MS` | `15000` |

`NEWSROOM_ARTICLE_COUNT` and `NEWSROOM_CATEGORY` come from the workflow form; no
repository variables are needed for them. The workflow runs offline tests first.

## First test: one article

1. Open **Actions > TV10 India Hindi newsroom > Run workflow**.
2. Select the default branch, mode **dry-run**, article count **1**, category **up**.
3. Start the workflow. This uses Gemini and public source/Sanity reads, but creates
   no Sanity assets or posts.
4. Download the `tv10-newsroom-<run-id>-<attempt>` artifact from the run summary.
   Read `report.md`, `report.json` and, when validation succeeds, `documents.json`.
5. After review, start a new run with **publish** and **1** to publish a test article.
   Publication is an external write; choose this mode only when ready.
6. To test the complete daily batch, use **dry-run** and **18**. The category dropdown
   only applies to one-article runs.

Publishing checks that the existing TV10 News Desk author document is present
before spending Gemini requests. If that check fails, fix the author setup first;
do not remove the required author reference. The supplied website already has an
author backfill script, but this automation does not run it or modify staff profiles.

## Automatic schedule

The included cron is `0 5 * * *`: daily at **10:30 AM India time** (05:00 UTC).
Once manual testing succeeds, set `NEWSROOM_ENABLED=true`. Scheduled runs request
18 articles. They remain dry-runs unless `NEWSROOM_PUBLISH=true`.

Manual publish runs are explicitly controlled by the mode input, not by
`NEWSROOM_PUBLISH`. Keep the workflow on the default branch. Scheduled start times
are not a guarantee; use a manual run for immediate testing. If both websites use
the same Gemini key and encounter quota errors, stagger their schedules rather
than repeatedly rerunning failed batches.

## Failure diagnostics

- `0 validated`: inspect the per-article warnings. No posts were published.
- Fewer than 18 but at least one valid: the smaller batch is allowed.
- HTTP 401/403: check the TV10 token, project and dataset. Do not change to the other
  site's project ID to work around an authentication failure.
- Evidence/length errors: the draft is rejected, not padded or given invented proof.
- Already published: no replacement or top-up is performed.
- Public verification failure: posts may already be live. Inspect the report and
  website before retrying; do not delete or recreate the posts automatically.
- Gemini quota/unavailability: changing the article minimum does not bypass API
  errors. The runner still stops on fatal API errors.

## Optional local checks

No PowerShell is required for the browser workflow above. For local development,
use Node 22.12+ and `npm run newsroom:install`, then `npm run newsroom:test`.
Tests mock network requests; they do not generate news or publish.

For a local configuration check, copy `.env.example` to `.env.newsroom` and fill it
privately, then run `npm run newsroom:check`. This validates configuration only,
not credentials or quota. Never upload `.env.newsroom`.
