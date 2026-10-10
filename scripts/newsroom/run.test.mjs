import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, generateValidatedCategory, sanityClient } from './run.mjs';
import { QuotaError, batchPlan, dayInIndia, makeDocument, validateArticles, verifyPosts } from './core.mjs';

const quote = 'This source text contains an exact excerpt used only in offline tests.';
const sources = [1, 2].map((index) => ({ id: `source-${index}`, text: quote }));
const paragraph = 'यह केवल परीक्षण का पाठ है। '.repeat(17);
const draft = (index) => ({
  title: index === 1 ? 'विद्यालय में नई पुस्तकालय सुविधा शुरू' : 'खेल प्रतियोगिता में खिलाड़ियों की शानदार जीत',
  slug: `test-article-${index}`, district: '', tags: ['शिक्षा', 'विकास', 'खेल'],
  sourceIds: [`source-${index}`], evidence: [{ sourceId: `source-${index}`, quote }],
  blocks: [{ type: 'paragraph', text: paragraph }, { type: 'heading', text: 'नई सुविधा' },
    ...Array.from({ length: 4 }, () => ({ type: 'paragraph', text: paragraph }))],
});
const invalidDraft = () => {
  const article = draft(2);
  article.blocks.forEach((block) => { block.text = 'छोटा पाठ'; });
  article.title += ' NASA';
  article.evidence[0].quote = 'This quote is not present anywhere in the supplied source.';
  return article;
};
const payload = (...articles) => ({ articles, skipped: [] });

async function exercise(context, responses, count = 2) {
  const requests = [];
  const warnings = [];
  let waits = 0;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).hostname, 'generativelanguage.googleapis.com');
    const body = JSON.parse(options.body);
    const request = JSON.parse(body.contents[0].parts[0].text);
    const schema = body.generationConfig.responseSchema;
    assert.equal(schema.properties.articles.maxItems, request.requestedArticleCount);
    assert.deepEqual(schema.properties.articles.items.properties.blocks.items.properties.type.enum, ['paragraph', 'heading', 'bullet']);
    assert.equal(schema.properties.articles.items.properties.blocks.items.properties.text.type, 'STRING');
    // Posts are text only, so the model is never asked for photo search terms.
    assert.ok(!('imageQueries' in schema.properties.articles.items.properties) && !schema.properties.articles.items.required.includes('imageQueries'));
    requests.push(request);
    assert.ok(requests.length <= responses.length, 'Unexpected extra request');
    const response = responses[requests.length - 1];
    if (response instanceof Error) throw response;
    const text = typeof response === 'string' ? response : JSON.stringify(response);
    return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }), { headers: { 'content-type': 'application/json' } });
  });
  const articles = await generateValidatedCategory({
    config: { key: 'offline-test-key', model: 'offline-test-model' },
    prompt: 'Offline test', category: 'world', sources, count,
    beforeRequest: async () => { waits++; }, onWarning: async (warning) => { warnings.push(warning); },
  });
  assert.equal(waits, requests.length);
  return { articles, requests, warnings };
}

test('only failed drafts are corrected and all independent errors are included', async (context) => {
  const result = await exercise(context, [payload(draft(1), invalidDraft()), payload(draft(2))]);
  assert.equal(result.articles.length, 2);
  assert.equal(result.requests.length, 2);
  const correction = result.requests[1];
  assert.equal(correction.requestedArticleCount, 1);
  assert.equal(correction.correctionRequest.previousResponse.articles.length, 1);
  assert.equal(correction.correctionRequest.previousResponse.articles[0].slug, draft(2).slug);
  assert.match(correction.correctionRequest.validationError, /invalid article length/);
  assert.match(correction.correctionRequest.validationError, /Devanagari/);
  assert.match(correction.correctionRequest.validationError, /not an exact quote/);
  assert.ok(correction.alreadyUsed.includes(draft(1).title));
  assert.deepEqual(result.articles[0].blocks, draft(1).blocks);
  assert.deepEqual(result.articles[0].evidence, draft(1).evidence);
});

test('a failed correction retains the valid sibling without another content retry', async (context) => {
  const result = await exercise(context, [payload(draft(1), invalidDraft()), payload(invalidDraft())]);
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].slug, draft(1).slug);
  assert.equal(result.requests.length, 2);
  assert.ok(result.warnings.some((warning) => warning.includes('accepted 1 of 2')));
});

test('malformed correction responses retain validated articles and stop at three requests', async (context) => {
  const result = await exercise(context, [payload(draft(1), invalidDraft()), '{bad json', '{bad json']);
  assert.equal(result.articles.length, 1);
  assert.equal(result.requests.length, 3);
  assert.deepEqual(result.requests[1].correctionRequest, result.requests[2].correctionRequest);
});

