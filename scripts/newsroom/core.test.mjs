import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ArticleEvidenceError, ArticleLengthError, ArticleStructureError, ArticleValidationError, CATEGORIES, batchPlan, characterCount, creditFreeLicense, eligibleImage,
  interleaveByRank, makeDocument, parseIndex, photoScore, portableText, postIds, similarTitle, validateArticleCandidates, validateArticles, verifyPosts,
} from './core.mjs';

// Offline only: no network, no credentials. Run with `npm test`.

const feeds = JSON.parse(await readFile(new URL('./feeds.json', import.meta.url), 'utf8'));

const image = (licenseUrl, extra = {}) => ({ mime: 'image/jpeg', width: 1280, extmetadata: { LicenseUrl: { value: licenseUrl }, ...extra } });

test('only credit-free licences are accepted', () => {
  assert.ok(creditFreeLicense('https://creativecommons.org/publicdomain/zero/1.0/'));
  assert.ok(creditFreeLicense('https://creativecommons.org/publicdomain/mark/1.0/'));
  // CC BY and CC BY-SA oblige us to publish a credit, and the website has nowhere to show one.
  assert.ok(!creditFreeLicense('https://creativecommons.org/licenses/by/4.0/'));
  assert.ok(!creditFreeLicense('https://creativecommons.org/licenses/by-sa/3.0/'));
  assert.ok(!creditFreeLicense('https://creativecommons.org/licenses/by-nc/4.0/'));
  assert.ok(!creditFreeLicense('https://example.com/publicdomain/zero/1.0/'));
  assert.ok(eligibleImage(image('https://creativecommons.org/publicdomain/zero/1.0/')));
  assert.ok(!eligibleImage(image('https://creativecommons.org/licenses/by-sa/4.0/')));
  assert.ok(!eligibleImage({ ...image('https://creativecommons.org/publicdomain/zero/1.0/'), width: 640 }));
});

test('editorial prompt advertises the same ceiling the validator enforces', async () => {
  const prompt = await readFile(new URL('./editorial-prompt.md', import.meta.url), 'utf8');
  assert.match(prompt, /1,500-2,900 Unicode characters/);
});

test('photoScore rejects artwork, artefacts and pre-1990 prints', () => {
  const subject = (title, extra = {}) => photoScore({ title: `File:${title}` }, { extmetadata: extra }, 'kneaded dough');
  assert.ok(subject('Kneading bread dough.jpg') > 0);
  assert.equal(subject('Female figurine kneading dough MET GR690.jpg'), 0);
  assert.equal(subject('Kneading dough, an engraving.jpg'), 0);
  assert.equal(subject('Kneading dough.jpg', { DateTimeOriginal: { value: '1909' } }), 0);
  // Stemming: the query says "kneaded", the file says "Kneading".
  assert.ok(subject('Kneading Chapati Dough 01.jpg') >= 3);
});

test('similarTitle catches reworded repeats without flagging unrelated news', () => {
  assert.ok(similarTitle(
    'गोवा में विशेष गहन पुनरीक्षण के तहत छूटे हुए मतदाताओं के नामों को जोड़ने की प्रक्रिया हुई आसान',
    'गोवा में छूटे हुए मतदाताओं के नामों को जोड़ने की प्रक्रिया आसान हुई',
  ));
  assert.ok(similarTitle('नासा के टेलीस्कोप ने नए ग्रह की खोज की', 'नासा के टेलीस्कोप ने नए ग्रह की खोज की'));
  assert.ok(!similarTitle('बिना फ्रिज के गूंथे हुए आटे को सुरक्षित रखने के पारंपरिक तरीके', 'भारतीय टीम ने सीरीज जीतकर रचा नया कीर्तिमान'));
  // Shared function words alone must never trip it.
  assert.ok(!similarTitle('उत्तर प्रदेश में नई सड़क परियोजना को मंजूरी मिली', 'उत्तराखंड में पर्यटन को बढ़ावा देने की नई योजना शुरू'));
});

const paragraph = 'क'.repeat(400);
let counter = 0;
const article = (category) => ({
  category, title: `${category} शीर्षक ${++counter}`, slug: `slug-${category}-${counter}`, district: '',
  tags: ['अ', 'ब', 'स'], sourceIds: [`${category}${String(counter).padStart(23, '0')}`], evidence: [], sources: [], image: null,
  blocks: [{ type: 'paragraph', text: paragraph }, { type: 'heading', text: 'उपशीर्षक' }, { type: 'paragraph', text: paragraph },
    { type: 'paragraph', text: paragraph }, { type: 'heading', text: 'दूसरा' }, { type: 'paragraph', text: paragraph }],
});

