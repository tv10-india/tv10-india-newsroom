import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import {
  CATEGORIES, PLACE_CATEGORIES, QuotaError, ArticleStructureError, ArticleLengthError, ArticleEvidenceError, ArticleValidationError, GeminiResponseError, assert, batchPlan, characterCount, collectSources, dayInIndia, makeDocument,
  IMAGE_DOMAINS, findImage, imageContentType, postIds, request, requestJson, similarTitle, validateArticleCandidates, verifyPosts,
} from './core.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

export function configuration(env = process.env) {
  const config = {
    key: env.GEMINI_API_KEY ?? '', model: env.GEMINI_MODEL ?? '',
    project: env.SANITY_PROJECT_ID || 'uh81euwc', dataset: env.SANITY_DATASET || 'production',
    token: env.SANITY_API_TOKEN ?? '', interval: Number(env.NEWSROOM_REQUEST_INTERVAL_MS || 15000),
    plan: batchPlan(Number(env.NEWSROOM_ARTICLE_COUNT || 1), env.NEWSROOM_CATEGORY || 'up'),
  };
  assert(/^[a-z0-9]+$/.test(config.project) && /^[a-zA-Z0-9_-]+$/.test(config.dataset), 'Invalid Sanity project or dataset');
  assert(config.project === 'uh81euwc' && config.dataset === 'production', 'This automation targets only TV10 India: project uh81euwc, dataset production. Do not use another website project.');
  assert(Number.isFinite(config.interval) && config.interval >= 1000 && config.interval <= 120000, 'Request interval must be 1000-120000 milliseconds');
  return config;
}

function requireGemini(config) {
  assert(config.key && !config.key.startsWith('replace-'), 'Set GEMINI_API_KEY in .env.newsroom or GitHub Actions secrets');
  assert(/^[a-zA-Z0-9._-]+$/.test(config.model) && !config.model.startsWith('replace-'), 'Set GEMINI_MODEL to a free-tier model ID from AI Studio (without models/)');
}

export function sanityClient(config) {
  const host = `${config.project}.api.sanity.io`;
  const base = `https://${host}/v2024-01-01`;
  const headers = config.token ? { Authorization: `Bearer ${config.token}` } : {};
  return {
    async query(query, params = {}) {
      const url = new URL(`${base}/data/query/${config.dataset}`);
      url.searchParams.set('query', query);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(`$${key}`, JSON.stringify(value));
      const result = await requestJson(url, { domains: [host], label: 'Sanity query', headers });
      assert(!result.error && result.result !== undefined, 'Sanity query failed');
      return result.result;
    },
    async upload(image, preparedBytes) {
      assert(config.token, 'Publishing requires SANITY_API_TOKEN');
      assert(image?.kind === 'real-photo' && Buffer.isBuffer(preparedBytes) && preparedBytes.length > 8 && preparedBytes.length <= 12_000_000, 'Missing or oversized prepared photo');
      assert(createHash('sha256').update(preparedBytes).digest('hex') === image.sha256, 'Photo integrity check failed');
      const type = imageContentType(preparedBytes);
      const result = await requestJson(`${base}/assets/images/${config.dataset}`, {
        domains: [host], label: 'Sanity asset upload', method: 'POST', retries: 0,
        headers: { ...headers, 'Content-Type': type }, body: preparedBytes,
      });
      assert(result.document?._id, 'Asset upload did not return an ID; inspect Sanity before retrying');
      return result.document._id;
    },
    async publish(documents) {
      assert(config.token, 'Publishing requires SANITY_API_TOKEN');
      await requestJson(`${base}/data/mutate/${config.dataset}?visibility=sync`, {
        domains: [host], label: 'Sanity publication transaction', method: 'POST', retries: 0,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mutations: documents.map((document) => ({ createIfNotExists: document })) }),
      });
    },
  };
}

