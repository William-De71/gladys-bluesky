// A fake Bluesky PDS on 127.0.0.1, for the tests only: the XRPC methods the
// integration calls, with the shapes of the official lexicons
// (bluesky-social/atproto, packages/api/lexicons) and the errors of the PDS
// (`{ error, message }`, ExpiredToken, "Bad token method" for an app password
// without direct messages, 429 with ratelimit-* headers). Nothing starts on
// import (`node --test` also loads this folder).
import { createServer } from 'node:http';

const CHAT_PROXY = 'did:web:api.bsky.chat#bsky_chat';
// Clearly fake credentials: never the shape of a real app password.
const IDENTIFIER = 'home-gladys.bsky.social';
const APP_PASSWORD = 'not-a-real-app-password';

/**
 * @description A did:plc of a test account (24 base32 characters).
 * @param {string} name - Letters a-z only.
 * @returns {string} The DID.
 */
const did = (name) => `did:plc:${name.padEnd(24, 'a').slice(0, 24)}`;
const SELF = { did: did('house'), handle: IDENTIFIER, displayName: 'Home' };
const ALICE = { did: did('alice'), handle: 'alice.bsky.social', displayName: 'Alice' };
const BOB = { did: did('bob'), handle: 'bob.bsky.social', displayName: 'Bob' };
const EVE = { did: did('eve'), handle: 'eve.bsky.social', displayName: 'Eve' };
const PROFILES = [SELF, ALICE, BOB, EVE];

/**
 * @description A fake JWT (unsigned) with an expiry.
 * @param {string} kind - access or refresh.
 * @param {number} expSeconds - Expiry (epoch seconds).
 * @param {number} serial - A counter.
 * @returns {string} The token.
 */
const fakeJwt = (kind, expSeconds, serial) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'fake' })).toString('base64url'),
    Buffer.from(JSON.stringify({ scope: kind, exp: expSeconds, fake: serial })).toString(
      'base64url',
    ),
    'not-a-signature',
  ].join('.');

/**
 * @description Create the fake server.
 * @param {object} [options] - Options.
 * @param {number} [options.accessTtlS] - Lifetime of an access token.
 * @returns {object} The fake: start(), stop(), url(), state and helpers.
 */
