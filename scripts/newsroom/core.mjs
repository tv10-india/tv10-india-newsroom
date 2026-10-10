import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { load } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';

export const CATEGORIES = ['up', 'uk', 'delhi', 'world', 'dharma', 'business', 'sports', 'national', 'lifestyle'];
// Place categories only. editorial-prompt.md accepts a national story with real bearing on
// up/uk/delhi, but rules general news out as a substitute under a topic category, so only
// these three may have a dry local feed topped up from the general-news pools.
export const PLACE_CATEGORIES = new Set(['up', 'uk', 'delhi']);
const SOURCE_DOMAINS = ['amarujala.com', 'bhaskar.com', 'abplive.com', 'bbc.co.uk', 'bbci.co.uk', 'bbc.com', 'sciencedaily.com', 'nasa.gov'];
export const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 24);
export const dayInIndia = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
export function batchPlan(count = 18, category = 'up') {
  assert([1, 18].includes(count), 'Article count must be 1 or 18');
  assert(CATEGORIES.includes(category), 'Unknown newsroom category');
  return { count, minimum: 1, categories: count === 1 ? [category] : CATEGORIES, perCategory: count === 1 ? 1 : 2, prefix: count === 1 ? 'tv10-newsroom-test' : 'tv10-newsroom' };
}
export const postIds = (day, plan = batchPlan()) => plan.categories.flatMap((category) => Array.from({ length: plan.perCategory }, (_, index) => `${plan.prefix}-${day}-${category}-${index + 1}`));
export const characterCount = (text) => Array.from(text).length;
export const normalize = (text) => text.replace(/\s+/g, ' ').trim();
export const plainText = (html) => normalize(load(String(html ?? '')).text());

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function safeUrl(value, domains) {
  const url = new URL(value);
  assert(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443'), 'Only credential-free HTTPS URLs are allowed');
  assert(domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)), 'URL host is not allowed');
  return url;
}

export function canonicalSource(value) {
  const url = safeUrl(value, SOURCE_DOMAINS);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

export class QuotaError extends Error {}
// Something wrong with one article, not with the response it arrived in. validateArticles
// keeps the response's other article, and the runner spends its one correction on this one.
export class ArticleError extends Error {}
export class ArticleStructureError extends ArticleError {}
export class ArticleLengthError extends ArticleError {}
export class ArticleEvidenceError extends ArticleError {}
export class ArticleValidationError extends ArticleError {
  constructor(errors) {
    super(errors.map((error) => error.message).join('\n'));
    this.errors = errors;
  }
}
// Latin letters, outlet credits or a byline in the published text.
export class ArticleTextError extends ArticleError {}
// A story that is already taken: its headline repeats one published or accepted earlier,
// or its source already backs another article. Fixing it means writing a different story.
export class ArticleRepeatError extends ArticleError {}
// A response that never arrived in usable form. Distinct from the article errors above:
// there is nothing to correct, so the runner re-asks the same question instead.
export class GeminiResponseError extends Error {}

export async function request(url, { domains, label, retries = 2, maxBytes = 3_000_000, ...options }) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let current = safeUrl(url, domains);
    let response;
    try {
      const signal = AbortSignal.timeout(90_000);
      for (let redirect = 0; redirect <= 4; redirect++) {
        response = await fetch(current, {
          ...options, signal, redirect: 'manual',
          headers: { 'User-Agent': 'TV10IndiaNewsroom/1.0 (https://www.tv10india.com)', ...options.headers },
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel();
        assert(!options.method || options.method === 'GET', `${label}: refused write redirect`);
        assert(redirect < 4, `${label}: too many redirects`);
        current = safeUrl(new URL(response.headers.get('location'), current).href, domains);
      }
      const chunks = [];
      let size = 0;
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new Error('Response exceeds size limit');
      }
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        assert(size <= maxBytes, 'Response exceeds size limit');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (response.ok) return { bytes, type: response.headers.get('content-type') ?? '' };
      if (response.status === 429 && /perday|per_day|daily|limit[:"\s]+0/i.test(bytes.toString())) {
        throw new QuotaError(`${label}: daily quota exhausted or free-tier quota unavailable`);
      }
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        const retryAfter = Number(response.headers.get('retry-after')) || 0;
        await sleep(Math.min(120_000, Math.max(retryAfter * 1000, 15_000 * 2 ** attempt)));
        continue;
      }
      // Keep the status and the API's own reason. "HTTP 400" alone cannot tell a request
      // field the API rejected from a bad key, and the runner needs the status to decide.
      throw Object.assign(new Error(`${label}: HTTP ${response.status}${errorReason(bytes)}`), { status: response.status });
    } catch (error) {
      if (error instanceof QuotaError) throw error;
      if (error instanceof TypeError || error.name === 'TimeoutError') {
        if (attempt < retries) { await sleep(2000 * 2 ** attempt); continue; }
        throw new Error(`${label}: network failure or timeout`);
      }
      throw error;
    }
  }
}