function articleResponseSchema(count) {
  const string = { type: 'STRING' };
  return {
    type: 'OBJECT',
    properties: {
      articles: {
        type: 'ARRAY', minItems: 0, maxItems: count,
        description: 'Return only supported distinct stories, up to the requested count. Return fewer or none rather than inventing facts.',
        items: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING', description: 'Hindi headline in Devanagari, with no Latin letters.' },
            slug: { type: 'STRING', description: 'Lowercase ASCII words separated by hyphens, at most 90 characters.' },
            district: { type: 'STRING', description: 'Place in Devanagari, or an empty string.' },
            tags: { type: 'ARRAY', minItems: 3, maxItems: 6, items: { type: 'STRING', description: 'Hindi tag in Devanagari, with no Latin letters.' } },
            sourceIds: { type: 'ARRAY', minItems: 1, maxItems: 3, items: string },
            evidence: {
              type: 'ARRAY', minItems: 1, maxItems: 3,
              items: {
                type: 'OBJECT',
                properties: {
                  sourceId: string,
                  quote: { type: 'STRING', description: 'Copy 30-180 characters verbatim from this source text. Never translate evidence.' },
                },
                required: ['sourceId', 'quote'],
              },
            },
            imageQueries: { type: 'ARRAY', maxItems: 3, items: string },
            blocks: {
              type: 'ARRAY', minItems: 5, maxItems: 20,
              description: 'Prefer five paragraphs and two headings. The complete Hindi body must contain 1500-2900 Unicode characters, including headings.',
              items: {
                type: 'OBJECT',
                properties: {
                  type: { type: 'STRING', enum: ['paragraph', 'heading', 'bullet'] },
                  text: { type: 'STRING', description: 'Nonempty Hindi text in Devanagari, not an array or object. No Latin letters.' },
                },
                required: ['type', 'text'],
              },
            },
          },
          required: ['title', 'slug', 'district', 'tags', 'sourceIds', 'evidence', 'imageQueries', 'blocks'],
        },
      },
      skipped: { type: 'ARRAY', items: string, description: 'Explain shortages without inventing articles.' },
    },
    required: ['articles', 'skipped'],
  };
}

export async function generate(config, prompt, category, sources, alreadyUsed, count = 2, correctionRequest = null) {
  const response = await requestJson(`https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`, {
    domains: ['generativelanguage.googleapis.com'], label: 'Gemini generation', method: 'POST',
    headers: { 'x-goog-api-key': config.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: prompt }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify({ category, requestedArticleCount: count, todayIST: dayInIndia(), sources, alreadyUsed, ...(correctionRequest ? { correctionRequest } : {}) }) }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: articleResponseSchema(count), maxOutputTokens: count === 1 ? 8000 : 14000 },
    }),
  });
  const candidate = response.candidates?.[0];
  const parts = (candidate?.content?.parts ?? []).filter((part) => !part.thought);
  const text = parts.map((part) => part.text ?? '').join('');
  // "Gemini response blocked or truncated" and "Gemini returned invalid JSON" threw away
  // the only evidence of what went wrong, and a category died on a dead-end message. Say
  // which way it failed and show enough of the response to tell truncation from refusal.
  if (candidate?.finishReason !== 'STOP') {
    const blocked = response.promptFeedback?.blockReason ? `, promptFeedback.blockReason=${response.promptFeedback.blockReason}` : '';
    throw new GeminiResponseError(`Gemini stopped early: finishReason=${candidate?.finishReason ?? 'none'}${blocked}, ${characterCount(text)} characters returned. MAX_TOKENS means the response outgrew the output budget; SAFETY or RECITATION mean the request itself was refused.`);
  }
  try { return JSON.parse(text); }
  catch (error) {
    throw new GeminiResponseError(`Gemini returned unparseable JSON (${error.message}): ${parts.length} content part(s), ${characterCount(text)} characters. Response starts: ${text.slice(0, 160).replace(/\s+/g, ' ') || '(empty)'}`);
  }
}

