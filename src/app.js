// -----------------------------------------------------------------------------
// Every handler of the Bluesky integration, registered on the Gladys client it
// receives: index.js passes the real one, the tests the fake Gladys of the
// SDK (`@gladysassistant/integration-sdk/testing`).
//
// Bluesky is a COMMUNICATION integration of the BIDIRECTIONAL family
// (`messaging: { receive: true }`) on one Bluesky account (ideally an account
// of the house, e.g. @home-gladys.bsky.social) opened with an app password:
//   - incoming direct messages: chat.bsky.convo.getLog, polled every 10 to
//     60 s (no webhook exists, no public URL needed). A link code generated
//     in Gladys and sent in a direct message links the sender (their DID) to
//     their Gladys user (linkContact). Messages of linked users go to the
//     brain (publishMessage) and fire `dm_received`; messages of other
//     accounts only fire `dm_received_unlinked` and are left unread for a
//     human: no automatic answer (a reply would accept the conversation).
//     The messages the account sends itself are ignored (no loop);
//   - outgoing: onSendMessage(contact, message) -> the direct conversation
//     with the user (getConvoForMembers + sendMessage), split in parts of
//     1,000 graphemes, with facets. Images cannot travel in a Bluesky direct
//     message (chat.bsky.convo.defs#messageInput has no image embed);
//   - notifications: app.bsky.notification.listNotifications every 30 s; the
//     first read is the reference, then one scene event per new mention,
//     reply, quote, follower, like or repost. Never updateSeen: the owner of
//     the account keeps their unread notifications in the app;
//   - scene actions publish_post, send_dm, delete_post; three widgets; a
//     "Test the connection" button.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { logger as sdkLogger } from '@gladysassistant/integration-sdk';

import {
  AUTO_LANGUAGE,
  DID,
  INTERNAL_KEYS,
  LANGUAGES,
  configProblem,
  normalizeConfig,
  readActor,
  readLanguage,
} from './config.js';
import { createBlueskyApi } from './bluesky-api.js';
import { createStore } from './store.js';
import {
  TRIGGERS,
  REASON_TRIGGERS,
  SCENE_ACTIONS,
  notificationEvent,
  messageEvent,
  createFailureEvents,
} from './events.js';
import {
  WIDGETS,
  WIDGET_ACTIONS,
  MAX_CARDS,
  buildAccountWidget,
  buildNotificationsWidget,
  buildMessagesWidget,
} from './widgets.js';
import {
  MAX_POST_BYTES,
  MAX_POST_GRAPHEMES,
  detectFacets,
  postUrl,
  profileUrl,
  readPostRef,
  splitMessage,
  shorten,
  truncate,
} from './richtext.js';
import { readImage, fetchImage } from './images.js';
import { all, t } from './i18n.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const CONFIG_ACTIONS = { TEST_CONNECTION: 'test_connection' };
// The link codes of Gladys: 8 characters of an alphabet without 0/O, 1/I/L
// (server/lib/external-integration/externalIntegration.createLinkCode.js).
const LINK_CODE = /^[A-HJKMNP-Z2-9]{8}$/;
// A message or a notification older than this (read after an outage) does
// not reach the brain nor the scenes: "open the garage" from an hour ago
// must not run.
const MAX_AGE_MS = 15 * 60_000;
// Gladys waits 5 s for the acknowledgement of a message to send.
const SEND_DEADLINE_MS = 4000;
// Anti-flood of the scene actions: the same post (or the same direct message
// to the same account) within a minute is sent once; 30 posts an hour at most.
const DUPLICATE_WINDOW_MS = 60_000;
const MAX_POSTS_PER_HOUR = 30;
const CONTACTS_TTL_MS = 60_000;
const MAX_STATUS = 200;
const MAX_NOTIFICATIONS = 20;
const DEFAULT_DELAYS = {
  notificationsMs: 30_000,
  profileMs: 5 * 60_000,
  retryMs: 60_000,
  maxBackoffMs: 15 * 60_000,
};
const REFUSED = ['auth', 'two_factor', 'account', 'invalid', 'config'];

/**
 * @description A link code sent in a message, if it is one.
 * @param {string} text - The text.
 * @returns {string|null} The code, in capitals.
 * @example
 * linkCodeOf(' abcd2345 '); // -> 'ABCD2345'
 */
function linkCodeOf(text) {
  const code = String(text ?? '')
    .trim()
    .toUpperCase();
  return LINK_CODE.test(code) ? code : null;
}

/**
 * @description Cut every language of a message to the 200 characters of the
 * Configuration screen and of the toasts.
 * @param {Record<string, string>} message - The message.
 * @returns {Record<string, string>} The message.
 */
const bounded = (message) =>
  Object.fromEntries(
    Object.entries(message).map(([language, text]) => [language, shorten(text, MAX_STATUS)]),
  );

/**
 * @description The reason of a failed delivery, as the message_not_sent
 * trigger names it.
 * @param {Error} err - The failure.
 * @returns {string} A reason.
 */
function failureReason(err) {
  const reason = err?.reason;
  if (['auth', 'two_factor', 'account', 'expired', 'config'].includes(reason)) return 'auth';
  if (reason === 'network' || reason === 'server') return 'network';
  if (['dm_scope', 'recipient', 'rate_limited'].includes(reason)) return reason;
  return 'other';
}