// The explanation inside a JSON error body: Gemini's error.message, Sanity's
// error.description. A publisher's HTML error page yields nothing.
function errorReason(bytes) {
  try {
    const body = JSON.parse(bytes.toString('utf8'));
    const reason = [body?.error?.message, body?.error?.description, body?.error, body?.message].find((value) => typeof value === 'string' && value.trim());
    return reason ? ` (${Array.from(normalize(reason)).slice(0, 300).join('')})` : '';
  } catch { return ''; }
}

export async function requestJson(url, options) {
  const result = await request(url, options);
  try { return JSON.parse(result.bytes.toString('utf8')); }
  catch { throw new Error(`${options.label}: invalid JSON response`); }
}

export function parseFeed(xml, now) {
  assert(!/<!DOCTYPE|<!ENTITY/i.test(xml), 'Feed contains forbidden XML declarations');
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(xml);
  const entries = parsed.rss?.channel?.item ?? parsed.feed?.entry ?? [];
  return (Array.isArray(entries) ? entries : [entries]).flatMap((entry) => {
    try {
      const links = Array.isArray(entry.link) ? entry.link : [entry.link];
      const link = links.find((item) => typeof item === 'string' || !item?.['@_rel'] || item['@_rel'] === 'alternate');
      const url = canonicalSource(plainText(typeof link === 'string' ? link : link?.['@_href']));
      const published = new Date(entry.pubDate ?? entry.published ?? entry.updated);
      const age = now.getTime() - published.getTime();
      if (!Number.isFinite(age) || age < 0 || age > 48 * 60 * 60 * 1000) return [];
      const title = plainText(entry.title?.['#text'] ?? entry.title);
      if (!title) return [];
      return [{ id: hash(url), url, title, publishedAt: published.toISOString() }];
    } catch { return []; }
  });
}

export function extractArticle(html) {
  const page = load(html);
  page('script, style, nav, header, footer, aside, form, noscript, iframe').remove();
  const paragraphs = (scope) => normalize(scope.find('p').map((index, element) => page(element).text()).get().join(' '));
  const article = page('article').first();
  let text = paragraphs(article.length ? article : page('main').first());
  // Some publishers put the body outside <article>/<main>. Fall back to the whole
  // page only when the scoped container came up short, so this can never regress
  // a site that already parses cleanly.
  if (characterCount(text) < 1200) text = paragraphs(page('body'));
  assert(characterCount(text) >= 1200, 'Source has insufficient readable article text');
  return Array.from(text).slice(0, 7000).join('');
}

// A publisher with a section but no feed. Bhaskar covers Uttarakhand daily yet publishes
// RSS for thirteen other states and not that one, and no reachable publisher has an
// Uttarakhand feed either, so the section index is the only way to source the state.
// Index entries carry no date or headline; both are read from the article page itself.
export function parseIndex(html, pageUrl, pattern) {
  const page = load(html);
  const matches = new RegExp(pattern);
  const urls = page('a[href]').map((index, element) => page(element).attr('href')).get().flatMap((href) => {
    try {
      const url = new URL(href, pageUrl);
      // One story is linked several times per index page, sometimes as ?type=video. The
      // query picks a player, not a different story, so it must not become a second id.
      url.search = '';
      url.hash = '';
      // Match on the resolved path, so the pattern reads as a path and an absolute link
      // to another site cannot satisfy it — canonicalSource throws on a foreign host.
      return matches.test(url.pathname) ? [canonicalSource(url.href)] : [];
    } catch { return []; }
  });
  return [...new Set(urls)].map((url) => ({ id: hash(url), url, title: '', publishedAt: null }));
}