export async function generateValidatedCategory({ config, prompt, category, sources, alreadyUsed = [], used = new Set(), count = 2, beforeRequest = async () => {}, onWarning = async () => {} }) {
  let articles = [];
  let correctionRequest = null;
  let requestedCount = count;
  for (let attempt = 0; attempt < 3; attempt++) {
    await beforeRequest();
    let payload;
    try {
      payload = await generate(config, prompt, category, sources, [...alreadyUsed, ...articles.map((article) => article.title)], requestedCount, correctionRequest);
    } catch (error) {
      if (!(error instanceof GeminiResponseError)) throw error;
      await onWarning(`${category}: ${error.message}${attempt < 2 ? ' Asking again, unchanged.' : ' No requests remain; retaining any validated articles.'}`);
      continue;
    }
    if (Array.isArray(payload?.skipped) && payload.skipped.length) await onWarning(`${category}: model reported ${payload.skipped.length} skipped items`);
    let result;
    try {
      result = validateArticleCandidates(payload, category, sources, used, requestedCount, articles);
    } catch (error) {
      if (!(error instanceof ArticleStructureError)) throw error;
      await onWarning(error.message);
      break;
    }
    articles = result.articles;
    for (const failure of result.failures) await onWarning(`${category}: articles[${failure.index}]: ${failure.error.message}`);
    const retryable = result.failures.filter(({ error }) => error instanceof ArticleStructureError || error instanceof ArticleLengthError || error instanceof ArticleEvidenceError || error instanceof ArticleValidationError);
    if (!retryable.length || correctionRequest || attempt === 2) break;
    const previousResponse = { articles: retryable.map(({ article }) => article), skipped: [] };
    if (JSON.stringify(previousResponse).length > 40000) break;
    correctionRequest = {
      validationError: retryable.map(({ error }, index) => `articles[${index}]: ${error.message}`).join('\n'),
      previousResponse,
    };
    requestedCount = retryable.length;
    await onWarning(`${category}: retaining ${articles.length} validated article(s). Requesting one correction for ${requestedCount} failed article(s), including all reported length, language and evidence errors; this consumes another Gemini request.`);
  }
  if (articles.length < count) await onWarning(`${category}: accepted ${articles.length} of ${count} requested article(s); batch minimum is unchanged`);
  return articles;
}

export async function verifyHomepage(client, posts) {
  let last = 'Homepage has not refreshed';
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await sleep(15000);
    try {
      const newest = await client.query('*[_type == "post" && (!defined(editorialStatus) || editorialStatus == "published") && !(_id in path("drafts.**")) && defined(slug.current) && slug.current != "" && defined(title) && defined(publishedAt) && dateTime(publishedAt) <= dateTime(now())] | order(coalesce(priority, 0) desc, publishedAt desc)[0]{"slug":slug.current}');
      const result = await request('https://www.tv10india.com', { domains: ['tv10india.com', 'www.tv10india.com'], label: 'Homepage', retries: 0 });
      const page = load(result.bytes.toString('utf8'));
      const lead = page('h1').first().closest('a').attr('href');
      const visible = posts.filter((post) => page(`a[href="/news/${post.slug.current}"]`).length > 0).length;
      assert(lead === `/news/${newest?.slug}`, 'Homepage verification: highest-priority lead does not match Sanity');
      let verifiedArticlePages = 0;
      for (const post of posts.slice(0, 3)) {
        const articleResponse = await request(`https://www.tv10india.com/news/${post.slug.current}`, { domains: ['tv10india.com', 'www.tv10india.com'], label: 'Published article', retries: 0 });
        const articlePage = load(articleResponse.bytes.toString('utf8'));
        assert(articlePage('h1').first().text().replace(/\s+/g, ' ').trim() === post.title.replace(/\s+/g, ' ').trim(), `Published article is not visible yet: ${post.slug.current}`);
        verifiedArticlePages++;
      }
      return { lead, visibleBatchLinks: visible, verifiedArticlePages };
    } catch (error) { last = error.message; }
  }
  throw new Error(`${last}. Posts may already be live; do not delete or recreate them.`);
}

