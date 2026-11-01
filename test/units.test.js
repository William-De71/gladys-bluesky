// The pure parts: rich text (graphemes, UTF-8 facets), links, configuration,
// session helpers, images, event data, the store. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  graphemeLength,
  truncate,
  splitMessage,
  detectFacets,
  readPostRef,
  postUrl,
  parseAtUri,
  shorten,
} from '../src/richtext.js';
import { normalizeConfig, configProblem, readActor, readService } from '../src/config.js';
import { jwtExpiry, pdsOf, allowedOrigin, createBlueskyApi } from '../src/bluesky-api.js';
import { readImage, fetchImage, MAX_IMAGE_BYTES } from '../src/images.js';
import { notificationEvent, messageEvent, notSentEvent, subjectOf } from '../src/events.js';
import { createStore } from '../src/store.js';
import { linkCodeOf, failureReason } from '../src/app.js';
import { fakeJwt, SELF, ALICE } from './helpers/fake-bluesky.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const slice = (text, facet) =>
  Buffer.from(text).subarray(facet.index.byteStart, facet.index.byteEnd).toString();

test('graphemes: what a reader counts, not UTF-16 units nor bytes', () => {
  assert.equal(graphemeLength('abc'), 3);
  assert.equal(graphemeLength('👨‍👩‍👧 ok'), 4);
  assert.equal(graphemeLength('é'), 1);
  assert.equal(graphemeLength('é'), 1, 'e + combining accent');
});

test('truncate: within the graphemes and the bytes, an ellipsis when cut', () => {
  assert.deepEqual(truncate('short', 300), { text: 'short', truncated: false });
  const cut = truncate('🏠'.repeat(10), 5);
  assert.equal(cut.text, '🏠🏠🏠🏠…');
  assert.equal(cut.truncated, true);
  const bytes = truncate('é'.repeat(100), 300, 51);
  assert.ok(Buffer.byteLength(bytes.text) <= 51);
});

test('splitMessage: parts of 1,000 graphemes at most, cut at a space', () => {
  const parts = splitMessage('word '.repeat(450));
  assert.equal(parts.length, 3);
  for (const part of parts) {
    assert.ok(graphemeLength(part) <= 1000);
    assert.ok(!part.startsWith(' ') && !part.endsWith(' '));
  }
  assert.deepEqual(splitMessage('   '), []);
});

test('facets: byte offsets in UTF-8, links without ending punctuation, tags, mentions resolved', async () => {
  const text =
    'Café ☕ (voir https://example.org/a?b=1). #maison, @alice.bsky.social et @unknown.example';
  const facets = await detectFacets(text, async (handle) =>
    handle === 'alice.bsky.social' ? ALICE.did : null,
  );
  assert.deepEqual(
    facets.map((facet) => [facet.features[0].$type.split('#')[1], slice(text, facet)]),
    [
      ['link', 'https://example.org/a?b=1'],
      ['tag', '#maison'],
      ['mention', '@alice.bsky.social'],
    ],
  );
  assert.equal(facets[1].features[0].tag, 'maison');
  assert.equal(facets[2].features[0].did, ALICE.did);
  // Sorted, never overlapping.
  for (let i = 1; i < facets.length; i += 1) {
    assert.ok(facets[i].index.byteStart >= facets[i - 1].index.byteEnd);
  }
});

test('facets: no tag for a number, nor for a tag longer than 64 graphemes', async () => {
  assert.deepEqual(await detectFacets('#1 is not a tag'), []);
  assert.deepEqual(await detectFacets(`#${'a'.repeat(65)}`), []);
  assert.equal((await detectFacets(`#${'a'.repeat(64)}`)).length, 1);
});

test('posts: AT URIs, bsky.app links, either way', () => {
  const uri = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l';
  assert.deepEqual(parseAtUri(uri), {
    repo: 'did:plc:z72i7hdynmk6r22z27h6tvur',
    collection: 'app.bsky.feed.post',
    rkey: '3l6oveex3ii2l',
  });
  assert.equal(postUrl(uri, 'bsky.app'), 'https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l');
  assert.equal(
    postUrl(uri, 'handle.invalid'),
    'https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6oveex3ii2l',
  );
  assert.equal(postUrl('at://did:plc:x/app.bsky.feed.like/1', 'a.b'), '');
  assert.deepEqual(readPostRef('https://bsky.app/profile/Bsky.App/post/3l6oveex3ii2l?x=1'), {
    repo: 'bsky.app',
    rkey: '3l6oveex3ii2l',
  });
  assert.deepEqual(readPostRef(uri), {
    repo: 'did:plc:z72i7hdynmk6r22z27h6tvur',
    rkey: '3l6oveex3ii2l',
  });
  assert.equal(readPostRef('at://did:plc:x/app.bsky.feed.like/1'), null);
  assert.equal(readPostRef('https://example.org/post/1'), null);
});