// Prefer the page's own metadata over index link text, which is often a teaser rather
// than the headline and never carries a date.
export function articleMeta(html) {
  const page = load(html);
  const meta = (...selectors) => selectors.map((selector) => page(selector).attr('content')).find(Boolean);
  const published = new Date(meta('meta[property="Last-Modified-Time"]', 'meta[property="article:published_time"]', 'meta[name="publish-date"]') ?? NaN);
  return {
    publishedAt: Number.isFinite(published.getTime()) ? published : null,
    title: plainText(meta('meta[property="og:title"]', 'meta[name="title"]') ?? page('title').first().text()),
  };
}

// Take one item from each feed in turn rather than the globally newest. Feed order within a
// rank is the order in feeds.json, so the preferred feed leads.
export function interleaveByRank(perFeed, limit) {
  const ordered = [];
  for (let rank = 0; ordered.length < limit; rank++) {
    const row = perFeed.map((items) => items[rank]).filter(Boolean);
    if (!row.length) break;
    ordered.push(...row.slice(0, limit - ordered.length));
  }
  return ordered;
}

export async function collectSources(feeds, now, warnings, excluded = new Set()) {
  const perFeed = [];
  const seen = new Set(excluded);
  for (const feed of feeds) {
    // A feed is an RSS URL, or { index, links } for a publisher that has the section but
    // no feed for it. A state the masthead covers daily is not worth leaving unsourced
    // over a missing XML file.
    const indexed = typeof feed !== 'string';
    const url = indexed ? feed.index : feed;
    try {
      const result = await request(url, { domains: SOURCE_DOMAINS, label: indexed ? 'Section index' : 'RSS feed', retries: 1 });
      const body = result.bytes.toString('utf8');
      const parsed = indexed
        ? parseIndex(body, url, feed.links)
        : parseFeed(body, now).sort((first, second) => second.publishedAt.localeCompare(first.publishedAt));
      const items = [];
      for (const source of parsed) {
        if (seen.has(source.id)) continue;
        seen.add(source.id);
        items.push(source);
      }
      perFeed.push(items);
    } catch (error) { warnings.push(`Feed ${new URL(url).hostname}: ${error.message}`); }
  }
  // Round-robin by rank, not one flat date sort. A high-volume feed fills every fetch slot
  // under a date sort and a lower-volume feed on the same subject is never read at all:
  // BBC Sport crowded out Bhaskar sports completely, leaving a Hindi category sourced
  // entirely from English wire copy, and Bhaskar lifestyle did the same to ABP earlier.
  const sources = [];
  const tally = new Map();
  for (const source of interleaveByRank(perFeed, 10)) {
    const host = new URL(source.url).hostname.replace(/^www\./, '');
    const count = tally.get(host) ?? { tried: 0, ok: 0, reason: '' };
    count.tried++;
    tally.set(host, count);
    try {
      const result = await request(source.url, { domains: SOURCE_DOMAINS, label: 'Source article', retries: 0 });
      const body = result.bytes.toString('utf8');
      let { title, publishedAt } = source;
      // parseFeed applies the 48-hour window to an RSS item before it is ever fetched. An
      // index entry has no date to apply it to, so it is enforced here instead.
      if (!publishedAt) {
        const meta = articleMeta(body);
        const age = now.getTime() - (meta.publishedAt?.getTime() ?? NaN);
        assert(Number.isFinite(age) && age >= 0 && age <= 48 * 60 * 60 * 1000, 'Source article is undated or outside the 48-hour window');
        assert(meta.title, 'Source article has no headline');
        ({ title } = meta);
        publishedAt = meta.publishedAt.toISOString();
      }
      sources.push({ ...source, title, publishedAt, text: extractArticle(body) });
      count.ok++;
      if (sources.length === 6) break;
    } catch (error) { count.reason = error.message; }
  }
  // One line per publisher, not one per article. Eight separate "insufficient readable
  // article text" warnings read as noise and hid a real defect for weeks; "amarujala.com:
  // 1 of 5 usable" reads as a publisher that has moved its body behind a meter.
  for (const [host, count] of tally) {
    if (count.ok < count.tried) warnings.push(`${host}: only ${count.ok} of ${count.tried} fetched article(s) usable (${count.reason})`);
  }
  return sources;
}

