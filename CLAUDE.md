# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for **Bluesky** (unofficial, not
affiliated with Bluesky Social PBC): a Node.js service (Node 22+, ESM, no build
step) in its own sandboxed Docker container, talking to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
and to Bluesky through the official XRPC API of the AT Protocol, with an app
password of one account (ideally an account of the house):

- the **PDS of the account** (read in the DID document of createSession;
  `bsky.social` is only the entryway): session, records, profile,
  notifications (`app.bsky.*` is proxied by the PDS to the AppView);
- the **chat service** through the same PDS, with the header
  `atproto-proxy: did:web:api.bsky.chat#bsky_chat`.

Everything is polled (no webhook exists for a home server): direct messages
every 10-60 s (`chat.bsky.convo.getLog`, by `rev`), notifications every 30 s,
the profile every 5 minutes. `type: "communication"`,
`messaging: { receive: true }` (linked by code, contact id = DID),
`transports: ["cloud"]`, Gladys 5.3.0+ (keywords). Runtime dependency: the SDK
only (fetch, Intl.Segmenter and TextEncoder are built in).

**Never tested with a real Bluesky account.** Everything is tested against a
fake PDS (`test/helpers/fake-bluesky.js`) built from the official lexicons
(bluesky-social/atproto, `packages/api/lexicons`) and docs.bsky.app.

## Commands

```bash
npm install
npm test                                  # node --test; a fake PDS on 127.0.0.1, never the network
node --test test/app.test.js              # one file
UPDATE_BASELINE=1 npm test                # rewrite test/fixtures/manifest.baseline.json (on purpose only)
npm run coverage                          # coverage of src/
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npx github:GladysAssistant/integration-store . --skip-image-check   # store checks (delete any *.duckdb it leaves)
scripts/build-cover.sh                    # cover.jpg from docs/assets/cover.svg
docs/illustrations/render.sh              # docs/assets/widgets.<lang>.png
node .github/scripts/release.mjs next     # the version the next release would get (needs the git history)
```

## Architecture

```
index.js                SDK wiring only: createApp(gladys) + connect + start
src/app.js              every handler: session and status, loops (profile,
                        notifications, direct messages), incoming messages
                        (link codes, brain, triggers), outgoing (onSendMessage),
                        scene actions, widgets, configuration button
src/bluesky-api.js      XRPC client: createSession once, refreshSession, PDS of
                        the DID document, chat proxy header, {error,message}
                        errors -> reasons, 429 / ratelimit-* pauses
src/richtext.js         graphemes, facets in UTF-8 bytes, splitting, AT URIs and
                        bsky.app links
src/images.js           the optional image of a post (download, type, size)
src/events.js           trigger / action keys, flat event data, message_not_sent once
src/widgets.js          the three widgets (pure, reused by docs/illustrations)
src/store.js            /data/state.json (cursors, seen notifications, counters)
                        and /data/session.json (tokens, mode 600)
src/config.js           identifier, server, flags, interval, language, handles/DIDs
src/i18n.js             runtime texts and answers, en / fr / de / es
test/helpers/fake-bluesky.js  the fake PDS (XRPC, errors, rate limits, builders)
.github/scripts/release.mjs   version, changelog, bump (tested in test/)
```

## Rules

- **Keys are forever**: the keys of `config_schema` and `actions`, the widgets
  and their settings, the triggers (fields, options, variables), the scene
  actions (fields, outputs), and the contact id (the DID of the Bluesky
  account, as linked in Gladys; never the handle, which can change).
  `test/structure.test.js` compares them to `test/fixtures/manifest.baseline.json`:
  never update it to make a test pass without a documented migration.
- **One login**: createSession is limited to 30 per 5 minutes and 300 per day
  and per account. The session lives in `/data/session.json` and is renewed
  with refreshSession; a refused password is never retried by a loop, only by
  a new configuration or "Test the connection".