function reportMarkdown(report) {
  const safe = (value) => String(value).replace(/[\r\n|<>]/g, ' ');
  const lines = [
    '# Newsroom run', '', `Date (IST): ${report.day}`, `Mode: ${report.mode}`, `Requested articles: ${report.requestedCount}`, `Validated articles: ${report.articles.length}`, `Categories: ${report.categories.join(', ')}`, `Status: ${report.status}`, '',
    'Generated content and image relevance require editorial review. Automated checks do not establish factual accuracy.', '',
    '| Category | Headline | Published UTC | Image licence |', '| --- | --- | --- | --- |',
    ...report.articles.map((article) => `| ${safe(article.category)} | ${safe(article.title)} | ${safe(article.publishedAt ?? 'not published')} | ${safe(article.image?.license ?? article.newsroom?.image?.license ?? 'not resolved')} |`),
    '', '## Verification', '```json', JSON.stringify(report.verification ?? {}, null, 2), '```', '', '## Sources and images',
  ];
  for (const article of report.articles) {
    lines.push(`- ${safe(article.title)}`);
    for (const source of article.sources ?? article.newsroom?.sources ?? []) lines.push(`  - Source: ${safe(source.url)}`);
    const image = article.image ?? article.newsroom?.image;
    if (image) {
      lines.push(`  - Image: ${safe(image.pageUrl)}; ${safe(image.license)}; creator: ${safe(image.creator)} (credit-free licence; no on-page credit published)`);
      if (/^photo-[a-z]+-\d+\.(png|jpg|webp)$/.test(image.fileName ?? '')) lines.push('', `![Representative photo](./${image.fileName})`, '');
    } else lines.push('  - No image: article is ready for text-only publication.');
  }
  lines.push('', '## Warnings / failures', ...report.warnings.map((warning) => `- ${safe(warning)}`));
  if (report.error) lines.push(`- ${safe(report.error)}`);
  return `${lines.join('\n')}\n`;
}

