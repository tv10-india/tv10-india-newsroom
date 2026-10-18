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
  project ID is rejected. It never modifies Aaj Ka Sach's project or local files. It
  does read Aaj Ka Sach's published headlines, without a token, so that the two sites
  do not run the same stories (see [Two sites, different news](#two-sites-different-news)).
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

## Two sites, different news

TV10 India and Aaj Ka Sach run this same newsroom on the same feeds. Left alone they
pick the same stories: in the 14 days to 17 Oct 2026, 69 pairs of posts, one on each
site, were written from the same source article. Two rules keep them apart.

- **Each source article belongs to one site.** A source's ID is a hash of its address,
  with tracking tags removed. IDs starting `0`-`7` belong to Aaj Ka Sach, `8`-`f` to
  TV10 India. Both sites read every feed, but each fetches and writes from its own half
  only, so the two never write from the same article. The rule (`sourceSite` in
  `core.mjs`) must stay identical in both repositories, and a test in each pins it.
- **Each site checks the other's headlines.** Before writing, the runner reads Aaj Ka
  Sach's posts from the last 14 days from its public Sanity CDN (project `g1o8uwxq`).
  This is a plain read: no token is sent, and nothing is ever written there. The newest
  60 of its headlines join this site's own in `alreadyUsed`, so the model is told not to
  retell them, and a generated headline too close to one of them is dropped with a
  warning. Its source IDs count as used. `report.md` says how many of its posts were
  checked. If the read fails, the run carries on with a warning; the split still holds.

What this cannot catch: the public CDN shows published posts only, so drafts still
waiting for approval on the other site are invisible. Both sites can therefore write
same-day drafts about one event from two outlets' reports. Check the other site before
approving a story that looks familiar.

The split works only once both repositories run it, so upload the update to both.
Each site now has half as many candidate stories per feed, which is why the feed list
below was widened. If a category is left with a single usable source, the runner asks
for one article instead of two and says so in the report.

## Where the stories come from

[`feeds.json`](./scripts/newsroom/feeds.json) lists 54 feeds from nine publishers. Aaj
Ka Sach's copy is the same except that it calls the `national` category `others`.

| Category | Publishers |
| --- | --- |
| `up` | Dainik Bhaskar, Amar Ujala, TV9 Bharatvarsh, India TV, ABP Live |
| `uk` | Dainik Bhaskar (its Uttarakhand section page, as it has no feed), Amar Ujala, TV9 Bharatvarsh |
| `delhi` | ABP Live (two feeds), Dainik Bhaskar, TV9 Bharatvarsh, India TV |
| `world` | Dainik Bhaskar, BBC News (English), TV9 Bharatvarsh, India TV, ABP Live, Prabhat Khabar, Moneycontrol Hindi |
| `dharma` | ABP Live, Amar Ujala, TV9 Bharatvarsh, Prabhat Khabar, India TV |
| `business` | Dainik Bhaskar, ABP Live, TV9 Bharatvarsh, India TV, Moneycontrol Hindi, Prabhat Khabar |
| `sports` | Dainik Bhaskar, BBC Sport (English), TV9 Bharatvarsh, India TV, ABP Live, Prabhat Khabar, Moneycontrol Hindi |
| `national` | Dainik Bhaskar, ABP Live (two feeds), TV9 Bharatvarsh, India TV, Prabhat Khabar, BBC Hindi, Moneycontrol Hindi, Times Now Navbharat |
| `lifestyle` | ABP Live (two feeds), TV9 Bharatvarsh, India TV (two feeds), Prabhat Khabar (two feeds) |

**robots.txt is obeyed.** Before a feed or an article is fetched, the runner reads that
site's `robots.txt` (once per site per run) and skips anything it closes, following
the standard search engines use (RFC 9309). TV9, for example, closes every address
containing `/astrology/` and Prabhat Khabar every address with a query string, and
nothing stops their own feeds linking to such pages. The newsroom names itself as
`TV10IndiaNewsroom/1.0`, so a site can address it by that name. A site with no
`robots.txt` closes nothing; a site whose file cannot be read (a server error or a
timeout) is skipped for that run, and the report shows a `Feed …` warning.

Bhaskar, BBC and Moneycontrol close their sites to named AI crawlers, GPTBot and
Google-Extended among them. Those rules name other crawlers, not this newsroom, so
they do not apply to it; whether to keep using those publishers is an editorial call.

Hindi outlets left out, as checked on 17 Oct 2026 with the newsroom's own name:

| Outlet | Why |
| --- | --- |
| Live Hindustan | Its feed server's `robots.txt` closes everything (`Disallow: /`). |
| Oneindia Hindi | `robots.txt` closes everything, and the site refuses the newsroom (HTTP 403). |
| Patrika | `robots.txt` closes `*/blog/*`, and every Patrika feed is under it. |
| ETV Bharat | `robots.txt` closes its Hindi news sections. |
| News18 Hindi, NDTV India | They refuse the newsroom (HTTP 403). |
| Dainik Jagran, Navbharat Times | Their feeds are gone or empty. |
| Zee News, Zee Business, Punjab Kesari, Webdunia | No usable feed. |
| Jansatta | Its feeds carry XML `DOCTYPE` declarations, which the feed reader refuses for safety. |
| DW Hindi | Feed empty. |
| Aaj Tak | Only a home feed, mostly videos and horoscopes. |
| Amar Ujala Delhi | Behind a paywall. Amar Ujala's other feeds are used. |

Duplicate feeds were left out too. ABP Live's `lifestyle/religion`, `health` and
`photo-gallery/lifestyle` feeds carry exactly the items of its `religion`,
`lifestyle/health` and `lifestyle` feeds (the last was in the old list and has been
removed), and every item in BBC Hindi's international feed is also in its main feed.

The feed list and [editorial instructions](./scripts/newsroom/editorial-prompt.md)
are editable. If you add a feed on a new host, add its trusted domain to
`SOURCE_DOMAINS` in [core.mjs](./scripts/newsroom/core.mjs); a test fails until you
do. Add the feed to Aaj Ka Sach's `feeds.json` as well: each site writes from only
its half of a feed, so a feed that only one site reads leaves the other half unused.

## Failure diagnostics

- `0 validated`: inspect the per-article warnings. Nothing was written to Sanity.
- Fewer than 18 but at least one valid: the smaller batch is allowed.
- `Feed …` warnings: that feed was skipped for this run, because its site's
  `robots.txt` closes it or could not be read, or the site refused the request or
  timed out. The category's other feeds are still used. Replace a feed that is
  skipped on every run.
- `Aaj Ka Sach: recent posts could not be read`: this run did not check Aaj Ka Sach's
  headlines. The source split still keeps the two sites off the same source articles.
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