test('malformed initial JSON does not consume the one correction', async (context) => {
  const result = await exercise(context, ['{bad json', payload(draft(1), invalidDraft()), payload(draft(2))]);
  assert.equal(result.articles.length, 2);
  assert.equal(result.requests.length, 3);
});

test('overfull correction JSON cannot erase a validated sibling', async (context) => {
  const result = await exercise(context, [payload(draft(1), invalidDraft()), payload(draft(1), draft(2))]);
  assert.equal(result.articles.length, 1);
  assert.equal(result.requests.length, 2);
});

test('a supported singleton does not trigger a quota-filling request', async (context) => {
  const result = await exercise(context, [payload(draft(1))]);
  assert.equal(result.articles.length, 1);
  assert.equal(result.requests.length, 1);
});

test('one-article runs use a one-article schema', async (context) => {
  const result = await exercise(context, [payload(draft(1))], 1);
  assert.equal(result.articles.length, 1);
});

test('empty responses never become publishable articles', async (context) => {
  const result = await exercise(context, [payload()]);
  assert.equal(result.articles.length, 0);
  assert.equal(result.requests.length, 1);
});

test('quota errors still abort instead of publishing a partially generated batch', async (context) => {
  await assert.rejects(() => exercise(context, [payload(draft(1), invalidDraft()), new QuotaError('offline quota failure')]), QuotaError);
});

test('configuration is isolated to TV10 and small batches are allowed', () => {
  const config = configuration({ NEWSROOM_ARTICLE_COUNT: '18' });
  assert.equal(config.project, 'uh81euwc');
  assert.equal(config.dataset, 'production');
  assert.equal(config.plan.minimum, 1);
  assert.ok(config.plan.categories.includes('national'));
  assert.ok(!config.plan.categories.includes('others'));
  assert.ok(!config.plan.categories.includes('mystery'));
  assert.throws(() => configuration({ SANITY_PROJECT_ID: 'otherproject' }), /targets only TV10/);
  assert.throws(() => configuration({ SANITY_DATASET: 'otherdataset' }), /targets only TV10/);
});

test('TV10 documents are drafts awaiting approval, with its priority and existing desk author', () => {
  const plan = batchPlan(18);
  const now = new Date();
  const day = dayInIndia(now);
  const article = validateArticles(payload(draft(1)), 'world', sources, new Set(), 1)[0];
  const document = makeDocument(article, 17, day, now, plan, 1);
  assert.equal(document._id, `drafts.tv10-newsroom-${day}-world-1`);
  assert.equal(document.editorialStatus, 'in-review');
  assert.equal(document.priority, 0);
  assert.equal(document.isBreaking, false);
  assert.deepEqual(document.author, { _type: 'reference', _ref: 'author-news-desk' });
  assert.ok(!('webPriority' in document));
  assert.ok(!('district' in document));
  assert.ok(!('mainImage' in document));
  assert.equal(verifyPosts([document], day, plan).awaitingApproval, 1);
  assert.throws(() => verifyPosts([], day, plan), /Expected 1-18/);
  // Publishing is the editor's Approve & publish, never the run's.
  assert.throws(() => verifyPosts([{ ...document, _id: `tv10-newsroom-${day}-world-1` }], day, plan), /draft awaiting approval/);
  assert.throws(() => verifyPosts([{ ...document, editorialStatus: 'published' }], day, plan), /draft awaiting approval/);
  assert.throws(() => verifyPosts([{ ...document, author: undefined }], day, plan), /News Desk/);
});

test('Sanity reads and mocked draft writes use only the TV10 endpoint', async (context) => {
  let writes = 0;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'uh81euwc.api.sanity.io');
    assert.equal(options.headers.Authorization, 'Bearer offline-test-token');
    if (options.method === 'POST') {
      writes++;
      assert.equal(parsed.pathname, '/v2024-01-01/data/mutate/production');
      assert.deepEqual(JSON.parse(options.body), { mutations: [{ createIfNotExists: { _id: 'drafts.offline-test-document' } }] });
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }
    assert.equal(parsed.pathname, '/v2024-01-01/data/query/production');
    return new Response('{"result":[]}', { headers: { 'content-type': 'application/json' } });
  });
  const client = sanityClient(configuration({ SANITY_API_TOKEN: 'offline-test-token' }));
  assert.deepEqual(await client.query('*[_type == "post"]'), []);
  await assert.rejects(() => client.createDrafts([{ _id: 'drafts.offline-test-document' }, { _id: 'offline-test-document' }]), /drafts only/);
  assert.equal(writes, 0);
  await client.createDrafts([{ _id: 'drafts.offline-test-document' }]);
  assert.equal(writes, 1);
});
