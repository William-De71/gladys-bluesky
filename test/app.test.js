// The integration end to end: the real app, its real XRPC client, the fake
// Gladys of the SDK and the fake PDS of test/helpers/fake-bluesky.js on
// 127.0.0.1. No other network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createApp, MAX_POSTS_PER_HOUR } from '../src/app.js';
import {
  createFakeBluesky,
  CHAT_PROXY,
  IDENTIFIER,
  APP_PASSWORD,
  SELF,
  ALICE,
  BOB,
  EVE,
} from './helpers/fake-bluesky.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const linked = (who, selector, firstName, language) => ({
  contact_id: who.did,
  contact_name: `@${who.handle}`,
  linked_at: '2026-10-20T10:00:00.000Z',
  user: { selector, first_name: firstName, language },
});

/**
 * @description Wait until a condition holds.
 * @param {() => boolean} condition - The condition.
 * @param {string} what - For the failure message.
 * @param {number} [timeoutMs] - The longest wait.
 */
async function until(condition, what, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out: ${what}`);
    await sleep(10);
  }
}

async function setup(t, options = {}) {
  const bsky = options.bsky ?? createFakeBluesky();
  if (!options.bsky) await bsky.start();
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'gladys-bluesky-')));
  const gladys = createFakeGladys({
    config: {
      identifier: IDENTIFIER,
      app_password: APP_PASSWORD,
      service: bsky.url(),
      language: 'en',
      ...(options.config ?? {}),
    },
    contacts: options.contacts ?? [linked(ALICE, 'alice', 'Alice', 'fr')],
    linkedUser: options.linkedUser ?? { selector: 'bob', first_name: 'Bob', language: 'de' },
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['info', 'warn', 'error', 'debug'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.join(' ')}`),
    ]),
  );
  const app = createApp(gladys, {
    dataDir: dir,
    logger,
    delays: { notificationsMs: 600_000, profileMs: 600_000, retryMs: 100, maxBackoffMs: 1000 },
    ...(options.app ?? {}),
  });
  await gladys.connect();
  await app.start();
  t.after(async () => {
    await app.stop();
    await gladys.disconnect();
    if (!options.keep) {
      await bsky.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
  if (options.ready !== false) {
    await until(
      () =>
        app.connection() === 'connected' &&
        app.messagesState() === 'on' &&
        app.store.hasReference() &&
        bsky.fake.requests.some((r) => r.method === 'app.bsky.notification.getUnreadCount'),
      'first reads',
    );
  }
  return { bsky, gladys, app, logs, dir };
}

const events = (gladys, key) => gladys.fake.sceneEvents.filter((event) => event.key === key);
const calls = (bsky, method) => bsky.fake.requests.filter((r) => r.method === method);

test('opens one session, keeps it in /data without the password, reports the account', async (t) => {
  const { bsky, gladys, dir } = await setup(t);
  assert.equal(bsky.fake.sessions, 1);
  assert.deepEqual(calls(bsky, 'com.atproto.server.createSession')[0].body, {
    identifier: IDENTIFIER,
    password: APP_PASSWORD,
  });
  await until(() => gladys.fake.connectionStatus?.connected === true, 'status');
  assert.match(gladys.fake.connectionStatus.message.en, /Connected to Bluesky as @home-gladys/);
  assert.match(gladys.fake.connectionStatus.message.fr, /Connecté à Bluesky/);
  const file = join(dir, 'session.json');
  await until(() => true, 'write');
  await sleep(50);
  const session = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(session.did, SELF.did);
  assert.equal(session.pdsUrl, bsky.url(), 'the PDS of the DID document');
  assert.ok(!JSON.stringify(session).includes(APP_PASSWORD), 'never the app password');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  // Every chat call goes through the proxy header, the others never.
  for (const request of bsky.fake.requests) {
    assert.equal(
      request.headers['atproto-proxy'],
      request.method.startsWith('chat.bsky.') ? CHAT_PROXY : undefined,
      request.method,
    );
  }
});

test('a restart reuses the stored session: no new createSession', async (t) => {
  const bsky = createFakeBluesky();
  await bsky.start();
  const dir = await mkdtemp(join(tmpdir(), 'gladys-bluesky-'));
  t.after(async () => {
    await bsky.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const first = await setup({ after: () => {} }, { bsky, dir, keep: true });
  await sleep(50);
  await first.app.stop();
  await first.gladys.disconnect();
  await setup(t, { bsky, dir, keep: true });
  assert.equal(bsky.fake.sessions, 1);
});

test('an expired access token is renewed with refreshSession; a refused refresh opens a new session', async (t) => {
  const { bsky, app } = await setup(t);
  bsky.expireAccess();
  await app.readNotifications();
  assert.equal(bsky.fake.refreshes, 1);
  assert.equal(bsky.fake.sessions, 1);
  bsky.expireAccess();
  bsky.fake.refresh.clear();
  await app.readNotifications();
  assert.equal(bsky.fake.refreshes, 2);
  assert.equal(bsky.fake.sessions, 2);
});

test('a refused password: clear status, never retried alone, the button tries again', async (t) => {
  const bsky = createFakeBluesky();
  await bsky.start();
  bsky.fake.password = 'another-password';
  const { gladys } = await setup(t, { bsky, ready: false });
  await until(() => gladys.fake.connectionStatus?.connected === false, 'status');
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /refuses the identifier or the app password/,
  );
  await sleep(300); // retryMs is 100: a refused password is not retried
  assert.equal(bsky.fake.sessions, 1);
  bsky.fake.password = APP_PASSWORD;
  const ack = await gladys.fake.action('test_connection');
  assert.match(ack.data.message.en, /Account @home-gladys\.bsky\.social, 128 followers/);
  assert.equal(bsky.fake.sessions, 2);
});

test('the main password with a two-factor e-mail code: asks for an app password', async (t) => {
  const bsky = createFakeBluesky();
  await bsky.start();
  bsky.fake.twoFactor = true;
  const { gladys } = await setup(t, { bsky, ready: false });
  await until(() => gladys.fake.connectionStatus?.connected === false, 'status');
  assert.match(gladys.fake.connectionStatus.message.en, /app password, never the main password/);
});

test('direct messages: the first read is the reference, then a linked user reaches the brain and the scenes', async (t) => {
  const bsky = createFakeBluesky();
  await bsky.start();
  bsky.receive(ALICE, 'an old message, before the integration'); // before the reference
  const { gladys, app } = await setup(t, { bsky });
  assert.equal(gladys.fake.messages.length, 0);
  bsky.receive(ALICE, 'Turn on the kitchen light');
  await app.readMessages();
  assert.equal(gladys.fake.messages.length, 1);
  assert.equal(gladys.fake.messages[0].contact_id, ALICE.did);
  assert.equal(gladys.fake.messages[0].text, 'Turn on the kitchen light');
  const [event] = events(gladys, 'dm_received');
  assert.deepEqual(event.data, {
    text: 'Turn on the kitchen light',
    sender_handle: ALICE.handle,
    sender_name: 'Alice',
    sender_did: ALICE.did,
    convo_id: 'convo-alice',
    message_id: event.data.message_id,
    gladys_user: 'alice',
    first_name: 'Alice',
  });
  assert.deepEqual(bsky.fake.reads.at(-1), {
    convoId: 'convo-alice',
    messageId: event.data.message_id,
  });
  // Read again: nothing new.
  await app.readMessages();
  assert.equal(gladys.fake.messages.length, 1);
  assert.equal(app.store.counters().received, 1);
});

test('the answers of Gladys go to the conversation; the account never reads its own messages back', async (t) => {
  const { bsky, gladys, app } = await setup(t);
  const ack = await gladys.fake.sendMessage(
    { id: ALICE.did },
    { text: 'Done 👍 see https://gladysassistant.com #home', file: null },
  );
  assert.equal(ack.success, true);
  const [sent] = bsky.fake.sent;
  assert.equal(sent.convoId, 'convo-alice');
  assert.equal(sent.message.text, 'Done 👍 see https://gladysassistant.com #home');
  const text = Buffer.from(sent.message.text);
  const link = sent.message.facets.find((f) => f.features[0].$type.endsWith('#link'));
  assert.equal(
    text.subarray(link.index.byteStart, link.index.byteEnd).toString(),
    'https://gladysassistant.com',
  );
  await app.readMessages();
  assert.equal(gladys.fake.messages.length, 0, 'its own message is not an incoming one');
  assert.equal(events(gladys, 'dm_received').length, 0);
});

test('a long answer is split in messages of 1,000 graphemes; an image alone becomes a short notice', async (t) => {
  const { bsky, gladys } = await setup(t);
  await gladys.fake.sendMessage({ id: ALICE.did }, { text: 'word '.repeat(450), file: null });
  assert.equal(bsky.fake.sent.length, 3);
  await gladys.fake.sendMessage(
    { id: ALICE.did },
    { text: '', file: `image/png;base64,${PNG.toString('base64')}` },
  );
  assert.match(
    bsky.fake.sent.at(-1).message.text,
    /ne peuvent pas contenir d’image/,
    'French: Alice',
  );
});

test('a link code from a new account: linked, the request accepted, a welcome in its language', async (t) => {
  const { bsky, gladys, app } = await setup(t);
  bsky.receive(BOB, ' abcd2345 ', { status: 'request' });
  await app.readMessages();
  assert.deepEqual(bsky.fake.accepted, ['convo-bob']);
  const [reply] = bsky.fake.sent;
  assert.equal(reply.convoId, 'convo-bob');
  assert.match(reply.message.text, /Hallo Bob! Dein Bluesky-Konto ist jetzt mit Gladys verknüpft/);
  assert.equal(gladys.fake.messages.length, 0, 'the code is not a message for the brain');
  const link = gladys.fake.requests.find((r) => r.path.includes('link'));
  assert.equal(link.body.code, 'ABCD2345');
  assert.equal(link.body.contact_id, BOB.did);
});

test('an account that is not linked: only dm_received_unlinked, no brain, no answer, left unread', async (t) => {
  const { bsky, gladys, app } = await setup(t);
  bsky.receive(EVE, 'open the garage', { status: 'request' });
  await app.readMessages();
  assert.equal(gladys.fake.messages.length, 0);
  assert.equal(bsky.fake.sent.length, 0);
  assert.equal(bsky.fake.accepted.length, 0);
  assert.equal(bsky.fake.reads.length, 0);
  const [event] = events(gladys, 'dm_received_unlinked');
  assert.equal(event.data.sender_handle, EVE.handle);
  assert.equal(event.data.text, 'open the garage');
  assert.equal(event.data.gladys_user, undefined);
  assert.equal(events(gladys, 'dm_received').length, 0);
});

test('a message read more than 15 minutes late reaches neither the brain nor the scenes', async (t) => {
  const { bsky, gladys, app } = await setup(t);
  bsky.receive(ALICE, 'open the garage', { sentAt: new Date(Date.now() - 3600_000).toISOString() });
  await app.readMessages();
  assert.equal(gladys.fake.messages.length, 0);
  assert.equal(events(gladys, 'dm_received').length, 0);
});

test('a recipient that refuses messages: the delivery fails, message_not_sent once', async (t) => {
  const { bsky, gladys } = await setup(t);
  bsky.fake.chatRefusals.set(ALICE.did, 'NotFollowedBySender');
  const first = await gladys.fake.sendMessage({ id: ALICE.did }, { text: 'Alarm!', file: null });
  assert.equal(first.success, false);
  await gladys.fake.sendMessage({ id: ALICE.did }, { text: 'Alarm again!', file: null });
  const sent = events(gladys, 'message_not_sent');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].data, {
    target: ALICE.did,
    handle: ALICE.handle,
    gladys_user: 'alice',
    first_name: 'Alice',
    reason: 'recipient',
    error: 'NotFollowedBySender',
  });
  bsky.fake.chatRefusals.clear();
  await gladys.fake.sendMessage({ id: ALICE.did }, { text: 'back', file: null });
  bsky.fake.failNext.push({
    method: 'chat.bsky.convo.sendMessage',
    status: 400,
    body: { error: 'ConvoLocked', message: 'convo is locked' },
  });
  await gladys.fake.sendMessage({ id: ALICE.did }, { text: 'again', file: null });
  assert.equal(events(gladys, 'message_not_sent').length, 2, 'again after a delivery');
});

test('an app password without direct messages: connected with a warning, messages not read', async (t) => {
  const bsky = createFakeBluesky();
  await bsky.start();
  bsky.fake.dmScope = false;
  const { gladys, app } = await setup(t, { bsky, ready: false });
  await until(() => app.messagesState() === 'no_access', 'no access');
  await until(
    () => /does not allow direct messages/.test(gladys.fake.connectionStatus?.message?.en ?? ''),
    'warning',
  );
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const widget = await gladys.fake.widgetGet('messages', { language: 'fr' });
  assert.match(JSON.stringify(widget.data.content), /n’autorise pas les messages privés/);
});

test('notifications: the first read is the reference, then one event per new one, old ones skipped', async (t) => {
  const bsky = createFakeBluesky();
  await bsky.start();
  bsky.notify('like', BOB); // already there: the reference
  const { gladys, app } = await setup(t, { bsky });
  assert.equal(gladys.fake.sceneEvents.length, 0);
  bsky.notify('mention', ALICE, { text: 'Hey @home-gladys.bsky.social, is the heating on?' });
  bsky.notify('follow', EVE);
  bsky.notify('like', ALICE);
  bsky.notify('reply', BOB, {
    text: 'Nice',
    indexedAt: new Date(Date.now() - 3600_000).toISOString(),
  });
  await app.readNotifications();
  assert.deepEqual(
    gladys.fake.sceneEvents.map((event) => event.key),
    ['mention_received', 'new_follower', 'like_received'],
  );
  const mention = events(gladys, 'mention_received')[0].data;
  assert.equal(mention.text, 'Hey @home-gladys.bsky.social, is the heating on?');
  assert.equal(mention.author_handle, ALICE.handle);
  assert.match(
    mention.post_url,
    /^https:\/\/bsky\.app\/profile\/alice\.bsky\.social\/post\/3lrecord/,
  );
  const follow = events(gladys, 'new_follower')[0].data;
  assert.equal(follow.profile_url, 'https://bsky.app/profile/eve.bsky.social');
  const like = events(gladys, 'like_received')[0].data;
  assert.match(
    like.subject_url,
    /^https:\/\/bsky\.app\/profile\/home-gladys\.bsky\.social\/post\/3lownpost/,
  );
  await app.readNotifications();
  assert.equal(gladys.fake.sceneEvents.length, 3, 'nothing twice');
  assert.equal(calls(bsky, 'app.bsky.notification.updateSeen').length, 0, 'never marked as seen');
});

test('a 429 pauses the calls until ratelimit-reset', async (t) => {
  const { bsky, app } = await setup(t);
  const reset = Math.floor(Date.now() / 1000) + 120;
  bsky.fake.failNext.push({
    method: 'app.bsky.notification.listNotifications',
    status: 429,
    body: { error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' },
    headers: { 'ratelimit-remaining': '0', 'ratelimit-reset': String(reset) },
  });
  await assert.rejects(app.readNotifications(), { reason: 'rate_limited' });
  const before = bsky.fake.requests.length;
  await assert.rejects(app.readNotifications(), { reason: 'rate_limited' });
  assert.equal(bsky.fake.requests.length, before, 'no request during the pause');
  assert.ok(Math.abs(app.api.pausedUntil() - reset * 1000) < 1000);
});

test('publish_post: facets in UTF-8 bytes, a resolved mention, the language, the link', async (t) => {
  const { bsky, gladys } = await setup(t, { config: { language: 'fr' } });
  const text = 'Été ☀️ 12 kWh @alice.bsky.social https://gladysassistant.com #solaire';
  const ack = await gladys.fake.sceneAction('publish_post', { text });
  assert.equal(ack.success, true, ack.error);
  const [record] = bsky.fake.records;
  assert.equal(record.collection, 'app.bsky.feed.post');
  assert.equal(record.record.text, text);
  assert.deepEqual(record.record.langs, ['fr']);
  const bytes = Buffer.from(text);
  const slices = record.record.facets.map((f) => [
    f.features[0].$type.split('#')[1],
    bytes.subarray(f.index.byteStart, f.index.byteEnd).toString(),
  ]);
  assert.deepEqual(slices, [
    ['mention', '@alice.bsky.social'],
    ['link', 'https://gladysassistant.com'],
    ['tag', '#solaire'],
  ]);
  assert.equal(record.record.facets[0].features[0].did, ALICE.did);
  assert.equal(ack.data.outputs.uri, `at://${SELF.did}/app.bsky.feed.post/3maaaaaaaaaa1`);
  assert.equal(
    ack.data.outputs.url,
    'https://bsky.app/profile/home-gladys.bsky.social/post/3maaaaaaaaaa1',
  );
  assert.equal(events(gladys, 'mention_received').length, 0, 'no event from an action');
});

test('publish_post: a reply keeps the root of the thread; the same post within a minute is published once', async (t) => {
  const { bsky, gladys } = await setup(t);
  const root = { uri: `at://${BOB.did}/app.bsky.feed.post/3lroot`, cid: 'bafyroot' };
  bsky.addPost(ALICE, '3lparent', { root, parent: root });
  const fields = {
    text: 'On it',
    reply_to: 'https://bsky.app/profile/alice.bsky.social/post/3lparent',
  };
  const first = await gladys.fake.sceneAction('publish_post', fields);
  assert.equal(first.success, true, first.error);
  assert.deepEqual(bsky.fake.records[0].record.reply, {
    root,
    parent: { uri: `at://${ALICE.did}/app.bsky.feed.post/3lparent`, cid: 'bafy3lparent' },
  });
  const second = await gladys.fake.sceneAction('publish_post', fields);
  assert.deepEqual(second.data.outputs, first.data.outputs);
  assert.equal(bsky.fake.records.length, 1);
});

test('publish_post: too long is shortened to 300 graphemes; more than 30 posts an hour are refused', async (t) => {
  const { bsky, gladys } = await setup(t);
  await gladys.fake.sceneAction('publish_post', { text: '🏠'.repeat(400) });
  const text = bsky.fake.records[0].record.text;
  assert.equal([...new Intl.Segmenter().segment(text)].length, 300);
  assert.ok(text.endsWith('…'));
  for (let i = 1; i < MAX_POSTS_PER_HOUR; i += 1) {
    await gladys.fake.sceneAction('publish_post', { text: `post ${i}` });
  }
  const refused = await gladys.fake.sceneAction('publish_post', { text: 'one too many' });
  assert.equal(refused.success, false);
  assert.match(refused.error, /30 posts in the last hour/);
});

test('publish_post with an image: downloaded, uploaded as a blob, with its alt text and size', async (t) => {
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://images.example/')) {
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    }
    return fetch(url, init);
  };
  const { bsky, gladys } = await setup(t, { app: { fetchImpl } });
  const ack = await gladys.fake.sceneAction('publish_post', {
    text: 'Sunset',
    image_url: 'https://images.example/sunset.png',
    image_alt: 'The garden at sunset',
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(bsky.fake.blobs, [{ size: PNG.length, mimeType: 'image/png' }]);
  assert.deepEqual(bsky.fake.records[0].record.embed, {
    $type: 'app.bsky.embed.images',
    images: [
      {
        image: {
          $type: 'blob',
          ref: { $link: 'bafkfakeblob' },
          mimeType: 'image/png',
          size: PNG.length,
        },
        alt: 'The garden at sunset',
        aspectRatio: { width: 1, height: 1 },
      },
    ],
  });
});

test('send_dm to a handle, once a minute for the same text; delete_post only for the own account', async (t) => {
  const { bsky, gladys } = await setup(t);
  const ack = await gladys.fake.sceneAction('send_dm', {
    recipient: '@bob.bsky.social',
    text: 'Parcel delivered',
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { convo_id: 'convo-bob', message_id: 'msg-out-1' });
  await gladys.fake.sceneAction('send_dm', {
    recipient: 'bob.bsky.social',
    text: 'Parcel delivered',
  });
  assert.equal(bsky.fake.sent.length, 1);
  const unknown = await gladys.fake.sceneAction('send_dm', {
    recipient: 'nobody.bsky.social',
    text: 'hi',
  });
  assert.match(unknown.error, /Unknown Bluesky handle/);
  const foreign = await gladys.fake.sceneAction('delete_post', {
    post: 'https://bsky.app/profile/alice.bsky.social/post/3lparent',
  });
  assert.equal(foreign.success, false);
  const own = await gladys.fake.sceneAction('delete_post', {
    post: `at://${SELF.did}/app.bsky.feed.post/3maaaaaaaaaaa1`,
  });
  assert.equal(own.success, true, own.error);
  assert.deepEqual(bsky.fake.deleted, [
    { repo: SELF.did, collection: 'app.bsky.feed.post', rkey: '3maaaaaaaaaaa1' },
  ]);
});

test('widgets: valid contents in the four languages; the check button answers a toast', async (t) => {
  const { bsky, gladys, app } = await setup(t);
  bsky.notify('mention', ALICE, { text: 'hello' });
  bsky.receive(ALICE, 'secret plans');
  await app.readNotifications();
  await app.readMessages();
  for (const language of ['en', 'fr', 'de', 'es']) {
    for (const [key, settings] of [
      ['account', {}],
      ['notifications', { include_likes: false }],
      ['messages', { show_text: false }],
      ['messages', { show_text: true }],
    ]) {
      const ack = await gladys.fake.widgetGet(key, { language, settings });
      assert.equal(ack.success, true, `${key} ${language}`);
      assert.deepEqual(validateWidgetContent(ack.data.content), [], `${key} ${language}`);
    }
  }
  const hidden = await gladys.fake.widgetGet('messages', { settings: { show_text: false } });
  assert.doesNotMatch(JSON.stringify(hidden.data.content), /secret plans/);
  const shown = await gladys.fake.widgetGet('messages', { settings: { show_text: true } });
  assert.match(JSON.stringify(shown.data.content), /secret plans/);
  const account = await gladys.fake.widgetGet('account', { language: 'fr' });
  assert.match(JSON.stringify(account.data.content), /Home · @home-gladys\.bsky\.social/);
  const toast = await gladys.fake.widgetAction('account', 'check');
  assert.match(toast.data.message.en, /Direct messages: readable\. Linked users: 1\./);
});

test('not configured: a clear status, no request, widgets still valid', async (t) => {
  const bsky = createFakeBluesky();
  await bsky.start();
  const { gladys } = await setup(t, {
    bsky,
    ready: false,
    config: { identifier: '', app_password: '' },
  });
  await until(() => gladys.fake.connectionStatus?.connected === false, 'status');
  assert.match(gladys.fake.connectionStatus.message.en, /Enter the handle of the Bluesky account/);
  assert.equal(bsky.fake.requests.length, 0);
  const ack = await gladys.fake.widgetGet('account');
  assert.deepEqual(validateWidgetContent(ack.data.content), []);
  const action = await gladys.fake.sceneAction('publish_post', { text: 'x' });
  assert.equal(action.success, false);
});

test('a new configuration with another account starts new references', async (t) => {
  const { gladys, app, bsky } = await setup(t);
  assert.equal(app.store.chatCursor() !== null, true);
  await gladys.fake.configUpdated({
    identifier: 'home@example.org',
    app_password: APP_PASSWORD,
    service: bsky.url(),
  });
  await until(() => app.connection() === 'connected', 'reconnected');
  assert.equal(bsky.fake.sessions, 2, 'another identifier: a new session');
});