/**
 * @description Register the handlers of the integration on a Gladys client.
 * @param {object} gladys - The GladysIntegration client (real or fake).
 * @param {object} [options] - Options (injected by the tests).
 * @param {object} [options.api] - The XRPC client (createBlueskyApi).
 * @param {Function} [options.fetchImpl] - fetch (images of posts).
 * @param {string} [options.dataDir] - The writable folder (/data).
 * @param {object} [options.delays] - Poll and retry delays (tests).
 * @param {() => number} [options.now] - Clock.
 * @param {object} [options.logger] - Logger.
 * @returns {object} Handles (start, stop, and what the tests look at).
 * @example
 * const app = createApp(new GladysIntegration());
 */
function createApp(
  gladys,
  {
    api: injectedApi,
    fetchImpl = (...args) => fetch(...args),
    dataDir,
    delays: injectedDelays,
    now = () => Date.now(),
    logger = sdkLogger,
  } = {},
) {
  const delays = { ...DEFAULT_DELAYS, ...(injectedDelays ?? {}) };
  const store = createStore({ logger, now, ...(dataDir ? { dir: dataDir } : {}) });
  const api = injectedApi ?? createBlueskyApi({ logger, now, sessionStore: store.session });
  const failures = createFailureEvents(gladys, logger);

  let config = normalizeConfig();
  let language = 'en';
  let lastStatus = null;
  let connection = 'not_configured';
  let refusal = null; // the XrpcError of a refused session
  let lastError = null; // the last session failure, for the button
  let self = null; // { did, handle, pdsUrl }
  let profile = null;
  let unread = null;
  let messagesState = 'unknown';
  let contactsCache = { at: 0, list: [] };
  let notifications = [];
  const messages = [];
  const timers = { connect: null, chat: null, notifications: null, profile: null };
  const failuresInARow = { chat: 0, notifications: 0, profile: 0 };
  let generation = 0; // a new configuration stops the loops of the previous one
  let stopped = false;
  const convos = new Map(); // convoId -> { direct, request }
  const convoOf = new Map(); // DID -> convoId
  const recentActions = new Map(); // anti-flood key -> { at, outputs }
  const postTimes = [];
  // The message being handled (one at a time, in order).
  let reading = Promise.resolve();
  const background = new Set();

  const replyLanguage = () => (config.language === AUTO_LANGUAGE ? language : config.language);
  const languageOf = (user) =>
    LANGUAGES.includes(user?.language) ? user.language : replyLanguage();

  // --- Gladys side -------------------------------------------------------------------

  /**
   * @description Report the connection status, only when it changed.
   * @param {boolean} connected - Connected or not.
   * @param {object} [message] - The multi-language message.
   * @returns {Promise<void>}
   */
  async function reportStatus(connected, message) {
    const signature = JSON.stringify([connected, message ?? null]);
    if (signature === lastStatus) {
      return;
    }
    lastStatus = signature;
    try {
      await gladys.setConnectionStatus(connected, message ? bounded(message) : undefined);
    } catch (err) {
      lastStatus = null;
      logger.warn(`Unable to report the connection status: ${err.message}`);
    }
  }

  /**
   * @description Ask the dashboards to read a widget again.
   * @param {...string} keys - The widgets (all by default).
   */
  function requestRefresh(...keys) {
    for (const key of keys.length > 0 ? keys : Object.values(WIDGETS)) {
      try {
        gladys.requestWidgetRefresh(key);
      } catch {
        // best effort (at most one call per 10 s and per widget)
      }
    }
  }

  /**
   * @description Remember the language of a dashboard (for `auto`).
   * @param {string} next - The language.
   */
  function rememberLanguage(next) {
    if (!LANGUAGES.includes(next) || next === language) {
      return;
    }
    language = next;
    Promise.resolve()
      .then(() => gladys.setConfig({ [INTERNAL_KEYS.language]: next }))
      .catch((err) => logger.debug(`Unable to store the language: ${err.message}`));
  }

  /**
   * @description The linked contacts (cached a minute).
   * @param {boolean} [fresh] - Skip the cache.
   * @returns {Promise<object[]>} getContacts entries.
   */
  async function linkedContacts(fresh = false) {
    if (!fresh && now() - contactsCache.at < CONTACTS_TTL_MS) {
      return contactsCache.list;
    }
    try {
      const list = await gladys.getContacts();
      contactsCache = { at: now(), list: Array.isArray(list) ? list : [] };
    } catch (err) {
      logger.warn(`Unable to read the linked contacts: ${err.message}`);
    }
    return contactsCache.list;
  }

  const contactOf = async (did) =>
    (await linkedContacts()).find((entry) => entry.contact_id === did) ?? null;

  /**
   * @description Fire a scene event, best effort.
   * @param {string} key - The trigger.
   * @param {object} data - The data.
   */
  async function fire(key, data) {
    try {
      await gladys.publishSceneEvent(key, data);
    } catch (err) {
      logger.warn(`Unable to publish the ${key} event: ${err.message}`);
    }
  }

  // --- connection ---------------------------------------------------------------------

  /**
   * @description The status message of a refused or failing session.
   * @param {Error} err - The XrpcError.
   * @returns {object} The multi-language message.
   */
  function statusOf(err) {
    switch (err?.reason) {
      case 'auth':
      case 'invalid':
        return all('statusRefused', { error: err.code });
      case 'two_factor':
        return all('statusTwoFactor');
      case 'account':
        return all('statusAccount', { error: err.detail || err.code });
      case 'rate_limited':
        return all('statusRateLimited', (l) => ({
          time: new Date(err.retryAt ?? now() + 60_000).toLocaleTimeString(l, {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: process.env.TZ || 'UTC',
          }),
        }));
      case 'network':
        return all('statusUnreachable');
      default:
        return all('statusError', { error: err?.code ?? '?' });
    }
  }

  /**
   * @description The connection is fine: say so (with a warning when the app
   * password cannot read the direct messages).
   * @returns {Promise<void>}
   */
  async function reportConnected() {
    connection = 'connected';
    const host = (() => {
      try {
        return new URL(self.pdsUrl).hostname;
      } catch {
        return '?';
      }
    })();
    await reportStatus(
      true,
      all(messagesState === 'no_access' ? 'statusConnectedNoDm' : 'statusConnected', {
        handle: self.handle,
        host,
      }),
    );
  }

  /**
   * @description A session failure: refused (no retry until a new
   * configuration or the button), or temporary (retry with a backoff).
   * @param {Error} err - The XrpcError.
   * @param {number} gen - The generation of the loop.
   * @returns {Promise<void>}
   */
  async function sessionFailed(err, gen) {
    if (gen !== generation || stopped) {
      return;
    }
    lastError = err;
    if (REFUSED.includes(err.reason)) {
      stopLoops();
      connection = 'refused';
      refusal = err;
      logger.warn(`Bluesky refuses the session (${err.code}): fix the configuration`);
      await reportStatus(false, statusOf(err));
      requestRefresh();
      return;
    }
    connection = err.reason === 'rate_limited' ? 'rate_limited' : 'unreachable';
    await reportStatus(false, statusOf(err));
    requestRefresh(WIDGETS.ACCOUNT);
  }

  /**
   * @description Run a loop: the task now, then again after its delay; a
   * failure waits longer (doubling, up to 15 min, or until a rate limit ends).
   * @param {string} name - chat, notifications or profile.
   * @param {() => number} every - The delay between two runs.
   * @param {() => Promise<boolean|void>} task - The work (false: stop the loop).
   * @param {number} gen - The generation.
   */
  function loop(name, every, task, gen) {
    const run = async () => {
      timers[name] = null;
      if (gen !== generation || stopped) {
        return;
      }
      let wait = every();
      try {
        const keep = await task();
        failuresInARow[name] = 0;
        if (keep === false) {
          return;
        }
        if (connection !== 'connected' && gen === generation) {
          await reportConnected();
          requestRefresh(WIDGETS.ACCOUNT);
        }
      } catch (err) {
        failuresInARow[name] += 1;
        logger.warn(`Bluesky ${name}: ${err.message}`);
        if (REFUSED.includes(err.reason)) {
          await sessionFailed(err, gen);
          return;
        }
        // One failed read is a hiccup; two in a row say the service is down.
        if (failuresInARow[name] >= 2 || err.reason === 'rate_limited') {
          await sessionFailed(err, gen);
        }
        wait = Math.min(every() * 2 ** failuresInARow[name], delays.maxBackoffMs);
        if (err.retryAt) {
          wait = Math.max(wait, err.retryAt - now());
        }
      }
      if (gen === generation && !stopped) {
        timers[name] = setTimeout(run, wait);
        timers[name].unref?.();
      }
    };
    timers[name] = setTimeout(run, 0);
    timers[name].unref?.();
  }

  /** @description Stop every timer. */
  function stopLoops() {
    for (const key of Object.keys(timers)) {
      clearTimeout(timers[key]);
      timers[key] = null;
    }
  }

  /**
   * @description Open (or reuse) the session, then start the loops.
   * @param {boolean} [retryRefused] - Try a refused password again.
   * @returns {Promise<void>}
   */
  async function connect(retryRefused = false) {
    generation += 1;
    const gen = generation;
    stopLoops();
    const problem = configProblem(config);
    if (problem) {
      api.reset();
      self = null;
      profile = null;
      connection = 'not_configured';
      messagesState = 'unknown';
      await reportStatus(
        false,
        all(
          { missing: 'statusMissing', identifier: 'statusIdentifier', service: 'statusService' }[
            problem
          ],
        ),
      );
      requestRefresh();
      return;
    }
    api.configure({
      identifier: config.identifier,
      appPassword: config.appPassword,
      service: config.service,
    });
    connection = 'connecting';
    try {
      self = await api.connect(retryRefused).then(() => api.session());
    } catch (err) {
      await sessionFailed(err, gen);
      if (!REFUSED.includes(err.reason) && gen === generation && !stopped) {
        const wait = Math.max(delays.retryMs, (err.retryAt ?? 0) - now());
        timers.connect = setTimeout(() => connect().catch(() => {}), wait);
        timers.connect.unref?.();
      }
      return;
    }
    refusal = null;
    store.useAccount(self.did);
    messagesState = config.receiveMessages ? 'unknown' : 'off';
    await reportConnected();
    loop('profile', () => delays.profileMs, readProfile, gen);
    if (config.watchNotifications) {
      loop(
        'notifications',
        () => Math.max(delays.notificationsMs, config.checkIntervalMs),
        readNotifications,
        gen,
      );
    } else {
      notifications = [];
      unread = null;
    }
    if (config.receiveMessages) {
      loop('chat', () => config.checkIntervalMs, readMessages, gen);
    }
    requestRefresh();
  }

  // --- profile ----------------------------------------------------------------------

  /**
   * @description Read the profile of the account (counters of the widget).
   * @returns {Promise<void>}
   */
  async function readProfile() {
    const next = await api.getProfile(self.did);
    const changed =
      JSON.stringify([next.followersCount, next.followsCount, next.postsCount, next.handle]) !==
      JSON.stringify([
        profile?.followersCount,
        profile?.followsCount,
        profile?.postsCount,
        profile?.handle,
      ]);
    profile = {
      handle: next.handle ?? self.handle,
      displayName: next.displayName ?? '',
      followersCount: next.followersCount,
      followsCount: next.followsCount,
      postsCount: next.postsCount,
    };
    if (changed) {
      requestRefresh(WIDGETS.ACCOUNT);
    }
  }

  // --- notifications ------------------------------------------------------------------

  /**
   * @description A notification as the widget shows it.
   * @param {object} item - A listNotifications item.
   * @returns {object} The card data.
   */
  function card(item) {
    const handle = item.author?.handle ?? '';
    const url =
      item.reason === 'follow'
        ? profileUrl(handle || item.author?.did)
        : ['mention', 'reply', 'quote'].includes(item.reason)
          ? postUrl(item.uri, handle)
          : postUrl(item.reasonSubject ?? '', self?.handle);
    return {
      reason: item.reason,
      name: item.author?.displayName || `@${handle}`,
      handle,
      text: typeof item.record?.text === 'string' ? item.record.text : '',
      at: Date.parse(item.indexedAt) || now(),
      url,
    };
  }

  /**
   * @description Read the notifications; the first read is the reference.
   * @returns {Promise<void>}
   */
  async function readNotifications() {
    const output = await api.listNotifications(30);
    const list = Array.isArray(output?.notifications) ? output.notifications : [];
    const reference = !store.hasReference();
    const fresh = [];
    for (const item of list) {
      if (typeof item?.uri !== 'string' || typeof item?.reason !== 'string') continue;
      if (store.remember(`${item.uri}|${item.reason}`) && !reference) {
        fresh.push(item);
      }
    }
    if (reference) {
      store.setReference();
      logger.info(`Bluesky notifications: reference taken (${list.length} already there)`);
    }
    // Oldest first, as they happened.
    for (const item of fresh.reverse()) {
      const trigger = REASON_TRIGGERS[item.reason];
      const at = Date.parse(item.indexedAt);
      if (!trigger) continue;
      if (Number.isFinite(at) && now() - at > MAX_AGE_MS) {
        logger.info(`Bluesky ${item.reason} notification read too late: no scene event`);
        continue;
      }
      if (item.author?.did === self.did) continue; // the account itself
      await fire(trigger, notificationEvent(item, self));
    }
    const before = JSON.stringify([notifications.map((n) => n.at), unread]);
    notifications = list
      .filter((item) => typeof item?.reason === 'string')
      .slice(0, MAX_NOTIFICATIONS)
      .map(card);
    try {
      unread = await api.getUnreadCount();
    } catch (err) {
      if (err.reason !== 'rate_limited') logger.debug(`getUnreadCount: ${err.message}`);
    }
    await store.save();
    if (before !== JSON.stringify([notifications.map((n) => n.at), unread])) {
      requestRefresh(WIDGETS.NOTIFICATIONS, WIDGETS.ACCOUNT);
    }
  }

  // --- direct messages: incoming -------------------------------------------------------

  /**
   * @description What the integration knows of a conversation (direct or a
   * group, a request or accepted), read once.
   * @param {string} convoId - The conversation.
   * @returns {Promise<{ direct: boolean, request: boolean }>} The kind.
   */
  async function convoInfo(convoId) {
    if (convos.has(convoId)) {
      return convos.get(convoId);
    }
    const convo = await api.getConvo(convoId);
    const kind = convo?.kind?.$type ?? '';
    const info = {
      direct: kind ? kind.endsWith('#directConvo') : (convo?.members?.length ?? 0) <= 2,
      request: convo?.status === 'request',
    };
    convos.set(convoId, info);
    for (const member of convo?.members ?? []) {
      if (info.direct && member?.did && member.did !== self?.did) {
        convoOf.set(member.did, convoId);
      }
    }
    return info;
  }

  /**
   * @description Send a text in a conversation (parts of 1,000 graphemes,
   * with facets); a conversation request is accepted first.
   * @param {string} convoId - The conversation.
   * @param {string} text - The text.
   * @returns {Promise<object|null>} The first messageView.
   */
  async function sendText(convoId, text) {
    const info = convos.get(convoId);
    if (info?.request) {
      await api.acceptConvo(convoId);
      info.request = false;
    }
    let first = null;
    for (const part of splitMessage(text)) {
      const facets = await detectFacets(part, (handle) => api.resolveHandle(handle));
      const sent = await api.sendMessage(convoId, {
        text: part,
        ...(facets.length > 0 ? { facets } : {}),
      });
      store.count('sent');
      first = first ?? sent;
    }
    return first;
  }

  /**
   * @description Answer in a conversation, best effort.
   * @param {string} convoId - The conversation.
   * @param {string} text - The text.
   * @returns {Promise<boolean>} Whether it was sent.
   */
  async function reply(convoId, text) {
    try {
      await sendText(convoId, text);
      return true;
    } catch (err) {
      logger.warn(`Unable to answer on Bluesky: ${err.code ?? err.message}`);
      return false;
    }
  }

  /**
   * @description Try a link code: link the sender to the Gladys user who
   * generated it.
   * @param {string} code - The code.
   * @param {object} sender - `{ did, handle }`.
   * @returns {Promise<{ status: 'linked'|'refused'|'error', user?: object }>} The result.
   */
  async function tryLink(code, sender) {
    try {
      const user = await gladys.linkContact(
        code,
        sender.did,
        sender.handle ? `@${sender.handle}` : undefined,
      );
      contactsCache = { at: 0, list: [] };
      logger.info(
        `Bluesky account ${sender.did} linked to the Gladys user ${user?.selector ?? '?'}`,
      );
      return { status: 'linked', user };
    } catch (err) {
      if (err?.status === 404) {
        logger.info(`Link code refused for the Bluesky account ${sender.did}`);
        return { status: 'refused' };
      }
      logger.warn(`Unable to link the Bluesky account ${sender.did}: ${err.message}`);
      return { status: 'error' };
    }
  }

  /**
   * @description Remember a message for the widget (memory only).
   * @param {object} entry - `{ name, handle, text, at, linked }`.
   */
  function rememberMessage(entry) {
    messages.unshift(entry);
    messages.length = Math.min(messages.length, MAX_CARDS);
    requestRefresh(WIDGETS.MESSAGES, WIDGETS.ACCOUNT);
  }

  /**
   * @description One message received in a conversation.
   * @param {object} log - A chat.bsky.convo.defs#logCreateMessage.
   * @returns {Promise<void>}
   */
  async function incoming(log) {
    const message = log.message;
    const did = message?.sender?.did;
    if (!did || did === self.did || typeof message.text !== 'string') {
      return; // a deleted message, or one the account sent itself
    }
    const info = await convoInfo(log.convoId);
    if (!info.direct) {
      logger.debug('Bluesky group conversation: ignored');
      return;
    }
    convoOf.set(did, log.convoId);
    const related = (log.relatedProfiles ?? []).find((p) => p?.did === did) ?? {};
    const sender = { did, handle: related.handle ?? '', name: related.displayName ?? '' };
    const sentAt = Date.parse(message.sentAt);
    const late = Number.isFinite(sentAt) && now() - sentAt > MAX_AGE_MS;
    const text = message.text.trim();
    const code = linkCodeOf(text);
    const contact = await contactOf(did);
    if (code && !late) {
      const result = await tryLink(code, sender);
      if (result.status === 'linked') {
        await reply(
          log.convoId,
          t('replyLinked', languageOf(result.user), { name: result.user?.first_name ?? '' }),
        );
        await api.updateRead(log.convoId, message.id).catch(() => {});
        return;
      }
      if (result.status === 'error') {
        await reply(log.convoId, t('replyUnavailable', languageOf(contact?.user)));
        return;
      }
      if (!contact) {
        await reply(log.convoId, t('replyCodeRefused', replyLanguage()));
        return;
      }
      // A linked user wrote something that looks like a code: a message.
    }
    store.count('received');
    rememberMessage({
      name: contact?.user?.first_name || sender.name || `@${sender.handle || did}`,
      handle: sender.handle,
      text,
      at: Number.isFinite(sentAt) ? sentAt : now(),
      linked: Boolean(contact),
    });
    if (late) {
      logger.info(`Bluesky message read ${Math.round((now() - sentAt) / 60000)} min late: ignored`);
      return;
    }
    const data = { ...sender, text, convoId: log.convoId, id: message.id };
    if (!contact) {
      logger.info(`Direct message from ${did}, an account not linked to Gladys`);
      await fire(TRIGGERS.DM_UNLINKED, messageEvent(data));
      return;
    }
    await api
      .updateRead(log.convoId, message.id)
      .catch((err) => logger.debug(`updateRead: ${err.message}`));
    if (config.forwardMessages && text) {
      try {
        await gladys.publishMessage(did, text, {
          createdAt: new Date(Number.isFinite(sentAt) ? sentAt : now()),
        });
      } catch (err) {
        if (err?.status === 404) {
          contactsCache = { at: 0, list: [] };
          await fire(TRIGGERS.DM_UNLINKED, messageEvent(data));
          return;
        }
        logger.warn(`Gladys refused the message of ${did}: ${err.message}`);
        await reply(log.convoId, t('replyUnavailable', languageOf(contact.user)));
      }
    }
    await fire(TRIGGERS.DM, messageEvent({ ...data, user: contact.user }));
  }

  /**
   * @description Read the events of the conversations since the cursor; the
   * first read only takes the cursor (the reference).
   * @returns {Promise<boolean|void>} false when the direct messages are out of reach.
   */
  async function readMessages() {
    let cursor = store.chatCursor();
    try {
      if (!cursor) {
        const output = await api.getLog();
        store.setChatCursor(output?.cursor ?? null);
        await store.save();
        logger.info('Bluesky direct messages: reference taken');
      } else {
        for (let page = 0; page < 5; page += 1) {
          const output = await api.getLog(cursor);
          const logs = Array.isArray(output?.logs) ? output.logs : [];
          let latest = cursor;
          for (const log of logs) {
            if (typeof log?.rev !== 'string' || log.rev <= latest) continue;
            latest = log.rev;
            if (log.$type === 'chat.bsky.convo.defs#logCreateMessage') {
              reading = incoming(log);
              await reading.catch((err) => logger.error('Unable to handle a Bluesky message', err));
            }
          }
          const next =
            typeof output?.cursor === 'string' && output.cursor > latest ? output.cursor : latest;
          store.setChatCursor(next);
          await store.save();
          if (logs.length === 0 || next === cursor) break;
          cursor = next;
        }
      }
    } catch (err) {
      if (err.reason === 'dm_scope') {
        logger.warn('The app password does not allow direct messages: they are not read');
        messagesState = 'no_access';
        await reportConnected();
        requestRefresh(WIDGETS.ACCOUNT, WIDGETS.MESSAGES);
        return false;
      }
      throw err;
    }
    if (messagesState !== 'on') {
      messagesState = 'on';
      requestRefresh(WIDGETS.ACCOUNT, WIDGETS.MESSAGES);
    }
    return true;
  }

  // --- direct messages: outgoing -------------------------------------------------------

  /**
   * @description The direct conversation with an account.
   * @param {string} did - The DID.
   * @returns {Promise<string>} The convoId.
   */
  async function directConvo(did) {
    if (convoOf.has(did)) {
      return convoOf.get(did);
    }
    const convo = await api.getConvoForMembers([did]);
    convos.set(convo.id, { direct: true, request: convo.status === 'request' });
    convoOf.set(did, convo.id);
    return convo.id;
  }

  /**
   * @description A message of Gladys could not be delivered.
   * @param {string} did - The user.
   * @param {Error} err - The failure.
   * @returns {Promise<void>}
   */
  async function deliveryFailed(did, err) {
    store.count('failed');
    if (err.reason === 'dm_scope') {
      messagesState = 'no_access';
    }
    logger.warn(`Message to the Bluesky account ${did} not delivered: ${err.code ?? err.message}`);
    const contact = await contactOf(did);
    await failures.failed({
      target: did,
      handle: String(contact?.contact_name ?? '').replace(/^@/, ''),
      user: contact?.user ?? null,
      reason: failureReason(err),
      error: err.code ?? err.message,
    });
    await store.save();
    requestRefresh(WIDGETS.ACCOUNT, WIDGETS.MESSAGES);
  }

  gladys.onSendMessage(async (contact, message) => {
    const did = String(contact?.id ?? '');
    if (!DID.test(did)) {
      throw new Error('The contact is not a Bluesky DID');
    }
    if (!self) {
      throw new Error('The Bluesky integration is not connected');
    }
    let text = String(message?.text ?? '').trim();
    if (message?.file) {
      // chat.bsky.convo.defs#messageInput carries no image.
      logger.info('Bluesky direct messages cannot carry an image: only the text is sent');
      if (!text) {
        text = t('imageNotSupported', languageOf((await contactOf(did))?.user));
      }
    }
    if (!text) {
      throw new Error('Empty message');
    }
    const delivery = (async () => {
      await sendText(await directConvo(did), text);
      failures.delivered(did);
      await store.save();
      requestRefresh(WIDGETS.MESSAGES);
    })();
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve('late'), SEND_DEADLINE_MS);
      timer.unref?.();
    });
    const outcome = await Promise.race([delivery.then(() => 'done'), late]).catch(async (err) => {
      clearTimeout(timer);
      if (convoOf.get(did) && err.reason === 'recipient') convoOf.delete(did);
      await deliveryFailed(did, err);
      throw err;
    });
    clearTimeout(timer);
    if (outcome === 'late') {
      logger.info(`Message to ${did} still being sent after ${SEND_DEADLINE_MS / 1000} s`);
      const tracked = delivery
        .catch((err) => deliveryFailed(did, err))
        .finally(() => background.delete(tracked));
      background.add(tracked);
    }
  });

  // --- scene actions ----------------------------------------------------------------------

  /**
   * @description The anti-flood of the scene actions: the outputs of the same
   * action done less than a minute ago.
   * @param {string} key - What identifies the action.
   * @returns {object|null} The previous outputs.
   */
  function duplicateOf(key) {
    for (const [entry, value] of recentActions) {
      if (now() - value.at > DUPLICATE_WINDOW_MS) recentActions.delete(entry);
    }
    return recentActions.get(key)?.outputs ?? null;
  }

  /**
   * @description The DID of an account typed by a user.
   * @param {string} value - Handle, DID or profile link.
   * @returns {Promise<string>} The DID.
   */
  async function didOf(value) {
    const actor = readActor(value);
    if (!actor) {
      throw new Error('Not a Bluesky handle (name.bsky.social) nor a DID');
    }
    if (actor.startsWith('did:')) {
      return actor;
    }
    try {
      return await api.resolveHandle(actor);
    } catch (err) {
      if (err.reason === 'not_found' || err.reason === 'invalid') {
        throw new Error(`Unknown Bluesky handle: ${actor}`, { cause: err });
      }
      throw err;
    }
  }

  const requireSession = () => {
    if (configProblem(config) || !self) {
      throw new Error('The Bluesky integration is not connected');
    }
  };

  gladys.onSceneAction(SCENE_ACTIONS.PUBLISH_POST, async (fields) => {
    requireSession();
    const raw = String(fields?.text ?? '').trim();
    const replyTo = String(fields?.reply_to ?? '').trim();
    const imageUrl = String(fields?.image_url ?? '').trim();
    if (!raw && !imageUrl) {
      throw new Error('Empty post');
    }
    const key = JSON.stringify(['post', raw, replyTo, imageUrl]);
    const previous = duplicateOf(key);
    if (previous) {
      logger.info('The same post was published less than a minute ago: not published again');
      return previous;
    }
    while (postTimes.length > 0 && now() - postTimes[0] > 3600_000) postTimes.shift();
    if (postTimes.length >= MAX_POSTS_PER_HOUR) {
      throw new Error(
        `${MAX_POSTS_PER_HOUR} posts in the last hour: a scene is looping? Not published`,
      );
    }
    const lang = String(fields?.language ?? '').trim() || replyLanguage();
    if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/.test(lang)) {
      throw new Error('Invalid language: a code such as fr, en or pt-BR');
    }
    const { text, truncated } = truncate(raw, MAX_POST_GRAPHEMES, MAX_POST_BYTES);
    if (truncated) {
      logger.info(`Post longer than ${MAX_POST_GRAPHEMES} graphemes: shortened`);
    }
    const record = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date(now()).toISOString(),
      langs: [lang],
    };
    const facets = await detectFacets(text, (handle) => api.resolveHandle(handle));
    if (facets.length > 0) {
      record.facets = facets;
    }
    if (replyTo) {
      const ref = readPostRef(replyTo);
      if (!ref) {
        throw new Error(
          'reply_to: the link (https://bsky.app/profile/…/post/…) or the at:// URI of a post',
        );
      }
      const repo = ref.repo.startsWith('did:') ? ref.repo : await didOf(ref.repo);
      const uri = `at://${repo}/app.bsky.feed.post/${ref.rkey}`;
      const [parent] = await api.getPosts([uri]);
      if (!parent?.cid) {
        throw new Error('reply_to: post not found (deleted?)');
      }
      const root = parent.record?.reply?.root ?? { uri: parent.uri, cid: parent.cid };
      record.reply = {
        root: { uri: root.uri, cid: root.cid },
        parent: { uri: parent.uri, cid: parent.cid },
      };
    }
    if (imageUrl) {
      const image = readImage(await fetchImage(imageUrl, { fetchImpl }));
      const blob = await api.uploadBlob(image.bytes, image.mime);
      record.embed = {
        $type: 'app.bsky.embed.images',
        images: [
          {
            image: blob,
            alt: String(fields?.image_alt ?? '')
              .trim()
              .slice(0, 2000),
            ...(image.width && image.height
              ? { aspectRatio: { width: image.width, height: image.height } }
              : {}),
          },
        ],
      };
    }
    const created = await api.createRecord('app.bsky.feed.post', record);
    postTimes.push(now());
    store.count('posts');
    await store.save();
    const outputs = {
      uri: created.uri,
      url: postUrl(created.uri, self.handle),
      cid: created.cid ?? '',
    };
    recentActions.set(key, { at: now(), outputs });
    // The post counter of the profile changed.
    setTimeout(() => readProfile().catch(() => {}), 2000).unref?.();
    return outputs;
  });

  gladys.onSceneAction(SCENE_ACTIONS.SEND_DM, async (fields) => {
    requireSession();
    const text = String(fields?.text ?? '').trim();
    if (!text) {
      throw new Error('Empty message');
    }
    const did = await didOf(fields?.recipient);
    if (did === self.did) {
      throw new Error('The account cannot write to itself');
    }
    const key = JSON.stringify(['dm', did, text]);
    const previous = duplicateOf(key);
    if (previous) {
      logger.info('The same direct message was sent less than a minute ago: not sent again');
      return previous;
    }
    let sent;
    try {
      sent = await sendText(await directConvo(did), text);
    } catch (err) {
      if (err.reason === 'recipient') convoOf.delete(did);
      if (err.reason === 'dm_scope') {
        throw new Error('The app password does not allow direct messages', { cause: err });
      }
      if (err.reason === 'recipient') {
        throw new Error(
          `This account does not accept direct messages from the house account (${err.code})`,
          {
            cause: err,
          },
        );
      }
      throw err;
    }
    await store.save();
    requestRefresh(WIDGETS.MESSAGES);
    const outputs = { convo_id: convoOf.get(did) ?? '', message_id: sent?.id ?? '' };
    recentActions.set(key, { at: now(), outputs });
    return outputs;
  });

  gladys.onSceneAction(SCENE_ACTIONS.DELETE_POST, async (fields) => {
    requireSession();
    const ref = readPostRef(fields?.post);
    if (!ref) {
      throw new Error(
        'post: the link (https://bsky.app/profile/…/post/…) or the at:// URI of a post',
      );
    }
    if (ref.repo !== self.did && ref.repo !== self.handle && ref.repo !== profile?.handle) {
      throw new Error('Only a post of the account of the integration can be deleted');
    }
    await api.deleteRecord('app.bsky.feed.post', ref.rkey);
    setTimeout(() => readProfile().catch(() => {}), 2000).unref?.();
    return undefined;
  });

  // --- widgets ----------------------------------------------------------------------------

  const widgetLanguage = (lang) => (LANGUAGES.includes(lang) ? lang : 'en');

  gladys.onWidgetGet(WIDGETS.ACCOUNT, async ({ language: lang } = {}) => {
    rememberLanguage(lang);
    return buildAccountWidget({
      connection: configProblem(config) ? 'not_configured' : connection,
      profile: profile ?? (self ? { handle: self.handle } : null),
      unread,
      counters: store.counters(),
      messages: config.receiveMessages ? messagesState : 'off',
      notifications: config.watchNotifications,
      linked: configProblem(config) ? 0 : (await linkedContacts()).length,
      language: widgetLanguage(lang),
    });
  });

  gladys.onWidgetGet(WIDGETS.NOTIFICATIONS, async ({ settings, language: lang } = {}) => {
    rememberLanguage(lang);
    return buildNotificationsWidget({
      items: notifications,
      includeLikes: !(settings?.include_likes === false || settings?.include_likes === 'false'),
      watching: config.watchNotifications && !configProblem(config),
      language: widgetLanguage(lang),
    });
  });

  gladys.onWidgetGet(WIDGETS.MESSAGES, async ({ settings, language: lang } = {}) => {
    rememberLanguage(lang);
    return buildMessagesWidget({
      items: messages,
      counters: store.counters(),
      messages: config.receiveMessages ? messagesState : 'off',
      showText: settings?.show_text === true || settings?.show_text === 'true',
      language: widgetLanguage(lang),
    });
  });

  /**
   * @description Check everything now: the session (a refused password is
   * tried again), the profile, the direct messages.
   * @returns {Promise<object>} `{ ok, message }` (multi-language).
   */
  async function check() {
    const problem = configProblem(config);
    if (problem) {
      return {
        ok: false,
        message: all(
          { missing: 'statusMissing', identifier: 'statusIdentifier', service: 'statusService' }[
            problem
          ],
        ),
      };
    }
    if (connection !== 'connected') {
      await connect(true);
      if (!self || connection === 'refused') {
        return { ok: false, message: statusOf(refusal ?? lastError ?? { reason: connection }) };
      }
    }
    try {
      await readProfile();
    } catch (err) {
      return { ok: false, message: statusOf(err) };
    }
    let dm = 'dmOff';
    if (config.receiveMessages || messagesState === 'no_access') {
      try {
        await api.getLog(); // the latest cursor only: nothing is consumed
        dm = 'dmOk';
        if (messagesState === 'no_access') {
          messagesState = 'unknown';
          connect().catch(() => {});
        }
      } catch (err) {
        dm = err.reason === 'dm_scope' ? 'dmNoAccess' : 'dmUnknown';
      }
    }
    const linked = (await linkedContacts(true)).length;
    logger.info(`Bluesky test: integration ${version}, connection ${connection}`);
    requestRefresh();
    return {
      ok: true,
      message: all('testOk', (l) => ({
        handle: profile?.handle ?? self.handle,
        followers: profile?.followersCount ?? '?',
        dm: t(dm, l),
        linked,
      })),
    };
  }

  gladys.onWidgetAction(WIDGETS.ACCOUNT, async (actionKey) => {
    if (actionKey !== WIDGET_ACTIONS.CHECK) {
      return undefined;
    }
    return bounded((await check()).message);
  });

  // --- Configuration screen ----------------------------------------------------------

  gladys.onAction(CONFIG_ACTIONS.TEST_CONNECTION, async () => bounded((await check()).message));

  // --- lifecycle ---------------------------------------------------------------------------

  /**
   * @description Read the configuration.
   * @param {object} [raw] - The raw config (else fetched).
   * @returns {Promise<void>}
   */
  async function loadConfig(raw) {
    let values = raw;
    if (!values) {
      try {
        values = await gladys.getConfig();
      } catch (err) {
        logger.warn(`Unable to read the configuration: ${err.message}`);
        values = gladys.config ?? {};
      }
    }
    config = normalizeConfig(values ?? {});
    language = readLanguage(values, language);
  }

  gladys.onConfigUpdated(async (raw) => {
    await loadConfig(raw);
    contactsCache = { at: 0, list: [] };
    convos.clear();
    convoOf.clear();
    lastStatus = null;
    logger.info('Configuration updated: reconnecting to Bluesky');
    await connect(true);
  });

  return {
    /**
     * @description Read the state and the configuration, connect to Bluesky.
     * @returns {Promise<void>}
     */
    async start() {
      stopped = false;
      await store.load();
      await loadConfig();
      await connect();
    },
    /**
     * @description Stop the loops and write the state.
     * @returns {Promise<void>}
     */
    async stop() {
      stopped = true;
      generation += 1;
      stopLoops();
      await Promise.race([
        Promise.all([reading.catch(() => {}), ...background]),
        new Promise((resolve) => setTimeout(resolve, 3000).unref()),
      ]);
      await store.save();
    },
    store,
    api,
    idle: () => Promise.all([reading.catch(() => {}), ...background]),
    readMessages: () => readMessages(),
    readNotifications: () => readNotifications(),
    getConfig: () => config,
    connection: () => connection,
    messagesState: () => messagesState,
    self: () => self,
  };
}

export {
  createApp,
  CONFIG_ACTIONS,
  MAX_AGE_MS,
  SEND_DEADLINE_MS,
  MAX_POSTS_PER_HOUR,
  linkCodeOf,
  failureReason,
};
