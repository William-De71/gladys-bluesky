// Widget contents for the generated illustrations, built by the real code of
// the integration: the app itself (src/app.js) wired to the fake Gladys of the
// SDK and to the fake PDS of the tests (test/helpers/fake-bluesky.js, on
// 127.0.0.1), on a fixed date. Three cards:
//   account         the profile, the counters and the connection
//   notifications   the last notifications (likes and reposts included)
//   messages        the last direct messages, with the widget setting
//                   "Show the text of the messages" on
// The accounts, the posts and the messages are invented.
// Written as JSON for render.js: node gen.mjs <repo> <out.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, out] = process.argv.slice(2);
const load = (file) => import(pathToFileURL(join(repo, file)).href);
const { createApp } = await load('src/app.js');
const { LANGUAGES } = await load('src/i18n.js');
const { createFakeBluesky, IDENTIFIER, APP_PASSWORD, ALICE, BOB, EVE } = await load(
  'test/helpers/fake-bluesky.js',
);
const { createFakeGladys } = await import(
  pathToFileURL(join(repo, 'node_modules/@gladysassistant/integration-sdk/lib/testing.js')).href
);

const manifest = JSON.parse(readFileSync(join(repo, 'gladys-assistant-integration.json'), 'utf8'));
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEXTS = {
  en: {
    reply: 'Love the solar report, how many kWh this week?',
    mention: '@home-gladys.bsky.social is the garage door closed?',
    dm: 'Turn on the kitchen light',
    answer: 'The kitchen light is on.',
    stranger: 'Hello, is this the account of the house?',
    post: 'The solar panels produced 12 kWh today ☀️ #solar',
  },
  fr: {
    reply: 'Super le bilan solaire, combien de kWh cette semaine ?',
    mention: '@home-gladys.bsky.social la porte du garage est fermée ?',
    dm: 'Allume la lumière de la cuisine',
    answer: 'La lumière de la cuisine est allumée.',
    stranger: 'Bonjour, c’est bien le compte de la maison ?',
    post: 'Les panneaux solaires ont produit 12 kWh aujourd’hui ☀️ #solaire',
  },
  de: {
    reply: 'Toller Solarbericht, wie viele kWh diese Woche?',
    mention: '@home-gladys.bsky.social ist das Garagentor zu?',
    dm: 'Mach das Licht in der Küche an',
    answer: 'Das Licht in der Küche ist an.',
    stranger: 'Hallo, ist das das Konto des Hauses?',
    post: 'Die Solaranlage hat heute 12 kWh erzeugt ☀️ #solar',
  },
  es: {
    reply: 'Genial el informe solar, ¿cuántos kWh esta semana?',
    mention: '@home-gladys.bsky.social ¿está cerrada la puerta del garaje?',
    dm: 'Enciende la luz de la cocina',
    answer: 'La luz de la cocina está encendida.',
    stranger: 'Hola, ¿es esta la cuenta de la casa?',
    post: 'Los paneles solares produjeron 12 kWh hoy ☀️ #solar',
  },
};

const cards = {
  account: { widget: 'account', settings: {} },
  notifications: { widget: 'notifications', settings: { include_likes: true } },
  messages: { widget: 'messages', settings: { show_text: true } },
};
const contents = Object.fromEntries(LANGUAGES.map((language) => [language, {}]));

for (const language of LANGUAGES) {
  const words = TEXTS[language];
  // Saturday 24 October 2026, 19:12 in Paris.
  const clock = Date.UTC(2026, 9, 24, 17, 12, 0);
  const at = (minutesAgo) => new Date(clock - minutesAgo * 60_000).toISOString();
  const bsky = createFakeBluesky();
  await bsky.start();
  const dir = await mkdtemp(join(tmpdir(), 'gladys-bluesky-illustration-'));
  const gladys = createFakeGladys({
    config: { identifier: IDENTIFIER, app_password: APP_PASSWORD, service: bsky.url(), language },
    contacts: [
      {
        contact_id: ALICE.did,
        contact_name: `@${ALICE.handle}`,
        linked_at: null,
        user: { selector: 'alice', first_name: 'Alice', language },
      },
    ],
  });
  const app = createApp(gladys, { dataDir: dir, now: () => clock, logger: silent });
  await gladys.connect();
  await app.start();
  while (!(app.store.hasReference() && app.messagesState() === 'on')) await sleep(10);
  bsky.notify('like', BOB, { indexedAt: at(95) });
  bsky.notify('follow', EVE, { indexedAt: at(70) });
  bsky.notify('reply', ALICE, { text: words.reply, indexedAt: at(41) });
  bsky.notify('repost', ALICE, { indexedAt: at(22) });
  bsky.notify('mention', BOB, { text: words.mention, indexedAt: at(6) });
  bsky.fake.unread = 3;
  await app.readNotifications();
  bsky.receive(EVE, words.stranger, { sentAt: at(52), status: 'request' });
  bsky.receive(ALICE, words.dm, { sentAt: at(3) });
  await app.readMessages();
  await gladys.fake.sendMessage({ id: ALICE.did }, { text: words.answer, file: null });
  await gladys.fake.sceneAction('publish_post', { text: words.post });
  for (const [name, { widget, settings }] of Object.entries(cards)) {
    const ack = await gladys.fake.widgetGet(widget, { settings, language });
    if (!ack.success) throw new Error(`${name}: ${ack.error}`);
    contents[language][name] = ack.data.content;
  }
  await app.stop();
  await gladys.fake.shutdown();
  await bsky.stop();
  await rm(dir, { recursive: true, force: true });
}

writeFileSync(
  out,
  JSON.stringify({
    contents,
    images: {},
    cards: Object.fromEntries(
      Object.entries(cards).map(([name, { widget }]) => {
        const declaration = manifest.widgets.find((entry) => entry.key === widget);
        return [name, { icon: declaration.icon, label: declaration.label }];
      }),
    ),
  }),
);