// Mirrors the per-category slot counter in run.mjs, which is the whole point of the test.
function buildBatch(perCategory = {}) {
  const plan = batchPlan(18);
  const slots = new Map();
  // Pinned to the batch day: verifyPosts requires publishedAt to fall on that IST day, so
  // a live clock passed only on 1 October and failed every day after.
  const now = new Date('2026-10-01T06:00:00Z');
  return CATEGORIES
    .flatMap((category) => Array.from({ length: perCategory[category] ?? 2 }, () => article(category)))
    .map((item, index) => {
      const slot = (slots.get(item.category) ?? 0) + 1;
      slots.set(item.category, slot);
      return makeDocument(item, index, '2026-10-01', now, 'asset-ref', plan, slot);
    });
}

test('a short category does not shift every later article onto the wrong id', () => {
  const plan = batchPlan(18);
  const documents = buildBatch({ delhi: 1, lifestyle: 1 });
  assert.equal(documents.length, 16);
  const ids = documents.map((document) => document._id);
  assert.deepEqual(ids.filter((id) => id.includes('-delhi-')), ['tv10-newsroom-2026-10-01-delhi-1']);
  assert.deepEqual(ids.filter((id) => id.includes('-sports-')), ['tv10-newsroom-2026-10-01-sports-1', 'tv10-newsroom-2026-10-01-sports-2']);
  assert.equal(new Set(ids).size, ids.length);
  const verification = verifyPosts(documents, '2026-10-01', plan);
  assert.equal(verification.count, 16);
  assert.equal(verification.shortfall, 2);
  assert.equal(verification.perCategory.delhi, 1);
});

test('a full batch still verifies, and a batch below the minimum is rejected', () => {
  const plan = batchPlan(18);
  assert.equal(plan.minimum, 1);
  assert.equal(verifyPosts(buildBatch(), '2026-10-01', plan).shortfall, 0);
  assert.equal(verifyPosts(buildBatch().slice(0, 1), '2026-10-01', plan).count, 1);
  assert.equal(verifyPosts(buildBatch().slice(0, 9), '2026-10-01', plan).count, 9);
  assert.throws(() => verifyPosts([], '2026-10-01', plan), /1-18 distinct batch post/);
});

test('daily batches cover nine categories and exclude mystery', () => {
  assert.deepEqual(CATEGORIES, ['up', 'uk', 'delhi', 'world', 'dharma', 'business', 'sports', 'national', 'lifestyle']);
  assert.equal(batchPlan().count, 18);
  assert.equal(batchPlan().minimum, 1);
  assert.equal(postIds('2026-10-02').length, 18);
  assert.ok(postIds('2026-10-02').every((id) => !id.includes('-mystery-')));
  assert.deepEqual(Object.keys(feeds).sort(), [...CATEGORIES].sort());
  assert.throws(() => batchPlan(20), /Article count must be 1 or 18/);
  assert.throws(() => batchPlan(1, 'mystery'), /Unknown newsroom category/);
});

test('manual and scheduled workflows use the 18-article configuration', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/newsroom.yml', import.meta.url), 'utf8');
  assert.match(workflow, /options:\s*\n\s*- '1'\s*\n\s*- '18'/);
  assert.match(workflow, /inputs\.article_count \|\| '18'/);
  assert.doesNotMatch(workflow, /- mystery\b|article count is 20|Choose 20/);
});

test('an 18-article run takes two from every category, whatever category was picked', () => {
  // The dispatch form always sends a category, because the input is required. Only a
  // one-article run may use it: the full batch is two stories from each of the nine.
  for (const picked of CATEGORIES) {
    const ids = postIds('2026-10-02', batchPlan(18, picked));
    assert.equal(ids.length, 18);
    for (const category of CATEGORIES) {
      assert.deepEqual(ids.filter((id) => id.startsWith(`tv10-newsroom-2026-10-02-${category}-`)), [`tv10-newsroom-2026-10-02-${category}-1`, `tv10-newsroom-2026-10-02-${category}-2`]);
    }
  }
  assert.deepEqual(postIds('2026-10-02', batchPlan(1, 'sports')), ['tv10-newsroom-test-2026-10-02-sports-1']);
});