// Function words carry no topic. Without dropping them, any two Hindi headlines
// overlap on के/में/से alone and every article looks like a duplicate of every other.
const HINDI_STOPWORDS = new Set(['के', 'का', 'की', 'को', 'में', 'से', 'पर', 'और', 'है', 'हैं', 'था', 'थी', 'थे', 'एक', 'यह', 'वह', 'इस', 'उस', 'जो', 'ने', 'भी', 'कि', 'लिए', 'साथ', 'तक', 'या', 'नहीं', 'तो', 'ही', 'अब', 'बाद', 'कर', 'करने', 'हुआ', 'हुई', 'हुए', 'गया', 'गई', 'गए', 'रहा', 'रही', 'रहे', 'दिया', 'दी', 'दिए']);

// Devanagari matras are combining marks, so \p{M} must count as part of a word:
// without it "में" splits into a bare "म" and the stopword list never matches.
export const titleTerms = (title) => new Set(
  normalize(String(title ?? '')).split(/[^\p{L}\p{N}\p{M}]+/u).filter((word) => characterCount(word) >= 2 && !HINDI_STOPWORDS.has(word)),
);

// Containment of the shorter headline in the longer one, not Jaccard: a follow-up that
// adds detail keeps every original term and adds more, which Jaccard scores as half a
// match. Deliberately strict — a false positive silently costs a publishable article.
export function similarTitle(first, second, threshold = 0.7) {
  if (normalize(String(first ?? '')) === normalize(String(second ?? ''))) return true;
  const left = titleTerms(first);
  const right = titleTerms(second);
  if (left.size < 3 || right.size < 3) return false;
  const shared = [...left].filter((term) => right.has(term)).length;
  return shared / Math.min(left.size, right.size) >= threshold;
}

// Evidence is matched word for word: Unicode-normalized, case-folded, every punctuation
// mark read as a space. ABP Live ends Hindi sentences with "." where Hindi writes "।", so
// a quote that copied every word but ended a sentence the Hindi way failed an exact match;
// one TV10 run lost six articles to evidence errors, every traceable one on an ABP source.
// The words and their order must still match exactly, so paraphrase and translation fail.
export const quoteWords = (text) => normalize(String(text ?? '').normalize('NFC')
  .replace(/\p{Cf}/gu, '')
  .replace(/[०-९]/g, (digit) => String(digit.codePointAt(0) - 0x0966))
  .toLowerCase()
  .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' '));

export function quoteMatches(sourceText, quote) {
  if (typeof quote !== 'string') return false;
  const length = characterCount(normalize(quote));
  const words = quoteWords(quote);
  // The word floor matters: an all-punctuation quote folds to "", which every text includes.
  return length >= 30 && length <= 180 && characterCount(words) >= 20 && quoteWords(sourceText).includes(words);
}

// Why a quote failed, in terms the one correction can act on. Told only "not an exact
// quote", all six of that run's evidence rejections failed again on correction.
function quoteProblem(source, quote) {
  if (typeof quote !== 'string' || !quote.trim()) return 'no evidence item names it';
  const length = characterCount(normalize(quote));
  if (length < 30 || length > 180) return `the quote is ${length} characters long`;
  const words = quoteWords(quote);
  if (characterCount(words) < 20) return 'the quote is mostly punctuation';
  if (quoteWords(source.title).includes(words)) return 'it quotes the headline, which is not part of the supplied text';
  // The longest opening run of the quote's words found in the source, ending on a whole
  // word. Every shorter run of a found run is found too, so a binary search is enough.
  const text = `${quoteWords(source.text)} `;
  const parts = words.split(' ');
  let low = 0;
  let high = parts.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (text.includes(`${parts.slice(0, middle).join(' ')} `)) low = middle;
    else high = middle - 1;
  }
  if (!low) return `its first word "${parts[0]}" does not appear in that source's text; evidence is never translated, and each quote must come from the source it names`;
  const run = `${parts.slice(0, low).join(' ')} `;
  const next = text.slice(text.indexOf(run) + run.length).split(' ')[0];
  return `it follows the source for ${low} of its ${parts.length} words, then has "${parts[low]}" where ${next ? `the source has "${next}"` : 'the supplied text ends'}`;
}