test('configuration: handle, e-mail, server, interval, flags', () => {
  const config = normalizeConfig({
    identifier: '@Home-Gladys.bsky.social',
    app_password: ' not-a-real-app-password ',
    check_interval: '30',
    receive_messages: 'false',
  });
  assert.equal(config.identifier, 'home-gladys.bsky.social');
  assert.equal(config.appPassword, 'not-a-real-app-password');
  assert.equal(config.service, 'https://bsky.social');
  assert.equal(config.checkIntervalMs, 30_000);
  assert.equal(config.receiveMessages, false);
  assert.equal(config.forwardMessages, true);
  assert.equal(config.language, 'auto');
  assert.equal(configProblem(config), null);
  assert.equal(normalizeConfig({ check_interval: '5' }).checkIntervalMs, 15_000);
  assert.equal(configProblem(normalizeConfig({})), 'missing');
  assert.equal(
    configProblem(normalizeConfig({ identifier: 'no spaces', app_password: 'x' })),
    'identifier',
  );
  assert.equal(normalizeConfig({ identifier: 'Me@Example.org' }).identifier, 'Me@Example.org');
  assert.equal(readService('pds.example.org'), 'https://pds.example.org');
  assert.equal(readService('http://pds.example.org'), null, 'never http on the internet');
  assert.equal(readService('http://127.0.0.1:2583'), 'http://127.0.0.1:2583');
  assert.equal(readService('https://user:pw@pds.example.org'), null);
  assert.equal(
    configProblem(
      normalizeConfig({ identifier: 'a.bsky.social', app_password: 'x', service: 'ftp://x' }),
    ),
    'service',
  );
});

test('actors: handles, DIDs and profile links', () => {
  assert.equal(readActor('@Alice.bsky.social'), 'alice.bsky.social');
  assert.equal(readActor('https://bsky.app/profile/alice.bsky.social'), 'alice.bsky.social');
  assert.equal(readActor(ALICE.did), ALICE.did);
  assert.equal(readActor('did:web:example.org'), 'did:web:example.org');
  assert.equal(readActor('alice'), null);
  assert.equal(readActor(''), null);
});

test('session helpers: JWT expiry, the PDS of the DID document, https only', () => {
  assert.equal(jwtExpiry(fakeJwt('access', 2_000_000_000, 1)), 2_000_000_000_000);
  assert.equal(jwtExpiry('garbage'), null);
  const doc = {
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://morel.us-east.host.bsky.network',
      },
    ],
  };
  assert.equal(pdsOf(doc, 'https://bsky.social'), 'https://morel.us-east.host.bsky.network');
  const insecure = { service: [{ id: '#atproto_pds', serviceEndpoint: 'http://evil.example' }] };
  assert.equal(pdsOf(insecure, 'https://bsky.social'), 'https://bsky.social');
  assert.equal(pdsOf(undefined, 'https://bsky.social'), 'https://bsky.social');
  assert.equal(allowedOrigin('http://127.0.0.1:1/x', 'https://bsky.social'), null);
  assert.equal(allowedOrigin('http://127.0.0.1:1/x', 'http://127.0.0.1:2'), 'http://127.0.0.1:1');
});

test('the client: an unreachable server is a clean network error, never the password in it', async () => {
  const api = createBlueskyApi({
    logger: quiet,
    fetchImpl: async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    },
  });
  api.configure({
    identifier: 'a.bsky.social',
    appPassword: 'not-a-real-app-password',
    service: 'https://bsky.social',
  });
  await assert.rejects(api.connect(), (err) => {
    assert.equal(err.reason, 'network');
    assert.doesNotMatch(`${err.message} ${err.detail}`, /not-a-real-app-password/);
    return true;
  });
});

test('the client: "Bad token method" is a missing direct message access', async () => {
  const responses = [
    new Response(
      JSON.stringify({
        accessJwt: fakeJwt('a', 2_000_000_000, 1),
        refreshJwt: 'r',
        did: SELF.did,
        handle: SELF.handle,
      }),
    ),
    new Response(JSON.stringify({ error: 'InvalidToken', message: 'Bad token method' }), {
      status: 400,
    }),
  ];
  const api = createBlueskyApi({ logger: quiet, fetchImpl: async () => responses.shift() });
  api.configure({ identifier: 'a.bsky.social', appPassword: 'x', service: 'https://bsky.social' });
  await assert.rejects(api.getLog(), { reason: 'dm_scope' });
});

test('images: JPEG, PNG, GIF and WebP with their size; anything else refused', async () => {
  const png = Buffer.alloc(33);
  png.write('\x89PNG\r\n\x1a\n', 0, 'latin1');
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(
    { ...readImage(png), bytes: null },
    { bytes: null, mime: 'image/png', width: 640, height: 480 },
  );
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02,
    0x80, 0x03, 0, 0, 0, 0, 0, 0,
  ]);
  const read = readImage(jpeg);
  assert.deepEqual([read.mime, read.width, read.height], ['image/jpeg', 640, 480]);
  const gif = Buffer.alloc(16);
  gif.write('GIF89a', 0, 'latin1');
  gif.writeUInt16LE(10, 6);
  gif.writeUInt16LE(20, 8);
  assert.deepEqual([readImage(gif).width, readImage(gif).height], [10, 20]);
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBPVP8X', 8, 'latin1');
  webp.writeUIntLE(99, 24, 3);
  webp.writeUIntLE(49, 27, 3);
  assert.deepEqual(
    [readImage(webp).mime, readImage(webp).width, readImage(webp).height],
    ['image/webp', 100, 50],
  );
  assert.throws(
    () => readImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    /JPEG, PNG/,
  );
  assert.throws(() => readImage(Buffer.alloc(MAX_IMAGE_BYTES + 1, 0xff)), /2000000 at most/);
  await assert.rejects(fetchImage('file:///etc/passwd'), /http:\/\/ or https:\/\//);
  await assert.rejects(
    fetchImage('https://x.example/a.png', {
      fetchImpl: async () => new Response('', { headers: { 'content-length': '3000000' } }),
    }),
    /at most/,
  );
});