test('published documents carry no caption, no image line and no outbound links', () => {
  const plan = batchPlan(18);
  const withImage = makeDocument({ ...article('up'), image: { kind: 'real-photo', license: 'CC0' } }, 0, '2026-10-01', new Date(), 'asset-1', plan, 1);
  assert.ok(!('caption' in withImage.mainImage));
  assert.equal(withImage.mainImage.alt, withImage.title);
  // The body is exactly the model's blocks. Nothing is appended, so an article with a
  // photo and one without publish the same text and the length the model was asked for
  // is the length that reaches the page.
  const source = article('up');
  const blocks = portableText({ ...source, image: { kind: 'real-photo' } });
  assert.equal(blocks.length, source.blocks.length);
  assert.deepEqual(blocks.map((block) => block.children[0].text), source.blocks.map((block) => block.text));
  assert.deepEqual(blocks, portableText({ ...source, image: null }));
  assert.ok(blocks.every((block) => block.markDefs.length === 0));
});

test('every source and evidence entry carries a unique _key', () => {
  // The Studio declares newsroom.sources and newsroom.evidence, and shows a "Missing keys"
  // alert in place of any array of objects whose items have no _key.
  const sources = ['a', 'b'].map((id) => ({ id, url: `https://www.bhaskar.com/${id}`, title: 'स', publishedAt: null }));
  const evidence = [{ sourceId: 'a', quote: 'पहला' }, { sourceId: 'b', quote: 'दूसरा' }];
  const { newsroom } = makeDocument({ ...article('up'), sources, evidence }, 0, '2026-10-01', new Date(), 'asset-1', batchPlan(18), 1);
  for (const list of [newsroom.sources, newsroom.evidence]) {
    assert.equal(list.length, 2);
    assert.ok(list.every((item) => typeof item._key === 'string' && item._key));
    assert.equal(new Set(list.map((item) => item._key)).size, list.length);
  }
  // The key is added, nothing is lost: the run reads these back for its audit trail.
  assert.deepEqual(newsroom.sources.map((item) => item.url), sources.map((source) => source.url));
  assert.deepEqual(newsroom.evidence.map((item) => item.quote), evidence.map((item) => item.quote));
});

test('every category has at least one configured source and none is shared', () => {
  const seen = new Map();
  for (const category of CATEGORIES) {
    assert.ok(Array.isArray(feeds[category]) && feeds[category].length, `${category} has no feed`);
    for (const feed of feeds[category]) {
      const url = typeof feed === 'string' ? feed : feed.index;
      assert.ok(typeof url === 'string' && url.startsWith('https://'), `${category} has a malformed source entry`);
      // An index entry without a link pattern would match every anchor on the page,
      // including the section nav, and feed the model navigation chrome as evidence.
      if (typeof feed !== 'string') assert.ok(feed.links, `${category} index entry has no links pattern`);
      // A feed shared by two categories guarantees overlapping pools, which is how
      // national stories ended up published under lifestyle.
      assert.ok(!seen.has(url), `${url} is shared by ${seen.get(url)} and ${category}`);
      seen.set(url, category);
    }
  }
});

test('a section index yields the source shape a feed does, deduplicated and host-checked', () => {
  // No publisher reachable from CI has an Uttarakhand feed, so uk is sourced from
  // Bhaskar's section index. The configured pattern must admit article URLs only: the
  // page also links the section itself, other states, and the same story twice.
  const index = feeds.uk.find((feed) => typeof feed !== 'string');
  const sources = parseIndex(`<html><body>
    <a href="/local/uttarakhand/dehradun/news/upl-final-2026-134567.html">UPL</a>
    <a href="/local/uttarakhand/dehradun/news/upl-final-2026-134567.html?type=video">वही खबर, वीडियो</a>
    <a href="/local/uttarakhand/">उत्तराखंड</a>
    <a href="/local/up/lucknow/news/kisan-134001.html">यूपी</a>
    <a href="https://www.bhaskar.com/local/uttarakhand/nainital/news/road-134777.html#top">नैनीताल</a>
    <a href="https://example.com/local/uttarakhand/x/news/y-1.html">कहीं और</a>
    <a>बिना लिंक</a></body></html>`, index.index, index.links);
  assert.deepEqual(sources.map((source) => source.url), [
    'https://www.bhaskar.com/local/uttarakhand/dehradun/news/upl-final-2026-134567.html',
    'https://www.bhaskar.com/local/uttarakhand/nainital/news/road-134777.html',
  ]);
  // The date and headline are unknown until the article is fetched; collectSources
  // reads them from the page and applies the 48-hour window there.
  assert.ok(sources.every((source) => source.publishedAt === null && source.title === ''));
  assert.equal(new Set(sources.map((source) => source.id)).size, 2);
});