export function validateArticles(payload, category, sources, alreadyUsed = new Set(), count = 2) {
  assert(CATEGORIES.includes(category), 'Invalid category');
  assert([1, 2].includes(count), 'Expected one or two articles per category');
  assert(Array.isArray(payload?.articles) && payload.articles.length >= 1 && payload.articles.length <= count, `${category}: need 1-${count} supported article(s); received ${Array.isArray(payload?.articles) ? payload.articles.length : 'no articles array'}`);
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const used = new Set(alreadyUsed);
  const slugs = new Set();
  const titles = new Set();
  return payload.articles.map((article) => {
    assert(article && typeof article === 'object', `${category}: invalid article`);
    assert(!('author' in article) && !('reporter' in article), `${category}: bylines are forbidden`);
    assert(typeof article.title === 'string' && article.title.length >= 10 && article.title.length <= 220, `${category}: invalid headline`);
    assert(![...titles].some((seen) => similarTitle(seen, article.title)), `${category}: duplicate or near-duplicate headline`);
    titles.add(article.title);
    assert(typeof article.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug) && article.slug.length <= 90 && !slugs.has(article.slug), `${category}: invalid or duplicate slug`);
    slugs.add(article.slug);
    assert(typeof article.district === 'string', `${category}: invalid district`);
    assert(Array.isArray(article.tags) && article.tags.length >= 3 && article.tags.length <= 6 && article.tags.every((tag) => typeof tag === 'string' && tag.trim()), `${category}: need 3-6 tags`);
    if (!Array.isArray(article.blocks) || article.blocks.length > 20) {
      throw new ArticleStructureError(`${category}: invalid blocks; expected an array of at most 20 block objects`);
    }
    for (const [index, block] of article.blocks.entries()) {
      const prefix = `${category}: invalid block at blocks[${index}]`;
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        throw new ArticleStructureError(`${prefix}; expected an object with type and text fields`);
      }
      if (!['paragraph', 'heading', 'bullet'].includes(block.type)) {
        throw new ArticleStructureError(`${prefix}; type is missing or unsupported; use exactly paragraph, heading, or bullet`);
      }
      if (typeof block.text !== 'string' || !block.text.trim()) {
        throw new ArticleStructureError(`${prefix}; text must be a non-empty string, not an array or nested object`);
      }
    }
    const paragraphs = article.blocks.filter((block) => block.type === 'paragraph').length;
    const headings = article.blocks.filter((block) => block.type === 'heading').length;
    if (!(paragraphs >= 4 && paragraphs <= 8 && headings >= 1 && headings <= 2 && article.blocks[0]?.type === 'paragraph')) {
      throw new ArticleStructureError(`${category}: incorrect article structure (paragraphs=${paragraphs}, headings=${headings}, firstBlock=${article.blocks[0]?.type ?? 'missing'}). Expected 4-8 paragraph blocks, 1-2 heading blocks, and a paragraph first.`);
    }
    const body = article.blocks.map((block) => block.text).join('\n');
    const bodyCharacters = characterCount(body);
    const errors = [];
    if (bodyCharacters < 1500 || bodyCharacters > 2900) {
      // Give the model arithmetic, not a target range. Two runs were lost to bodies of
      // 1283 and 1403 characters: "revise toward 2100-2500" never told a weak model how
      // far short it was, nor that its paragraphs were running at half the asked length.
      const prose = article.blocks.filter((block) => block.type === 'paragraph');
      const perParagraph = Math.round(characterCount(prose.map((block) => block.text).join('')) / Math.max(1, paragraphs));
      const remedy = bodyCharacters < 1500
        ? `It is ${1500 - bodyCharacters} characters below the floor and ${2100 - bodyCharacters} below target. Your ${paragraphs} paragraphs average ${perParagraph} characters each and must be 410-470 each. Expand EVERY paragraph using detail already present in the supplied sources; do not add paragraphs, repeat sentences, or invent facts.`
        : `It is ${bodyCharacters - 2900} characters over. Cut repetition and secondary detail from the longest paragraphs and keep all ${paragraphs} of them.`;
      errors.push(new ArticleLengthError(`${category}: invalid article length (body=${bodyCharacters} Unicode characters). The body, headings included, must be 1500-2900 characters. ${remedy} Preserve evidence quotes that already match their source; repair any evidence errors listed separately.`));
    }
    const visible = [article.title, article.district, ...article.tags, body].join(' ');
    if (/[a-z]/i.test(visible) || !/[\u0900-\u097f]/.test(visible)) {
      errors.push(new ArticleStructureError(`${category}: article must use Devanagari, not Latin text. Rewrite Latin words in title, district, tags and block text in Devanagari. Keep slug, sourceIds and valid evidence quotes unchanged.`));
    }
    assert(!/एजेंसी|हमारे संवाददाता|पीटीआई|एएनआई|अमर उजाला|दैनिक जागरण|दैनिक भास्कर|भास्कर|एबीपी|बीबीसी|एनडीटीवी/.test(visible), `${category}: outlet credit or byline in copy`);
    // Retryable and specific. "invalid source references" told us nothing when a model that
    // had been handed only off-topic sources returned an article citing none of them.
    if (!Array.isArray(article.sourceIds) || !article.sourceIds.length) {
      throw new ArticleStructureError(`${category}: sourceIds is missing or empty. Cite 1-3 IDs from the supplied source records, or return fewer articles and explain the shortage in skipped.`);
    }
    if (article.sourceIds.length > 3 || new Set(article.sourceIds).size !== article.sourceIds.length) {
      throw new ArticleStructureError(`${category}: sourceIds must be 1-3 distinct IDs, got ${article.sourceIds.length} (${new Set(article.sourceIds).size} distinct).`);
    }
    assert(Array.isArray(article.evidence), `${category}: missing evidence`);
    const proven = new Set();
    for (const sourceId of article.sourceIds) {
      if (!sourceMap.has(sourceId)) {
        throw new ArticleStructureError(`${category}: sourceId ${sourceId} is not one of the supplied source records. Use the IDs exactly as supplied; do not invent or abbreviate them.`);
      }
      assert(!used.has(sourceId), `${category}: source ${sourceId} was already used by another article`);
      // Any quote naming the source can prove it, not only the first; only quotes that
      // match are kept, so the stored evidence is all verified.
      const source = sourceMap.get(sourceId);
      const quotes = article.evidence.filter((item) => item?.sourceId === sourceId);
      for (const item of quotes) if (quoteMatches(source.text, item.quote)) proven.add(item);
      if (!quotes.some((item) => proven.has(item))) {
        errors.push(new ArticleEvidenceError(`${category}: evidence for source ${sourceId} is not an exact quote from that source: ${quoteProblem(source, quotes[0]?.quote)}. Copy 30-180 consecutive characters of that source's supplied text unchanged; do not translate, reword, or join separate sentences.`));
      }
      used.add(sourceId);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new ArticleValidationError(errors);
    return {
      title: article.title, slug: article.slug, district: article.district, tags: article.tags,
      blocks: article.blocks.map(({ type, text }) => ({ type, text })), category,
      sourceIds: article.sourceIds, evidence: article.evidence.filter((item) => proven.has(item)).map(({ sourceId, quote }) => ({ sourceId, quote })),
      sources: article.sourceIds.map((sourceId) => {
        const { text: omitted, ...metadata } = sourceMap.get(sourceId);
        void omitted;
        return metadata;
      }),
    };
  });
}

