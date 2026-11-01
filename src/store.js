// -----------------------------------------------------------------------------
// What the integration remembers across restarts, under /data (the only
// writable path of the container):
//
//   /data/state.json    ids, cursors and counters, never the text of a message:
//     notifications   the keys of the last notifications seen (uri + reason)
//                     and whether the first read (the reference) was done
//     chatCursor      the `rev` of the last event of chat.bsky.convo.getLog
//     account         the DID the state belongs to (another account starts
//                     a new reference)
//     day, received, sent, posts, failed   the counters of the current day
//
//   /data/session.json  the session of the account (DID, handle, PDS URL,
//                       access and refresh tokens), mode 0600: createSession
//                       is limited to 300 a day, so the session must survive
//                       a restart. Never the app password.
//
// The links between Bluesky accounts and Gladys users are kept by Gladys
// itself (linkContact / getContacts), never here. A missing or broken file
// starts empty. Writes go through a temporary file and a rename, one at a time.
// -----------------------------------------------------------------------------

import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEFAULT_DIR = '/data';
const MAX_SEEN = 300;
const COUNTERS = ['received', 'sent', 'posts', 'failed'];

/**
 * @description The day of an instant, 'YYYY-MM-DD' (UTC).
 * @param {number} instant - The instant, in ms.
 * @returns {string} The day.
 */
const dayOf = (instant) => new Date(instant).toISOString().slice(0, 10);

/**
 * @description A fresh state.
 * @param {number} now - Now, in ms.
 * @returns {object} The state.
 */
function emptyState(now) {
  return {
    version: 1,
    account: null,
    day: dayOf(now),
    received: 0,
    sent: 0,
    posts: 0,
    failed: 0,
    notifications: { reference: false, seen: [] },
    chatCursor: null,
  };
}

/**
 * @description Keep the known fields of a state read from disk.
 * @param {object} data - The parsed file.
 * @param {number} now - Now, in ms.
 * @returns {object} The state.
 */
function sanitize(data, now) {
  const state = emptyState(now);
  if (typeof data?.account === 'string' && data.account.startsWith('did:')) {
    state.account = data.account;
  }
  if (typeof data?.day === 'string') {
    state.day = data.day;
  }
  COUNTERS.forEach((key) => {
    if (Number.isInteger(data?.[key]) && data[key] >= 0) {
      state[key] = data[key];
    }
  });
  const notifications = data?.notifications;
  if (notifications && typeof notifications === 'object') {
    state.notifications.reference = notifications.reference === true;
    if (Array.isArray(notifications.seen)) {
      state.notifications.seen = notifications.seen
        .filter((key) => typeof key === 'string' && key.length <= 400)
        .slice(-MAX_SEEN);
    }
  }
  if (typeof data?.chatCursor === 'string' && data.chatCursor.length <= 200) {
    state.chatCursor = data.chatCursor;
  }
  return state;
}

/**
 * @description Write a JSON file through a temporary file.
 * @param {string} path - The file.
 * @param {object} value - The content.
 * @returns {Promise<void>}
 */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

/**
 * @description Create the store.
 * @param {object} options - Options.
 * @param {string} [options.dir] - The folder (/data).
 * @param {Function} [options.now] - `() => number` in ms.
 * @param {object} options.logger - Logger.
 * @returns {object} The store, with `session` (load / save / clear) for the API client.
 * @example
 * const store = createStore({ logger });
 * await store.load();
 */