test('event data: flat, scalar, strings of 1,000 characters at most', () => {
  const self = { did: SELF.did, handle: SELF.handle };
  const own = `at://${SELF.did}/app.bsky.feed.post/3lown`;
  const author = { did: ALICE.did, handle: ALICE.handle, displayName: 'Alice' };
  const reply = {
    uri: `at://${ALICE.did}/app.bsky.feed.post/3lreply`,
    reason: 'reply',
    reasonSubject: own,
    author,
    record: { text: 'x'.repeat(3000), reply: { parent: { uri: own } } },
  };
  const data = notificationEvent(reply, self);
  assert.equal(data.text.length, 1000);
  assert.equal(data.subject_url, 'https://bsky.app/profile/home-gladys.bsky.social/post/3lown');
  assert.equal(data.post_url, 'https://bsky.app/profile/alice.bsky.social/post/3lreply');
  // Without reasonSubject, the subject comes from the record.
  assert.equal(subjectOf({ record: { subject: { uri: own } } }), own);
  assert.equal(subjectOf({ record: { embed: { record: { record: { uri: own } } } } }), own);
  const all = [
    data,
    notificationEvent({ ...reply, reason: 'follow' }, self),
    messageEvent({
      text: 'hi',
      did: ALICE.did,
      handle: ALICE.handle,
      name: '',
      convoId: 'c',
      id: 'm',
    }),
    messageEvent({
      text: 'hi',
      did: ALICE.did,
      handle: '',
      name: '',
      convoId: 'c',
      id: 'm',
      user: null,
    }),
    notSentEvent({ target: ALICE.did, reason: 'weird', error: 'x' }),
  ];
  for (const event of all) {
    assert.ok(Object.keys(event).length <= 30);
    for (const value of Object.values(event)) {
      assert.ok(['string', 'number', 'boolean'].includes(typeof value) || value === null);
      if (typeof value === 'string') assert.ok(value.length <= 1000);
    }
  }
  assert.equal(all[4].reason, 'other');
  assert.equal(all[2].sender_name, ALICE.handle);
});

test('link codes and failure reasons', () => {
  assert.equal(linkCodeOf(' abcd2345 '), 'ABCD2345');
  assert.equal(linkCodeOf('ABCD1234'), null, 'no 1 in the alphabet of Gladys');
  assert.equal(linkCodeOf('turn on the light'), null);
  assert.equal(failureReason({ reason: 'expired' }), 'auth');
  assert.equal(failureReason({ reason: 'server' }), 'network');
  assert.equal(failureReason({ reason: 'dm_scope' }), 'dm_scope');
  assert.equal(failureReason(new Error('x')), 'other');
  assert.equal(shorten('abc', 10), 'abc');
  assert.equal(shorten('abcdef', 4), 'abc…');
  assert.equal(shorten('ab😀cd', 4), 'ab…', 'a surrogate pair is never cut');
});

test('store: counters of the day, seen notifications, cursor, another account, broken file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-bluesky-store-'));
  let now = Date.parse('2026-11-01T10:00:00Z');
  try {
    const store = createStore({ dir, now: () => now, logger: quiet });
    await store.load();
    store.useAccount(SELF.did);
    store.count('received');
    store.count('posts');
    assert.equal(store.remember('a|like'), true);
    assert.equal(store.remember('a|like'), false);
    store.setReference();
    store.setChatCursor('2222000001001');
    await store.save();
    const again = createStore({ dir, now: () => now, logger: quiet });
    await again.load();
    assert.deepEqual(again.counters(), { received: 1, sent: 0, posts: 1, failed: 0 });
    assert.equal(again.remember('a|like'), false);
    assert.equal(again.hasReference(), true);
    assert.equal(again.chatCursor(), '2222000001001');
    now += 86400_000;
    assert.deepEqual(again.counters(), { received: 0, sent: 0, posts: 0, failed: 0 });
    again.useAccount(ALICE.did);
    assert.equal(again.hasReference(), false);
    assert.equal(again.chatCursor(), null);
    const file = await readFile(join(dir, 'state.json'), 'utf8');
    assert.doesNotMatch(file, /text|password|Jwt/);
    await writeFile(join(dir, 'state.json'), '{broken');
    const broken = createStore({ dir, now: () => now, logger: quiet });
    await broken.load();
    assert.equal(broken.hasReference(), false);
    assert.equal(await broken.session.load(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