function createFakeBluesky({ accessTtlS = 7200 } = {}) {
  let server;
  let base = '';
  let serial = 0;
  let rev = 1000;
  const fake = {
    requests: [],
    sessions: 0,
    refreshes: 0,
    password: APP_PASSWORD,
    twoFactor: false,
    dmScope: true,
    accessTtlS,
    access: new Set(),
    issued: new Set(),
    refresh: new Set(),
    notifications: [],
    unread: 0,
    logs: [],
    convos: new Map(),
    sent: [],
    records: [],
    deleted: [],
    blobs: [],
    reads: [],
    accepted: [],
    posts: new Map(),
    chatRefusals: new Map(), // did -> error name of getConvoForMembers
    failNext: [], // { method, status, body, headers }
  };

  const nextRev = () => `2222${String((rev += 1)).padStart(9, '0')}`;

  /** @returns {object} New tokens. */
  function issue() {
    serial += 1;
    const now = Math.floor(Date.now() / 1000);
    const accessJwt = fakeJwt('access', now + fake.accessTtlS, serial);
    const refreshJwt = fakeJwt('refresh', now + 90 * 86400, serial);
    fake.access.add(accessJwt);
    fake.issued.add(accessJwt);
    fake.refresh.add(refreshJwt);
    return {
      accessJwt,
      refreshJwt,
      handle: SELF.handle,
      did: SELF.did,
      didDoc: {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: SELF.did,
        alsoKnownAs: [`at://${SELF.handle}`],
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: base }],
      },
      active: true,
    };
  }

  const profileOf = (actor) => PROFILES.find((p) => p.did === actor || p.handle === actor);
  const basic = (p) => ({ did: p.did, handle: p.handle, displayName: p.displayName });

  /**
   * @description Get (or create) the direct conversation with an account.
   * @param {object} other - A profile.
   * @param {string} [status] - accepted or request.
   * @returns {object} The convoView.
   */
  function convoWith(other, status = 'accepted') {
    for (const convo of fake.convos.values()) {
      if (convo.members.some((m) => m.did === other.did)) return convo;
    }
    const convo = {
      id: `convo-${other.handle.split('.')[0]}`,
      rev: nextRev(),
      members: [basic(SELF), basic(other)],
      muted: false,
      unreadCount: 0,
      status,
      kind: { $type: 'chat.bsky.convo.defs#directConvo' },
    };
    fake.convos.set(convo.id, convo);
    return convo;
  }

  const methods = {
    'com.atproto.server.createSession': ({ body }) => {
      fake.sessions += 1;
      if (fake.twoFactor)
        return [
          401,
          {
            error: 'AuthFactorTokenRequired',
            message: 'A sign in code has been sent to your email address',
          },
        ];
      if (
        ![SELF.handle, 'home@example.org'].includes(body?.identifier) ||
        body?.password !== fake.password
      ) {
        return [
          401,
          { error: 'AuthenticationRequired', message: 'Invalid identifier or password' },
        ];
      }
      return [200, issue()];
    },
    'com.atproto.server.refreshSession': ({ token }) => {
      fake.refreshes += 1;
      if (!fake.refresh.has(token))
        return [400, { error: 'ExpiredToken', message: 'Token has been revoked' }];
      fake.refresh.delete(token);
      return [200, issue()];
    },
    'com.atproto.identity.resolveHandle': ({ query }) => {
      const p = profileOf(query.get('handle'));
      return p
        ? [200, { did: p.did }]
        : [400, { error: 'HandleNotFound', message: 'Unable to resolve handle' }];
    },
    'app.bsky.actor.getProfile': ({ query }) => {
      const p = profileOf(query.get('actor'));
      if (!p) return [400, { error: 'InvalidRequest', message: 'Profile not found' }];
      return [
        200,
        {
          ...basic(p),
          followersCount: 128,
          followsCount: 42,
          postsCount: 17 + fake.records.length - fake.deleted.length,
          indexedAt: '2026-10-01T10:00:00.000Z',
        },
      ];
    },
    'app.bsky.feed.getPosts': ({ query }) => [
      200,
      {
        posts: query
          .getAll('uris')
          .map((uri) => fake.posts.get(uri))
          .filter(Boolean),
      },
    ],
    'app.bsky.notification.listNotifications': ({ query }) => [
      200,
      {
        notifications: fake.notifications.slice(0, Number(query.get('limit') ?? 50)),
        seenAt: '2026-11-01T08:00:00.000Z',
      },
    ],
    'app.bsky.notification.getUnreadCount': () => [200, { count: fake.unread }],
    'com.atproto.repo.createRecord': ({ body }) => {
      if (body?.repo !== SELF.did || body?.record?.$type !== body?.collection) {
        return [400, { error: 'InvalidRequest', message: 'Invalid record' }];
      }
      const rkey = `3m${String(fake.records.length + 1).padStart(11, 'a')}`;
      const uri = `at://${SELF.did}/${body.collection}/${rkey}`;
      fake.records.push({ uri, ...body });
      return [200, { uri, cid: `bafyfakecid${fake.records.length}`, validationStatus: 'valid' }];
    },
    'com.atproto.repo.deleteRecord': ({ body }) => {
      fake.deleted.push(body);
      return [200, {}];
    },
    'com.atproto.repo.uploadBlob': ({ raw, headers }) => {
      fake.blobs.push({ size: raw.length, mimeType: headers['content-type'] });
      return [
        200,
        {
          blob: {
            $type: 'blob',
            ref: { $link: 'bafkfakeblob' },
            mimeType: headers['content-type'],
            size: raw.length,
          },
        },
      ];
    },
    'chat.bsky.convo.getLog': ({ query }) => {
      const cursor = query.get('cursor');
      const logs = cursor ? fake.logs.filter((log) => log.rev > cursor) : [];
      const latest = fake.logs.at(-1)?.rev ?? '2222000000000';
      return [200, { logs, cursor: latest }];
    },
    'chat.bsky.convo.getConvo': ({ query }) => {
      const convo = fake.convos.get(query.get('convoId'));
      return convo
        ? [200, { convo }]
        : [400, { error: 'InvalidConvo', message: 'Convo not found' }];
    },
    'chat.bsky.convo.getConvoForMembers': ({ query }) => {
      const member = profileOf(query.getAll('members')[0]);
      if (!member) return [400, { error: 'RecipientNotFound', message: 'Recipient not found' }];
      const refusal = fake.chatRefusals.get(member.did);
      if (refusal) return [400, { error: refusal, message: 'recipient refuses' }];
      return [200, { convo: convoWith(member) }];
    },
    'chat.bsky.convo.acceptConvo': ({ body }) => {
      fake.accepted.push(body.convoId);
      const convo = fake.convos.get(body.convoId);
      if (convo) convo.status = 'accepted';
      return [200, { rev: nextRev() }];
    },
    'chat.bsky.convo.sendMessage': ({ body }) => {
      if (!fake.convos.has(body?.convoId))
        return [400, { error: 'InvalidConvo', message: 'Convo not found' }];
      const message = {
        id: `msg-out-${fake.sent.length + 1}`,
        rev: nextRev(),
        text: body.message.text,
        ...(body.message.facets ? { facets: body.message.facets } : {}),
        sender: { did: SELF.did },
        sentAt: new Date().toISOString(),
      };
      fake.sent.push({ convoId: body.convoId, message: body.message });
      // The account sees its own messages in the log too.
      fake.logs.push({
        $type: 'chat.bsky.convo.defs#logCreateMessage',
        rev: message.rev,
        convoId: body.convoId,
        message: { $type: 'chat.bsky.convo.defs#messageView', ...message },
      });
      return [200, message];
    },
    'chat.bsky.convo.updateRead': ({ body }) => {
      fake.reads.push(body);
      return [200, { convo: fake.convos.get(body.convoId) }];
    },
  };

  /**
   * @description Handle a request.
   * @param {import('node:http').IncomingMessage} req - The request.
   * @param {import('node:http').ServerResponse} res - The response.
   */
  async function handle(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, base);
    const method = url.pathname.replace('/xrpc/', '');
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    let body;
    if ((req.headers['content-type'] ?? '').startsWith('application/json')) {
      body = JSON.parse(raw.toString() || '{}');
    }
    fake.requests.push({ method, query: url.searchParams, headers: req.headers, body, token });
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    const failure = fake.failNext.findIndex((f) => f.method === method);
    if (failure >= 0) {
      const [f] = fake.failNext.splice(failure, 1);
      send(f.status, f.body ?? {}, f.headers ?? {});
      return;
    }
    const handler = methods[method];
    if (!handler) {
      send(501, { error: 'MethodNotImplemented', message: method });
      return;
    }
    const open = ['com.atproto.server.createSession', 'com.atproto.server.refreshSession'];
    if (!open.includes(method) && !fake.access.has(token)) {
      // A token it issued and no longer accepts has expired.
      const expired = fake.issued.has(token);
      send(
        expired ? 400 : 401,
        expired
          ? { error: 'ExpiredToken', message: 'Token has expired' }
          : { error: 'AuthenticationRequired', message: 'Authentication Required' },
      );
      return;
    }
    if (method.startsWith('chat.bsky.')) {
      if (req.headers['atproto-proxy'] !== CHAT_PROXY) {
        send(501, { error: 'MethodNotImplemented', message: 'no proxy' });
        return;
      }
      if (!fake.dmScope) {
        send(400, { error: 'InvalidToken', message: 'Bad token method' });
        return;
      }
    }
    const [status, payload] = handler({
      query: url.searchParams,
      body,
      token,
      raw,
      headers: req.headers,
    });
    send(status, payload, {
      'ratelimit-limit': '3000',
      'ratelimit-remaining': '2999',
      'ratelimit-reset': String(Math.floor(Date.now() / 1000) + 300),
      'ratelimit-policy': '3000;w=300',
    });
  }

  return {
    fake,
    url: () => base,
    async start() {
      server = createServer((req, res) => {
        handle(req, res).catch((err) => {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'InternalServerError', message: err.message }));
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${server.address().port}`;
    },
    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
    /** @description Expire every access token (next call: ExpiredToken). */
    expireAccess() {
      fake.access.clear();
    },
    /**
     * @description A direct message from an account to the house.
     * @param {object} from - A profile.
     * @param {string} text - The text.
     * @param {object} [options] - sentAt, status of a new conversation.
     * @returns {object} The log.
     */
    receive(from, text, { sentAt = new Date().toISOString(), status = 'accepted' } = {}) {
      const convo = convoWith(from, status);
      const log = {
        $type: 'chat.bsky.convo.defs#logCreateMessage',
        rev: nextRev(),
        convoId: convo.id,
        message: {
          $type: 'chat.bsky.convo.defs#messageView',
          id: `msg-${fake.logs.length + 1}`,
          rev: nextRev(),
          text,
          sender: { did: from.did },
          sentAt,
        },
        relatedProfiles: [basic(from), basic(SELF)],
      };
      fake.logs.push(log);
      return log;
    },
    /**
     * @description A notification for the house (newest first, like the PDS).
     * @param {string} reason - like, repost, follow, mention, reply, quote…
     * @param {object} from - A profile.
     * @param {object} [extra] - text, indexedAt.
     * @returns {object} The notification.
     */
    notify(reason, from, { text = '', indexedAt = new Date().toISOString() } = {}) {
      const n = fake.notifications.length + 1;
      const ownPost = `at://${SELF.did}/app.bsky.feed.post/3lownpost${n}`;
      const collection =
        {
          like: 'app.bsky.feed.like',
          repost: 'app.bsky.feed.repost',
          follow: 'app.bsky.graph.follow',
        }[reason] ?? 'app.bsky.feed.post';
      const uri = `at://${from.did}/${collection}/3lrecord${String(n).padStart(4, '0')}`;
      let record;
      if (reason === 'like' || reason === 'repost') {
        record = {
          $type: collection,
          subject: { uri: ownPost, cid: 'bafyown' },
          createdAt: indexedAt,
        };
      } else if (reason === 'follow') {
        record = { $type: collection, subject: SELF.did, createdAt: indexedAt };
      } else {
        record = { $type: 'app.bsky.feed.post', text, langs: ['en'], createdAt: indexedAt };
        if (reason === 'reply')
          record.reply = {
            root: { uri: ownPost, cid: 'bafyown' },
            parent: { uri: ownPost, cid: 'bafyown' },
          };
        if (reason === 'quote')
          record.embed = {
            $type: 'app.bsky.embed.record',
            record: { uri: ownPost, cid: 'bafyown' },
          };
      }
      const notification = {
        uri,
        cid: `bafynotif${n}`,
        author: {
          ...basic(from),
          avatar: 'https://cdn.bsky.app/img/avatar/plain/fake/avatar@jpeg',
          viewer: {},
          labels: [],
        },
        reason,
        ...(['like', 'repost', 'reply', 'quote'].includes(reason)
          ? { reasonSubject: ownPost }
          : {}),
        record,
        isRead: false,
        indexedAt,
        labels: [],
      };
      fake.notifications.unshift(notification);
      fake.unread += 1;
      return notification;
    },
    /**
     * @description A post the account can reply to.
     * @param {object} author - A profile.
     * @param {string} rkey - The record key.
     * @param {object} [reply] - Its own reply ref (a post in a thread).
     * @returns {string} Its AT URI.
     */
    addPost(author, rkey, reply) {
      const uri = `at://${author.did}/app.bsky.feed.post/${rkey}`;
      fake.posts.set(uri, {
        uri,
        cid: `bafy${rkey}`,
        author: basic(author),
        record: {
          $type: 'app.bsky.feed.post',
          text: 'a post',
          createdAt: '2026-11-01T08:00:00.000Z',
          ...(reply ? { reply } : {}),
        },
        indexedAt: '2026-11-01T08:00:00.000Z',
      });
      return uri;
    },
  };
}

export {
  createFakeBluesky,
  CHAT_PROXY,
  IDENTIFIER,
  APP_PASSWORD,
  SELF,
  ALICE,
  BOB,
  EVE,
  did,
  fakeJwt,
};