export function validateArticleCandidates(payload, category, sources, alreadyUsed = new Set(), count = 2, retained = []) {
  assert([1, 2].includes(count), 'Expected one or two articles per category');
  if (!Array.isArray(payload?.articles) || payload.articles.length > count) {
    throw new ArticleStructureError(`${category}: expected an articles array with at most ${count} items`);
  }
  let articles = [...retained];
  const failures = [];
  for (const [index, article] of payload.articles.entries()) {
    try {
      articles = validateArticles({ articles: [...articles, article] }, category, sources, alreadyUsed, 2);
    } catch (error) {
      failures.push({ index, article, error });
    }
  }
  return { articles, failures };
}

export function portableText(article) {
  return article.blocks.map((block, index) => ({
    _type: 'block', _key: `block-${index}`, style: block.type === 'heading' ? 'h3' : 'normal', markDefs: [],
    ...(block.type === 'bullet' ? { listItem: 'bullet', level: 1 } : {}),
    children: [{ _type: 'span', _key: `span-${index}`, marks: [], text: block.text }],
  }));
}

// slot is the article's 1-based position within its own category. It defaults to the
// even-spread assumption, but a caller writing a partial batch must pass a real
// per-category counter so a short category does not shift every later article's ID.
// There is no mainImage: photos picked from Wikimedia Commons by keyword were too often
// of the wrong subject, such as potato biscuits on a story about a cricket all-rounder.
// Every post is a draft awaiting approval. A drafts. ID cannot be read without a token,
// and the site shows only posts with the published status, so nothing reaches readers
// until an editor uses Approve & publish in the Studio.
export function makeDocument(article, index, day, now, plan = batchPlan(), slot = index % plan.perCategory + 1) {
  return {
    _id: `drafts.${plan.prefix}-${day}-${article.category}-${slot}`, _type: 'post',
    title: article.title, slug: { _type: 'slug', current: `${article.slug}-${article.sourceIds[0].slice(0, 8)}` },
    category: article.category, tags: article.tags, body: portableText(article),
    editorialStatus: 'in-review', priority: 0, isBreaking: false,
    author: { _type: 'reference', _ref: 'author-news-desk' },
    publishedAt: new Date(now.getTime() - (plan.count - 1 - index) * 1000).toISOString(),
    // Every object in a Sanity array needs a _key. Without one the Studio replaces the
    // whole list with a "Missing keys" alert instead of showing the sources.
    newsroom: {
      day, batchSize: plan.count, sourceIds: article.sourceIds,
      sources: article.sources.map((source, position) => ({ _key: `source-${position}`, ...source })),
      evidence: article.evidence.map((item, position) => ({ _key: `evidence-${position}`, ...item })),
    },
  };
}

