# TV10 India newsroom automation

A separate GitHub Actions project for the TV10 India website. Upload this folder's
contents to a new repository; do not upload the entire TV10 website or any real
environment files. No website files need changing.

## What it does

- Targets 18 Hindi articles: two each for `up`, `uk`, `delhi`, `world`, `dharma`,
  `business`, `sports`, `national`, and `lifestyle`. Mystery is excluded.
- Uses TV10's `national` category instead of Aaj Ka Sach's `others` category.
- Accepts smaller batches: at least one validated article is required. Zero valid
  articles still fails without writing anything. Eighteen is a target, not a guarantee.
- Keeps valid articles when another article fails and gives failed articles one
  correction, with bounded retries for malformed Gemini responses.
- Retains evidence, length, Hindi-text, source and duplicate checks.
- Writes text-only articles. No photo is searched for, downloaded or uploaded,
  because photos matched to a story by keyword were too often of the wrong subject.
  The TV10 website shows its logo where a post has no photo.
- Never publishes. Every article is written as an unpublished Sanity draft with
  `editorialStatus: "in-review"`, so it waits in the Studio's **👀 Needs review**
  list until an editor approves it (see [Approving articles](#approving-articles)).
  Drafts carry `priority: 0`, `isBreaking: false`, and TV10's existing
  `author-news-desk` reference. It does not invent a named author.
- Pins the destination to project `uh81euwc`, dataset `production`; another site's
  project ID is rejected. It never modifies Aaj Ka Sach's project or local files.
- Uses independent `drafts.tv10-newsroom-...` document IDs. If a batch already
  exists for that IST day, a rerun only reports how many of its posts are published
  and how many are still drafts; it writes nothing. A partial batch is not topped up
  later that day. One-article tests use a separate ID prefix.
- Reads the drafts back after writing them and verifies them. Approved automation
  posts have normal priority, so existing priority stories stay ahead of them.

Automated validation does not establish factual accuracy. An editor should check
each article's facts and sources before approving it.

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
| `SANITY_API_TOKEN` | A token with write access to TV10 project `uh81euwc`. Do not copy a token that only grants access to Aaj Ka Sach. |

The Sanity token is only passed to the runner in publish mode. Public dataset
queries are still made during a dry-run, but without the token they cannot see
drafts waiting for approval, so a dry-run may pick stories that are already
pending; it still writes nothing. Never paste either key into source files,
repository variables, screenshots or chat.

### Repository variables

| Name | Initial value |
| --- | --- |
| `GEMINI_MODEL` | Exact supported model ID from your AI Studio account, without the `models/` prefix. |
| `SANITY_PROJECT_ID` | `uh81euwc` |
| `SANITY_DATASET` | `production` |
| `NEWSROOM_ENABLED` | `false` until manual testing is complete. |
| `NEWSROOM_PUBLISH` | `false` until you want scheduled runs to write drafts for approval. |
| `NEWSROOM_REQUEST_INTERVAL_MS` | `15000` |

`NEWSROOM_ARTICLE_COUNT` and `NEWSROOM_CATEGORY` come from the workflow form; no
repository variables are needed for them. The workflow runs offline tests first.

## First test: one article

1. Open **Actions > TV10 India Hindi newsroom > Run workflow**.
2. Select the default branch, mode **dry-run**, article count **1**, category **up**.
3. Start the workflow. This uses Gemini and public source/Sanity reads, but creates
   no Sanity posts.
4. Download the `tv10-newsroom-<run-id>-<attempt>` artifact from the run summary.
   Read `report.md`, `report.json` and, when validation succeeds, `documents.json`.
5. After review, start a new run with **publish** and **1**. This writes one test
   article to Sanity as a draft awaiting approval; nothing appears on the website
   until an editor approves it.
6. To test the complete daily batch, use **dry-run** and **18**. The category dropdown
   only applies to one-article runs.

Publish mode checks that the existing TV10 News Desk author document is present
before spending Gemini requests. If that check fails, fix the author setup first;
do not remove the required author reference. The supplied website already has an
author backfill script, but this automation does not run it or modify staff profiles.

## Approving articles

Publish mode only writes drafts; an editor decides what goes live. In the TV10
Studio at `/studio`:

1. Open **👀 Needs review**. Newsroom drafts are listed there.
2. Open a post and check its facts, headline and category. The run's `report.md`
   lists each article's source links. Edit anything that needs it; you can also add
   a photo.
3. Choose **Approve & publish** from the document actions, in the menu beside
   **Publish**. It sets the status to approved and publishes in one step. It is
   offered only to administrator and editor accounts, and stays disabled while a
   required field is empty.

Do not use the plain **Publish** button for these posts. It publishes the post
still marked as in review, so the website keeps hiding it and the Studio lists it
under **⚠️ Published but blocked**. Using **Approve & publish** on it fixes that.

To reject a story, use **Send back to draft** or delete it.

Worth knowing:

- **Published at** is when the newsroom wrote the draft, not when it was approved.
  The website orders stories of equal priority by this date, so update it when
  approving late if the story should appear as new.
- Drafts in review or sent back count as recent posts: for 14 days the newsroom
  will not reuse their sources or headlines. Deleting a draft frees them, so the
  same story may be written again while it is still in the news feeds; send it back
  instead to keep it out.
- Once a day's batch is written, later runs that day only report on it. They do not
  replace rejected stories or top the batch up. If every post of the day is deleted,
  a new run writes a fresh batch.
- The Studio may show an "Unknown field" notice for `newsroom`. It holds the
  article's sources and evidence, and the duplicate check reads it; leave it in place.

## Automatic schedule

The included cron is `0 5 * * *`: daily at **10:30 AM India time** (05:00 UTC).
Once manual testing succeeds, set `NEWSROOM_ENABLED=true`. Scheduled runs request
18 articles. They remain dry-runs unless `NEWSROOM_PUBLISH=true`, in which case they
write the day's articles as drafts for approval.

Manual publish runs are explicitly controlled by the mode input, not by
`NEWSROOM_PUBLISH`. Keep the workflow on the default branch. Scheduled start times
are not a guarantee; use a manual run for immediate testing. If both websites use
the same Gemini key and encounter quota errors, stagger their schedules rather
than repeatedly rerunning failed batches.

## Failure diagnostics

- `0 validated`: inspect the per-article warnings. Nothing was written to Sanity.
- Fewer than 18 but at least one valid: the smaller batch is allowed.
- HTTP 401/403: check the TV10 token, project and dataset. Do not change to the other
  site's project ID to work around an authentication failure.
- Evidence/length errors: the article is rejected, not padded or given invented proof.
- `already-written`: that IST day's batch exists. The report shows how many of its
  posts editors have published and how many are still drafts. No replacement or
  top-up is performed.
- Uncertain write (for example a timeout): the write is not retried. The runner
  reads the drafts back; if they are all there, the run succeeds with a warning.
- Gemini quota/unavailability: changing the article minimum does not bypass API
  errors. The runner still stops on fatal API errors.

## Optional local checks

No PowerShell is required for the browser workflow above. For local development,
use Node 22.12+ and `npm run newsroom:install`, then `npm run newsroom:test`.
Tests mock network requests; they do not generate news or write to Sanity.

For a local configuration check, copy `.env.example` to `.env.newsroom` and fill it
privately, then run `npm run newsroom:check`. This validates configuration only,
not credentials or quota. Never upload `.env.newsroom`.
