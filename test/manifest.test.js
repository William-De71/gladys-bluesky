import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import {
  TRIGGERS,
  SCENE_ACTIONS,
  FAILURE_REASONS,
  notificationEvent,
  messageEvent,
  notSentEvent,
} from '../src/events.js';
import { CONFIG_ACTIONS } from '../src/app.js';
import { WIDGETS } from '../src/widgets.js';
import { LANGUAGES, CHECK_INTERVALS } from '../src/config.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const manifest = read('../gladys-assistant-integration.json');
const pkg = read('../package.json');
const lock = read('../package-lock.json');
const byKey = (list) => new Map(list.map((entry) => [entry.key, entry]));
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const REPO = 'William-De71/gladys-bluesky';

test('a bidirectional communication integration, in lockstep with package.json, at 0.x', () => {
  assert.equal(manifest.type, 'communication');
  assert.deepEqual(manifest.messaging, { receive: true });
  assert.equal(manifest.contact_schema, undefined, 'linked by code: no contact_schema');
  assert.equal(manifest.name, 'Bluesky');
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(pkg.version, /^0\./);
  assert.equal(manifest.docker_image, `ghcr.io/william-de71/gladys-bluesky:${pkg.version}`);
  assert.equal(manifest.cover_image, `https://raw.githubusercontent.com/${REPO}/main/cover.jpg`);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.name, 'gladys-bluesky');
  // fetch, Intl.Segmenter and TextEncoder are built in: the SDK only.
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
});