function createStore({ dir = DEFAULT_DIR, now = () => Date.now(), logger }) {
  const statePath = join(dir, 'state.json');
  const sessionPath = join(dir, 'session.json');
  let state = emptyState(now());
  let seen = new Set();
  let dirty = false;
  let saving = Promise.resolve();
  let sessionWrites = Promise.resolve();

  /** @description A new day starts the counters again. */
  function rollDay() {
    const day = dayOf(now());
    if (state.day !== day) {
      state.day = day;
      COUNTERS.forEach((key) => {
        state[key] = 0;
      });
      dirty = true;
    }
  }

  return {
    /**
     * @description Read the file (a broken one starts empty).
     * @returns {Promise<void>}
     */
    async load() {
      try {
        state = sanitize(JSON.parse(await readFile(statePath, 'utf8')), now());
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.warn(`Unreadable ${statePath}, starting empty: ${err.message}`);
        }
        state = emptyState(now());
      }
      seen = new Set(state.notifications.seen);
      rollDay();
    },

    /**
     * @description Write the state when it changed (queued, never throws).
     * @returns {Promise<void>} Resolves once written (or failed).
     */
    save() {
      if (!dirty) {
        return saving;
      }
      dirty = false;
      const body = {
        ...state,
        notifications: { ...state.notifications, seen: [...seen].slice(-MAX_SEEN) },
      };
      saving = saving.then(() =>
        writeJson(statePath, body).catch((err) =>
          logger.warn(`Unable to write ${statePath}: ${err.message}`),
        ),
      );
      return saving;
    },

    /**
     * @description The state belongs to this account; another one (a new
     * configuration) starts new references.
     * @param {string} did - The DID of the session.
     */
    useAccount(did) {
      if (state.account === did) {
        return;
      }
      state = { ...emptyState(now()), account: did };
      seen = new Set();
      dirty = true;
    },

    // --- notifications ----------------------------------------------------------
    hasReference: () => state.notifications.reference,
    /** @description The first read is done: later notifications are new. */
    setReference() {
      if (!state.notifications.reference) {
        state.notifications.reference = true;
        dirty = true;
      }
    },
    /**
     * @description Remember a notification; false when it was already seen.
     * @param {string} key - uri + reason.
     * @returns {boolean} Whether it is new.
     */
    remember(key) {
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      if (seen.size > MAX_SEEN) {
        seen.delete(seen.values().next().value);
      }
      dirty = true;
      return true;
    },

    // --- direct messages ----------------------------------------------------------
    chatCursor: () => state.chatCursor,
    /** @param {string|null} cursor - The rev of the last event handled. */
    setChatCursor(cursor) {
      if (cursor && cursor !== state.chatCursor) {
        state.chatCursor = cursor;
        dirty = true;
      }
    },

    // --- counters -------------------------------------------------------------------
    /**
     * @description Count a received, sent or failed message, or a post.
     * @param {'received'|'sent'|'posts'|'failed'} key - The counter.
     */
    count(key) {
      rollDay();
      state[key] += 1;
      dirty = true;
    },
    /**
     * @description The counters of the day.
     * @returns {{ received: number, sent: number, posts: number, failed: number }} The counters.
     */
    counters() {
      rollDay();
      return {
        received: state.received,
        sent: state.sent,
        posts: state.posts,
        failed: state.failed,
      };
    },

    // --- the session file (used by src/bluesky-api.js) ---------------------------
    session: {
      /** @returns {Promise<object|null>} The stored session. */
      async load() {
        try {
          const data = JSON.parse(await readFile(sessionPath, 'utf8'));
          const ok = ['did', 'accessJwt', 'refreshJwt', 'pdsUrl', 'fingerprint'].every(
            (key) => typeof data?.[key] === 'string',
          );
          return ok ? data : null;
        } catch {
          return null;
        }
      },
      /**
       * @param {object} session - The session to keep.
       * @returns {Promise<void>}
       */
      save(session) {
        const body = {
          did: session.did,
          handle: session.handle,
          accessJwt: session.accessJwt,
          refreshJwt: session.refreshJwt,
          pdsUrl: session.pdsUrl,
          fingerprint: session.fingerprint,
        };
        sessionWrites = sessionWrites.then(() => writeJson(sessionPath, body));
        return sessionWrites;
      },
      /** @returns {Promise<void>} */
      clear() {
        sessionWrites = sessionWrites.then(() => rm(sessionPath, { force: true }));
        return sessionWrites;
      },
    },
  };
}

export { createStore, DEFAULT_DIR, MAX_SEEN };