export function verifyPosts(posts, day, plan = batchPlan()) {
  const expectedIds = new Set(postIds(day, plan).map((id) => `drafts.${id}`));
  assert(posts.length >= plan.minimum && posts.length <= plan.count && new Set(posts.map((post) => post._id)).size === posts.length, `Expected ${plan.minimum}-${plan.count} distinct batch post(s), got ${posts.length}`);
  const lengths = [];
  const counts = Object.fromEntries(plan.categories.map((category) => [category, posts.filter((post) => post.category === category).length]));
  for (const category of plan.categories) assert(counts[category] <= plan.perCategory, `Expected at most ${plan.perCategory} post(s) in ${category}`);
  for (const post of posts) {
    assert(post._id.startsWith('drafts.') && post.editorialStatus === 'in-review', 'Not a draft awaiting approval');
    assert(expectedIds.has(post._id), 'Unexpected batch post ID');
    assert(post.author?._type === 'reference' && post.author._ref === 'author-news-desk' && !('reporter' in post), 'Missing TV10 News Desk attribution');
    assert(post.priority === 0 && !('webPriority' in post) && post.isBreaking === false, 'Unexpected homepage priority');
    assert(typeof post.title === 'string' && post.title && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug?.current ?? ''), 'Missing headline or invalid slug');
    const timestamp = Date.parse(post.publishedAt);
    assert(Number.isFinite(timestamp) && timestamp <= Date.now() && dayInIndia(new Date(timestamp)) === day, 'Invalid batch post date');
    const body = (post.body ?? []).map((block) => (block.children ?? []).map((span) => span.text ?? '').join('')).join('\n');
    const length = characterCount(body);
    assert(length >= 1500 && length <= 2900, 'Invalid body length');
    lengths.push(length);
  }
  assert(new Set(posts.map((post) => post.slug.current)).size === posts.length, 'Duplicate slug');
  return { count: posts.length, requested: plan.count, shortfall: plan.count - posts.length, awaitingApproval: posts.length, bylines: posts.length, perCategory: counts, bodyLength: { min: Math.min(...lengths), max: Math.max(...lengths), average: Math.round(lengths.reduce((sum, length) => sum + length, 0) / lengths.length) } };
}

// Where an earlier run's batch stands now. Editors approve, edit and delete these posts,
// so a later run reports on them rather than verifying them: a strict check would treat
// an editor's decision as a fault. Publishing moves a post from its drafts. ID to the
// plain one, and editing a published post opens a new draft beside it; the published
// copy is the one that counts.
export function batchSummary(posts) {
  const published = posts.filter((post) => !post._id.startsWith('drafts.'));
  const publishedIds = new Set(published.map((post) => post._id));
  const drafts = posts.filter((post) => post._id.startsWith('drafts.') && !publishedIds.has(post._id.slice('drafts.'.length)));
  return { posts: [...published, ...drafts], published: published.length, drafts: drafts.length };
}