export async function main(args = process.argv.slice(2)) {
  assert(args.length <= 1 && (!args.length || ['--help', '--check', '--dry-run', '--publish'].includes(args[0])), 'Use --check, --dry-run, or --publish');
  if (!args.length || args[0] === '--help') {
    console.log('Newsroom: --check (offline config check), --dry-run (no Sanity writes), --publish (live publication). Defaults to one article; see README.md.');
    return;
  }
  const config = configuration();
  const plan = config.plan;
  const mode = args[0] === '--publish' ? 'publish' : 'dry-run';
  const feeds = JSON.parse(await readFile(new URL('./feeds.json', import.meta.url), 'utf8'));
  assert(CATEGORIES.every((category) => Array.isArray(feeds[category]) && feeds[category].length), 'Feed configuration must cover all active categories');
  requireGemini(config);
  if (args[0] === '--check') {
    console.log(`Offline configuration valid: ${plan.count} article(s), categories ${plan.categories.join(', ')}. Sanity publish token: ${config.token ? 'configured' : 'not configured (dry-run only)'}. Credentials and quotas were NOT tested.`);
    return;
  }
  if (mode === 'publish') assert(config.token, 'Set SANITY_API_TOKEN before publishing');
  const now = new Date();
  const day = dayInIndia(now);
  const output = resolve(ROOT, 'newsroom-output', `${day}-${mode}-${Date.now()}`);
  await mkdir(output, { recursive: true });
  const report = { day, mode, requestedCount: plan.count, categories: plan.categories, status: 'started', articles: [], warnings: [], verification: {} };
  // The dispatch form always sends a category (the input is required), so state what the run
  // will actually cover: an 18-article run ignores that choice and takes every category.
  console.log(plan.count === 1 ? `Plan: 1 article from ${plan.categories[0]}.` : `Plan: ${plan.count} articles, ${plan.perCategory} from each of ${plan.categories.join(', ')}. The category input applies only to a 1-article run.`);
  const client = sanityClient(config);
  const preparedImages = new Map();
  const ids = postIds(day, plan);
  const getBatch = () => client.query('*[_id in $ids]', { ids });
  const writeReport = async () => {
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(resolve(output, 'report.md'), reportMarkdown(report));
  };
  try {
    if (mode === 'publish') {
      const desk = await client.query('*[_type == "author" && _id == "author-news-desk"][0]{_id}');
      assert(desk?._id === 'author-news-desk', 'TV10 News Desk author is missing. Set up the existing author-news-desk profile in the TV10 project before publishing; no generation or writes performed.');
    }
    const existing = await getBatch();
    if (existing.length) {
      report.articles = existing;
      report.verification = verifyPosts(existing, day, plan);
      report.status = 'already-published';
      if (mode === 'publish') report.verification.homepage = await verifyHomepage(client, existing);
      console.log('This IST day already has a published batch. No generation or writes performed; a smaller batch is not topped up.');
      return;
    }
    // Fourteen days, not three. parseFeed already drops items older than 48 hours, so a
    // repeat of the same URL was never possible past 72 hours anyway; the long window
    // exists for headlines — the same story picked up later by a different outlet.
    const recent = await client.query('*[_type == "post" && publishedAt >= $since && !(_id in path("drafts.**"))] | order(publishedAt desc){title,"sourceIds":newsroom.sourceIds}', { since: new Date(now.getTime() - 14 * 24 * 3600000).toISOString() });
    const used = new Set(recent.flatMap((post) => post.sourceIds ?? []));
    const prompt = await readFile(new URL('./editorial-prompt.md', import.meta.url), 'utf8');
    const pools = {};
    const feedCategories = [...new Set([...plan.categories, 'national'])];
    for (const category of feedCategories) {
      console.log(`Collecting sources: ${category}`);
      pools[category] = await collectSources(feeds[category], now, report.warnings, used);
    }
    let lastRequest = 0;
    // Every source ID is kept (short strings, exact matching), but the titles go into the
    // prompt, so only the newest 120 are carried to keep the request size sane.
    const alreadyUsed = recent.map((post) => post.title).filter((title) => typeof title === 'string').slice(0, 120);
    for (const category of plan.categories) {
      try {
        const local = pools[category].filter((source) => !used.has(source.id));
        if (!local.length && pools[category].length) report.warnings.push(`${category}: all ${pools[category].length} recent source(s) were already used by a post from the last 14 days; the feed has published nothing new since the last run`);
        // General news is a safety net for a category whose own feeds ran dry, not routine
        // filler. It used to be merged unconditionally and the list padded to 8, which is how
        // national stories (electoral rolls, SIR) ended up published under lifestyle.
        // Only a place category may draw on it: editorial-prompt.md tells the model that a
        // national story with real bearing on up/uk/delhi is acceptable but that general news
        // is NOT a substitute under a topic category. Topping lifestyle up with politics
        // therefore spends a Gemini request to be refused, and the refusal arrives as a
        // malformed article rather than a clean skip.
        const fallback = local.length >= plan.perCategory + 2 || !PLACE_CATEGORIES.has(category) ? []
          : [...(pools.national ?? []), ...(pools.world ?? [])].filter((source) => !used.has(source.id));
        if (fallback.length) report.warnings.push(`${category}: only ${local.length} on-topic source(s); topped up from general news`);
        const sources = [...new Map([...local, ...fallback].map((source) => [source.id, source])).values()].slice(0, 8);
        assert(sources.length >= plan.perCategory, `${category}: insufficient recent, readable sources (${local.length} on-topic${PLACE_CATEGORIES.has(category) ? `, ${fallback.length} general-news fallback` : '; topic categories take no general-news fallback'})`);
        console.log(`Generating and validating: ${category}`);
        const articles = await generateValidatedCategory({
          config, prompt, category, sources, alreadyUsed, used, count: plan.perCategory,
          beforeRequest: async () => {
            await sleep(Math.max(0, config.interval - (Date.now() - lastRequest)));
            lastRequest = Date.now();
          },
          onWarning: async (warning) => {
            report.warnings.push(warning);
            console.warn(warning);
            await writeReport();
          },
        });
        assert(articles.length, `${category}: no articles passed validation`);
        // Drop near-duplicates of anything already published or generated earlier in this
        // batch, rather than failing the category: one repeated story should not also cost
        // the fresh article next to it.
        const fresh = articles.filter((article) => {
          const clash = alreadyUsed.find((title) => similarTitle(title, article.title));
          if (clash) {
            report.warnings.push(`${category}: skipped "${article.title}" as a repeat of "${clash}"`);
            // Burn the sources too, so a later category cannot pick the same story up again.
            article.sourceIds.forEach((sourceId) => used.add(sourceId));
          }
          return !clash;
        });
        assert(fresh.length, `${category}: every generated headline repeats a recent article`);
        for (const article of fresh) {
          article.sourceIds.forEach((sourceId) => used.add(sourceId));
          alreadyUsed.push(article.title);
          report.articles.push(article);
          article.image = null;
          try {
            assert(article.imageQueries.length, 'No usable photo search terms');
            const image = await findImage(article.imageQueries[0], article.imageQueries.slice(1));
            const downloaded = await request(image.download, { domains: IMAGE_DOMAINS, label: 'Photo download', maxBytes: 12_000_000, retries: 0 });
            const type = imageContentType(downloaded.bytes);
            assert(downloaded.type.split(';')[0] === type, 'Photo content type does not match its bytes');
            const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[type];
            const fileName = `photo-${article.category}-${report.articles.length}.${extension}`;
            await writeFile(resolve(output, fileName), downloaded.bytes);
            preparedImages.set(fileName, downloaded.bytes);
            article.image = { ...image, fileName, sha256: createHash('sha256').update(downloaded.bytes).digest('hex') };
          } catch (error) {
            const warning = `${category}: no image; continuing text-only. ${error.message}`;
            report.warnings.push(warning);
            console.warn(warning);
          }
        }
      } catch (error) {
        const warning = error.message.startsWith(`${category}:`) ? error.message : `${category}: ${error.message}`;
        report.warnings.push(warning);
        console.warn(warning);
        if (error instanceof QuotaError || error.message.startsWith('Gemini generation:')) throw error;
      }
      await writeReport();
    }
    assert(report.articles.length >= plan.minimum, `Batch too small: got ${report.articles.length} validated article(s), need at least ${plan.minimum} of ${plan.count}. No posts published. See report.`);
    if (report.articles.length < plan.count) report.warnings.push(`Publishing ${report.articles.length} of ${plan.count} articles; ${plan.count - report.articles.length} slot(s) had no usable source or failed validation.`);
    // Slots are per-category, not derived from the overall index: a category that yielded
    // only one article would otherwise shift every later article onto the wrong ID.
    const slots = new Map();
    const documents = report.articles.map((article, index) => {
      const slot = (slots.get(article.category) ?? 0) + 1;
      slots.set(article.category, slot);
      return makeDocument(article, index, day, now, 'dry-run-placeholder', plan, slot);
    });
    report.verification = verifyPosts(documents, day, plan);
    await writeFile(resolve(output, 'documents.json'), JSON.stringify(documents, null, 2));
    if (mode === 'dry-run') {
      report.status = 'dry-run-ready-for-review';
      console.log('Dry-run complete. No Sanity assets or posts were written.');
      return;
    }
    assert(dayInIndia() === day, 'IST date changed during the run; refusing publication');
    assert((await getBatch()).length === 0, 'Another publisher created this batch; rerun to verify instead');
    const slugConflicts = await client.query('*[_type == "post" && slug.current in $slugs]{_id}', { slugs: documents.map((document) => document.slug.current) });
    assert(slugConflicts.length === 0, 'An article slug already exists; inspect the conflict before publishing');
    for (let index = 0; index < documents.length; index++) {
      const image = report.articles[index].image;
      if (!image) continue;
      documents[index].mainImage.asset._ref = await client.upload(image, preparedImages.get(image.fileName));
      await writeFile(resolve(output, 'documents.json'), JSON.stringify(documents, null, 2));
    }
    assert(dayInIndia() === day, 'IST date changed during uploads; refusing publication');
    try { await client.publish(documents); }
    catch (error) { report.warnings.push(`${error.message}; checking the effect without retrying the write`); }
    let published = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(2000);
      published = await getBatch();
      if (published.length === documents.length) break;
    }
    report.verification = verifyPosts(published, day, plan);
    report.articles = published;
    report.status = 'published';
    await writeReport();
    report.verification.homepage = await verifyHomepage(client, published);
    console.log(`Published and verified ${published.length} of ${plan.count} article(s).`);
  } catch (error) {
    report.status = report.status === 'published' || report.status === 'already-published' ? 'published-verification-failed' : 'failed';
    report.error = error.message;
    throw error;
  } finally {
    await writeReport();
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, reportMarkdown(report));
    console.log(`Report saved: ${output}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const secrets = [process.env.GEMINI_API_KEY, process.env.SANITY_API_TOKEN].filter(Boolean);
    let message = error.message;
    for (const secret of secrets) message = message.replaceAll(secret, '[redacted]');
    console.error(message);
    process.exitCode = 1;
  });
}