test('a high-volume feed cannot starve a lower-volume feed on the same subject', () => {
  // BBC Sport publishes constantly; Bhaskar sports does not. A flat date sort gave BBC
  // every fetch slot, so a Hindi category was sourced entirely from English wire copy
  // and no Hindi evidence quote could ever be an exact substring of its source.
  const bbc = Array.from({ length: 40 }, (unused, index) => `bbc-${index}`);
  const bhaskar = ['bhaskar-0', 'bhaskar-1'];
  const ordered = interleaveByRank([bhaskar, bbc], 10);
  assert.equal(ordered.length, 10);
  // Feed order in feeds.json decides who leads within a rank: Bhaskar is listed first.
  assert.deepEqual(ordered.slice(0, 4), ['bhaskar-0', 'bbc-0', 'bhaskar-1', 'bbc-1']);
  assert.equal(ordered.filter((id) => id.startsWith('bhaskar')).length, 2);
  // An empty feed must not stall the round-robin or truncate the result.
  assert.deepEqual(interleaveByRank([[], bhaskar, []], 10), bhaskar);
  assert.deepEqual(interleaveByRank([], 10), []);
  assert.equal(interleaveByRank([bbc], 6).length, 6);
});

const SOURCE_ID = 'abcdef0123456789abcdef01';
const SOURCE_TEXT = 'लखनऊ के किसानों ने इस वर्ष गेहूं की नई किस्म अपनाई है जिससे पैदावार में उल्लेखनीय वृद्धि दर्ज की गई है।';
const QUOTE = 'गेहूं की नई किस्म अपनाई है जिससे पैदावार में उल्लेखनीय वृद्धि';

const payloadFor = (quote) => ({
  articles: [{
    title: 'गेहूं की नई किस्म से किसानों की पैदावार बढ़ी',
    slug: 'wheat-variety-yield', district: '', tags: ['गेहूं', 'किसान', 'पैदावार'],
    sourceIds: [SOURCE_ID], evidence: [{ sourceId: SOURCE_ID, quote }], imageQueries: ['wheat farming'],
    blocks: [{ type: 'paragraph', text: paragraph }, { type: 'heading', text: 'उपशीर्षक' },
      { type: 'paragraph', text: paragraph }, { type: 'paragraph', text: paragraph },
      { type: 'heading', text: 'दूसरा' }, { type: 'paragraph', text: paragraph }],
  }],
  skipped: [],
});
const SOURCE = [{ id: SOURCE_ID, url: 'https://www.amarujala.com/a', title: 'स', text: SOURCE_TEXT }];
const validatePayload = (payload) => validateArticles(payload, 'up', SOURCE, [], 1);
const validate = (quote) => validatePayload(payloadFor(quote));

test('one supported article is accepted when two were requested', () => {
  assert.equal(validateArticles(payloadFor(QUOTE), 'up', SOURCE, [], 2).length, 1);
  assert.throws(() => validateArticles({ articles: [] }, 'up', SOURCE), /need 1-2/);
  assert.throws(() => validateArticles({ articles: Array(3).fill(payloadFor(QUOTE).articles[0]) }, 'up', SOURCE), /need 1-2/);
});

test('length, Hindi and evidence errors are reported together', () => {
  const payload = payloadFor('This is not a verbatim quote from the source text.');
  payload.articles[0].title += ' NASA';
  payload.articles[0].blocks.forEach((block) => { block.text = 'छोटा पाठ'; });
  assert.throws(() => validatePayload(payload), (error) => {
    assert.ok(error instanceof ArticleValidationError);
    assert.ok(error.errors.some((item) => item instanceof ArticleLengthError));
    assert.ok(error.errors.some((item) => item instanceof ArticleStructureError));
    assert.ok(error.errors.some((item) => item instanceof ArticleEvidenceError));
    return true;
  });
});

test('a failed first article cannot discard a valid sibling or consume its source', () => {
  const invalid = payloadFor('This is not a verbatim quote from the source text.').articles[0];
  const valid = payloadFor(QUOTE).articles[0];
  const used = new Set();
  const result = validateArticleCandidates({ articles: [invalid, valid] }, 'up', SOURCE, used);
  assert.equal(result.articles.length, 1);
  assert.deepEqual(result.articles[0].evidence, valid.evidence);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].index, 0);
  assert.equal(used.size, 0);
});