- **Only linked users** reach the brain (`publishMessage`) and `dm_received`.
  Other accounts only fire `dm_received_unlinked`, get no automatic answer
  (an answer would accept a conversation request) and stay unread. The
  messages of the account itself, group conversations and messages read more
  than 15 minutes late are ignored.
- **References**: the first read of the notifications and of the direct
  messages fires nothing. Never `updateSeen`: the owner of the account keeps
  their unread notifications. `updateRead` only for the messages of linked
  users.
- **Gladys waits 5 s** for `onSendMessage`: deliver within 4 s or let the
  delivery go on in the background; a late failure still fires
  `message_not_sent`.
- **Scene events** never because of a scene action or a widget button (no
  loop); `message_not_sent` once per user until a message goes through.
- **Anti-flood**: the same post (or the same DM to the same account) within a
  minute returns the previous outputs; 30 posts an hour at most.
- **Facets** are UTF-8 byte offsets; limits are graphemes (300 for a post,
  1,000 for a direct message): never JavaScript string indexes.
- **Secrets**: the app password is sent only to the configured server in the
  createSession body; tokens only in the `Authorization` header, to the PDS of
  the DID document (https only, http only for a local test server). Never in a
  log, an error, a scene output or `/data/state.json`.
- **Privacy**: the text of a message is never logged; the messages widget shows
  it only with `show_text`; the last messages live in memory only.
- **The container rootfs is read-only.** Write only under `/data`.
- **Four languages.** Every user-facing text (manifest, `src/i18n.js`,
  `docs/*.md`, README) exists in en, fr, de, es; `test/i18n.test.js` checks it.
  German says "du" (like the Gladys interface), Spanish "usted". Gladys UI
  labels quoted word for word ("Link my account", "Generate a link code").
- **Widget images.** After any change to a widget content, run
  `docs/illustrations/render.sh` again and look at the four PNG files. Budget
  of the account widget: 1 caption, 4 tiles, 1 body, 1 status, 1 button (8 of 8).
- **Versions belong to the Release workflow**: never edit `version` in
  `package.json`, the lockfile or the manifest, nor the `docker_image` tag.
  Below 1.0.0 until the maintainer runs Release with `release-as: 1.0.0`.
- **Changelog.** Ne jamais éditer CHANGELOG.md à la main, il est généré à la
  release. Écris le titre de PR comme la ligne que l'utilisateur lira.
- **Commits and PR titles** follow Conventional Commits, in English.
- **Forum drafts** (`.github/forum-*.md`) are never committed.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network beyond 127.0.0.1. Fake
  credentials never look like real ones (`not-a-real-app-password`).

## Assumptions (not verifiable without a real account)

- `chat.bsky.convo.getLog` without a cursor returns the latest `rev` as
  `cursor` (the official app initialises its polling this way), and with a
  cursor the events after it, including the messages the account sent.
- An app password without "Allow access to your direct messages" gets
  `400 InvalidToken "Bad token method"` on `chat.bsky.*` (PDS pipethrough,
  social-app `isErrorMaybeAppPasswordPermissions`).
- Sending in a conversation that is still a request needs `acceptConvo`
  first (done for linked users and link codes only).
- `ratelimit-reset` is an epoch in seconds (draft-polli headers as the PDS
  sends them); a value below 1e9 is read as seconds from now.
- The access token expires after about 2 hours (renewed 5 minutes before,
  from its `exp`); the refresh token rotates at each refreshSession.

## Pitfalls

- `node --test` also runs `test/helpers/`: nothing starts on import.
- `keywords` must not contain the name of the integration (already searched).
- The validator of the Gladys core may create `gladys-development.duckdb` in
  the current folder: delete it.
- A top-level `const SVG` in `docs/illustrations/render.js` would shadow the
  global of ApexCharts: it is `SVG_NS`.
- A card-list in list display only shows the title, the date and the badge:
  the text goes in the title (the description shows on click).
- Inkscape ignores `feDropShadow`: the cover uses a blurred copy instead.