test('declares the cloud transport: only the XRPC client and the image download use the network', () => {
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.match(source('../src/bluesky-api.js'), /\/xrpc\//);
  // app.js only hands fetch to images.js (the optional image of a post).
  assert.equal(source('../src/app.js').match(/\bfetch\(/g).length, 1);
  for (const file of ['events', 'widgets', 'config', 'store', 'i18n', 'richtext']) {
    assert.doesNotMatch(
      source(`../src/${file}.js`),
      /\bfetch\(|node:https?|node:net|node:dgram|WebSocket/,
      file,
    );
  }
  assert.doesNotMatch(source('../src/app.js'), /publishTransports|GLADYS_PREFER_LOCAL/);
  // Never mark the notifications as seen: the owner keeps them unread.
  assert.doesNotMatch(source('../src/bluesky-api.js'), /updateSeen/);
});

test('gladys_version 5.3.0 (keywords), categories, no permission, no newer field', () => {
  assert.equal(manifest.gladys_version, '>=5.3.0');
  assert.deepEqual(manifest.categories, ['notifications', 'assistants']);
  for (const key of [
    'location',
    'network_wake',
    'network_discovery',
    'containers',
    'webhooks',
    'energy_contracts',
    'account_schema',
    'music',
    'countries',
  ]) {
    assert.equal(manifest[key], undefined, key);
  }
  assert.doesNotMatch(JSON.stringify(manifest), /"source":"houses"/);
  // A widget button with a form needs 5.2.0 (covered), but none is used.
  assert.doesNotMatch(source('../src/widgets.js'), /fields:/);
});

test('the configuration: a secret app password, help sections, sensible defaults', () => {
  const config = byKey(manifest.config_schema);
  assert.deepEqual(
    [...config.keys()],
    [
      'intro',
      'identifier',
      'app_password',
      'service',
      'link_help',
      'receive_messages',
      'forward_messages',
      'check_interval',
      'watch_notifications',
      'language',
    ],
  );
  assert.equal(config.get('app_password').type, 'secret');
  assert.equal(config.get('app_password').required, true);
  assert.equal(config.get('app_password').placeholder, undefined, 'no fake password shape');
  assert.equal(config.get('identifier').required, true);
  assert.equal(config.get('service').required, undefined);
  assert.deepEqual(
    config.get('check_interval').options.map((option) => Number(option.value)),
    CHECK_INTERVALS,
  );
  assert.equal(config.get('check_interval').default, '15');
  for (const key of ['receive_messages', 'forward_messages', 'watch_notifications']) {
    assert.equal(config.get(key).default, true, key);
  }
  assert.deepEqual(
    config.get('language').options.map((option) => option.value),
    ['auto', ...LANGUAGES],
  );
  for (const field of manifest.config_schema) {
    assert.ok(!['text', 'password'].includes(field.type), field.key);
    assert.equal(field.display_if, undefined, `${field.key}: display_if is refused by the store`);
    if (field.type === 'section') {
      for (const language of LANGUAGES) assert.ok(field.description[language].length <= 1000);
      for (const link of field.links ?? []) assert.match(link.url, /^https:\/\//);
    }
  }
  assert.match(config.get('intro').description.en, /not affiliated with Bluesky Social PBC/);
  assert.match(config.get('intro').description.en, /Allow access to your direct messages/);
  assert.equal(config.get('intro').links[0].url, 'https://bsky.app/settings/app-passwords');
});

test('declares exactly the scene triggers, actions, buttons and widgets the code handles', () => {
  const app = source('../src/app.js');
  assert.deepEqual(
    manifest.scene_triggers.map((trigger) => trigger.key),
    Object.values(TRIGGERS),
  );
  assert.deepEqual(
    manifest.scene_actions.map((action) => action.key),
    Object.values(SCENE_ACTIONS),
  );
  assert.deepEqual(
    manifest.widgets.map((widget) => widget.key),
    Object.values(WIDGETS),
  );
  for (const key of ['ACCOUNT', 'NOTIFICATIONS', 'MESSAGES']) {
    assert.match(app, new RegExp(`onWidgetGet\\(WIDGETS\\.${key}`));
  }
  assert.match(app, /onWidgetAction\(WIDGETS\.ACCOUNT/);
  for (const key of ['PUBLISH_POST', 'SEND_DM', 'DELETE_POST']) {
    assert.match(app, new RegExp(`onSceneAction\\(SCENE_ACTIONS\\.${key}`));
  }
  assert.match(app, /onSendMessage\(/);
  assert.deepEqual(
    manifest.actions.map((action) => action.key),
    Object.values(CONFIG_ACTIONS),
  );
  assert.match(app, /onAction\(CONFIG_ACTIONS\.TEST_CONNECTION/);
  for (const trigger of manifest.scene_triggers) {
    for (const field of trigger.fields ?? []) {
      assert.ok(
        trigger.variables.some((variable) => variable.key === field.key),
        `${trigger.key}.${field.key}`,
      );
    }
  }
  const reasons = byKey(manifest.scene_triggers)
    .get('message_not_sent')
    .fields.find((field) => field.key === 'reason')
    .options.map((option) => option.value);
  assert.deepEqual(reasons, FAILURE_REASONS);
});

test('limits of the store: counts, timeouts, sizes, no secret in widget settings', () => {
  assert.ok(manifest.actions.length <= 10);
  assert.ok(manifest.widgets.length >= 1 && manifest.widgets.length <= 5);
  assert.ok(manifest.scene_triggers.length <= 20 && manifest.scene_actions.length <= 20);
  for (const trigger of manifest.scene_triggers) {
    assert.ok((trigger.fields ?? []).length <= 10 && trigger.variables.length <= 20, trigger.key);
    for (const field of trigger.fields ?? []) {
      assert.ok(['string', 'number', 'select', 'multi_select'].includes(field.type), field.key);
    }
  }
  for (const action of manifest.scene_actions) {
    assert.ok(action.fields.length <= 10, action.key);
    assert.ok((action.outputs ?? []).length <= 20, action.key);
    // A field added later must never be required without a default.
    const required = action.fields.filter((field) => field.required).map((field) => field.key);
    assert.deepEqual(
      required,
      { publish_post: ['text'], send_dm: ['recipient', 'text'], delete_post: ['post'] }[action.key],
    );
  }
  for (const action of [...manifest.scene_actions, ...manifest.actions]) {
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120, action.key);
  }
  for (const widget of manifest.widgets) {
    for (const setting of widget.settings ?? []) {
      assert.ok(!['secret', 'oauth2', 'account_link'].includes(setting.type));
    }
  }
  const size = statSync(new URL('../gladys-assistant-integration.json', import.meta.url)).size;
  assert.ok(size < 100 * 1024, `${size} bytes`);
  const cover = readFileSync(new URL('../cover.jpg', import.meta.url));
  assert.ok(cover.length < 150 * 1024, `cover.jpg: ${cover.length} bytes`);
  assert.equal(cover.readUInt16BE(0), 0xffd8, 'cover.jpg is a JPEG');
});

test('every scene event carries exactly the variables its trigger declares', () => {
  const self = { did: 'did:plc:houseaaaaaaaaaaaaaaaaaaa', handle: 'home.bsky.social' };
  const author = { did: 'did:plc:aliceaaaaaaaaaaaaaaaaaaa', handle: 'alice.bsky.social' };
  const own = `at://${self.did}/app.bsky.feed.post/3lown`;
  const notification = (reason) => ({
    uri: `at://${author.did}/app.bsky.feed.post/3lx`,
    reason,
    reasonSubject: own,
    author,
    record: { text: 'hi' },
  });
  const message = {
    text: 'hi',
    did: author.did,
    handle: author.handle,
    name: 'A',
    convoId: 'c',
    id: 'm',
  };
  const data = {
    mention_received: notificationEvent(notification('mention'), self),
    reply_received: notificationEvent(notification('reply'), self),
    quote_received: notificationEvent(notification('quote'), self),
    new_follower: notificationEvent(notification('follow'), self),
    like_received: notificationEvent(notification('like'), self),
    repost_received: notificationEvent(notification('repost'), self),
    dm_received: messageEvent({ ...message, user: { selector: 'alice', first_name: 'Alice' } }),
    dm_received_unlinked: messageEvent(message),
    message_not_sent: notSentEvent({ target: author.did, reason: 'auth', error: 'x' }),
  };
  for (const trigger of manifest.scene_triggers) {
    assert.deepEqual(
      Object.keys(data[trigger.key]).sort(),
      trigger.variables.map((variable) => variable.key).sort(),
      trigger.key,
    );
  }
});

test('scene actions return only their declared outputs', () => {
  const app = source('../src/app.js');
  const outputs = Object.fromEntries(
    manifest.scene_actions.map((action) => [action.key, (action.outputs ?? []).map((o) => o.key)]),
  );
  assert.deepEqual(outputs, {
    publish_post: ['uri', 'url', 'cid'],
    send_dm: ['convo_id', 'message_id'],
    delete_post: [],
  });
  assert.match(
    app,
    /const outputs = \{\n\s+uri: created\.uri,\n\s+url: postUrl\(created\.uri, self\.handle\),\n\s+cid:/,
  );
  assert.match(app, /const outputs = \{ convo_id: [^,]+, message_id: [^}]+\}/);
});

test('catalog search terms of Gladys 5.3.0: keywords within bounds, no countries', () => {
  assert.ok(Array.isArray(manifest.keywords));
  assert.ok(manifest.keywords.length >= 1 && manifest.keywords.length <= 10);
  const normalized = manifest.keywords.map((keyword) => keyword.trim().toLowerCase());
  for (const keyword of normalized) {
    assert.ok(keyword.length >= 2 && keyword.length <= 30, keyword);
  }
  assert.equal(new Set(normalized).size, normalized.length, 'keywords must be unique');
  assert.ok(!normalized.includes(manifest.name.toLowerCase()), 'the name is already searched');
  assert.ok(normalized.includes('atproto') && normalized.includes('bsky'));
  assert.equal(manifest.countries, undefined, 'usable worldwide');
});