test('corrections cannot reuse accepted titles, slugs or sources', () => {
  const valid = payloadFor(QUOTE).articles[0];
  const retained = validatePayload({ articles: [valid] });
  const otherSource = { ...SOURCE[0], id: 'other-source' };
  for (const conflict of ['title', 'slug', 'sourceIds']) {
    const candidate = { ...structuredClone(valid), title: 'खेल प्रतियोगिता में खिलाड़ियों ने शानदार जीत दर्ज की', slug: 'sports-victory', sourceIds: [otherSource.id], evidence: [{ sourceId: otherSource.id, quote: QUOTE }] };
    candidate[conflict] = valid[conflict];
    if (conflict === 'sourceIds') candidate.evidence = valid.evidence;
    const result = validateArticleCandidates({ articles: [candidate] }, 'up', [...SOURCE, otherSource], [], 1, retained);
    assert.equal(result.articles.length, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(result.articles[0].slug, valid.slug);
  }
});

test('malformed or overfull candidate envelopes are rejected', () => {
  for (const payload of [null, {}, { articles: 'bad' }, { articles: [1, 2, 3] }]) {
    assert.throws(() => validateArticleCandidates(payload, 'up', SOURCE), ArticleStructureError);
  }
  assert.deepEqual(validateArticleCandidates({ articles: [] }, 'up', SOURCE), { articles: [], failures: [] });
});

test('the 1500-2900 character boundaries remain strict', () => {
  for (const length of [1480, 1499, 1500, 2900, 2901, 3039]) {
    const payload = payloadFor(QUOTE);
    payload.articles[0].blocks = [
      { type: 'paragraph', text: 'क'.repeat(length - 8) },
      { type: 'heading', text: 'क' },
      ...Array.from({ length: 3 }, () => ({ type: 'paragraph', text: 'क' })),
    ];
    assert.equal(characterCount(payload.articles[0].blocks.map((block) => block.text).join('\n')), length);
    if (length < 1500 || length > 2900) assert.throws(() => validatePayload(payload), ArticleLengthError);
    else assert.equal(validatePayload(payload).length, 1);
  }
});

test('evidence must be a real quote, but re-wrapped whitespace is still a real quote', () => {
  assert.equal(validate(QUOTE)[0].sourceIds[0], SOURCE_ID);
  // The source text is whitespace-normalized on extraction, so a model that re-wraps
  // its excerpt is quoting correctly and must not lose the article over it.
  assert.ok(validate(`  ${QUOTE.replace(' ', '\n  ')}  `));
});

test('a paraphrased quote is rejected, and the rejection is retryable', () => {
  // Retryable matters as much as rejected: this failure arrived on the correction
  // attempt, where a plain Error killed the category outright.
  assert.throws(() => validate('गेहूं की एक नई किस्म से पैदावार में भारी वृद्धि हुई है'), ArticleEvidenceError);
  assert.throws(() => validate(QUOTE.slice(0, 12)), ArticleEvidenceError);
});

const withParagraphs = (text) => {
  const payload = payloadFor(QUOTE);
  payload.articles[0].blocks = payload.articles[0].blocks.map((block) => (block.type === 'paragraph' ? { ...block, text } : block));
  return payload;
};

test('a short body is told how short it is, not just that it is short', () => {
  // Three CI runs died at 1283, 1403 and 1403 characters. "Revise toward 2100-2500"
  // never told a weak model the size of its deficit or that its paragraphs were
  // running at half length, so the one correction attempt was spent on a guess.
  let caught;
  try { validatePayload(withParagraphs('क'.repeat(270))); } catch (error) { caught = error; }
  assert.ok(caught instanceof ArticleLengthError, `expected ArticleLengthError, got ${caught}`);
  const body = Number(caught.message.match(/body=(\d+)/)[1]);
  assert.ok(body < 1500);
  assert.ok(caught.message.includes(`${1500 - body} characters below the floor`));
  assert.match(caught.message, /Your 4 paragraphs average 270 characters each and must be 410-470 each/);
  // The ceiling quoted to the author must be the one editorial-prompt.md advertises.
  assert.match(caught.message, /must be 1500-2900 characters/);
});

test('an over-long body is told how much to cut', () => {
  let caught;
  try { validatePayload(withParagraphs('क'.repeat(800))); } catch (error) { caught = error; }
  assert.ok(caught instanceof ArticleLengthError, `expected ArticleLengthError, got ${caught}`);
  const body = Number(caught.message.match(/body=(\d+)/)[1]);
  assert.ok(caught.message.includes(`It is ${body - 2900} characters over`));
  assert.match(caught.message, /keep all 4 of them/);
});
