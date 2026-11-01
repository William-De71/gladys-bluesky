// -----------------------------------------------------------------------------
// Scene triggers and scene actions of the Bluesky integration: their keys
// (eternal, like external ids: scenes store them) and the flat data of each
// event (scalars only, strings of 1,000 characters at most).
//
// Triggers (one event per new notification or message, never for what was
// already there at the first read, never because of a scene action):
//   mention_received        someone mentioned the account in a post
//   reply_received          someone replied to a post of the account
//   quote_received          someone quoted a post of the account
//   new_follower            someone followed the account
//   like_received           someone liked a post of the account
//   repost_received         someone reposted a post of the account
//   dm_received             a LINKED user sent a direct message
//   dm_received_unlinked    an account not linked to Gladys sent one
//   message_not_sent        a message of Gladys to a user was not delivered
//                           (once, then again only after one went through)
//
// Actions: publish_post, send_dm, delete_post.
// -----------------------------------------------------------------------------

import { postUrl, profileUrl, parseAtUri, shorten } from './richtext.js';

const TRIGGERS = {
  MENTION: 'mention_received',
  REPLY: 'reply_received',
  QUOTE: 'quote_received',
  FOLLOW: 'new_follower',
  LIKE: 'like_received',
  REPOST: 'repost_received',
  DM: 'dm_received',
  DM_UNLINKED: 'dm_received_unlinked',
  MESSAGE_NOT_SENT: 'message_not_sent',
};

// listNotifications `reason` -> trigger. The other reasons (starterpack-joined,
// verified, like-via-repost, subscribed-post…) only show in the widget.
const REASON_TRIGGERS = {
  mention: TRIGGERS.MENTION,
  reply: TRIGGERS.REPLY,
  quote: TRIGGERS.QUOTE,
  follow: TRIGGERS.FOLLOW,
  like: TRIGGERS.LIKE,
  repost: TRIGGERS.REPOST,
};

const SCENE_ACTIONS = {
  PUBLISH_POST: 'publish_post',
  SEND_DM: 'send_dm',
  DELETE_POST: 'delete_post',
};

const FAILURE_REASONS = ['auth', 'dm_scope', 'recipient', 'rate_limited', 'network', 'other'];

const MAX_EVENT_STRING = 1000;

/**
 * @description A string for event data.
 * @param {any} value - The value.
 * @returns {string} At most 1,000 characters.
 */
const str = (value) => shorten(value ?? '', MAX_EVENT_STRING);

/**
 * @description The post a notification is about (ours): reasonSubject, or
 * what the record points at.
 * @param {object} notification - A listNotifications item.
 * @returns {string} The AT URI, '' when none.
 */
function subjectOf(notification) {
  if (typeof notification.reasonSubject === 'string') {
    return notification.reasonSubject;
  }
  const record = notification.record ?? {};
  return (
    record.subject?.uri ??
    record.reply?.parent?.uri ??
    record.embed?.record?.uri ??
    record.embed?.record?.record?.uri ??
    ''
  );
}

/**
 * @description The flat data of a notification event.
 * @param {object} notification - A listNotifications item.
 * @param {{ did: string, handle: string }} self - The account.
 * @returns {object} The event data.
 */
function notificationEvent(notification, self) {
  const author = notification.author ?? {};
  const handle = author.handle ?? '';
  const data = {
    author_handle: handle,
    author_name: str(author.displayName || handle),
    author_did: author.did ?? '',
  };
  if (notification.reason === 'follow') {
    return { ...data, profile_url: profileUrl(handle || author.did) };
  }
  const subject = subjectOf(notification);
  const subjectRepo = parseAtUri(subject)?.repo;
  const subjectData = {
    subject_uri: subject,
    subject_url: postUrl(subject, subjectRepo === self?.did ? self.handle : undefined),
  };
  if (notification.reason === 'like' || notification.reason === 'repost') {
    return { ...data, ...subjectData };
  }
  // mention, reply, quote: the record is the post that mentions, replies or quotes.
  return {
    ...data,
    text: str(notification.record?.text),
    post_uri: notification.uri ?? '',
    post_url: postUrl(notification.uri, handle),
    ...(notification.reason === 'mention' ? {} : subjectData),
  };
}

/**
 * @description The flat data of a direct message event.
 * @param {object} message - `{ text, did, handle, name, convoId, id, user }`.
 * @returns {object} The event data.
 */
function messageEvent(message) {
  const data = {
    text: str(message.text),
    sender_handle: message.handle ?? '',
    sender_name: str(message.name || message.handle),
    sender_did: message.did,
    convo_id: message.convoId,
    message_id: message.id,
  };
  if (message.user === undefined) {
    return data;
  }
  return {
    ...data,
    gladys_user: message.user?.selector ?? '',
    first_name: str(message.user?.first_name),
  };
}

/**
 * @description Data of `message_not_sent`.
 * @param {object} failure - `{ target, handle, user, reason, error }`.
 * @returns {object} Flat event data.
 */
const notSentEvent = ({ target, handle, user, reason, error }) => ({
  target,
  handle: handle ?? '',
  gladys_user: user?.selector ?? '',
  first_name: str(user?.first_name),
  reason: FAILURE_REASONS.includes(reason) ? reason : 'other',
  error: str(error),
});

/**
 * @description Fire `message_not_sent` once per target until a message to it
 * goes through again: a scene warning on Bluesky about Bluesky cannot loop.
 * @param {object} gladys - The Gladys client.
 * @param {object} logger - Logger.
 * @returns {{ failed: Function, delivered: Function }} The tracker.
 */
function createFailureEvents(gladys, logger) {
  const failing = new Set();
  return {
    /**
     * @param {object} failure - `{ target, handle, user, reason, error }`.
     * @returns {Promise<boolean>} Whether an event was published.
     */
    async failed(failure) {
      if (failing.has(failure.target)) {
        return false;
      }
      failing.add(failure.target);
      try {
        await gladys.publishSceneEvent(TRIGGERS.MESSAGE_NOT_SENT, notSentEvent(failure));
        return true;
      } catch (err) {
        logger.warn(`Unable to publish the message_not_sent event: ${err.message}`);
        return false;
      }
    },
    /** @param {string} target - A message to this target went through. */
    delivered(target) {
      failing.delete(target);
    },
  };
}

export {
  TRIGGERS,
  REASON_TRIGGERS,
  SCENE_ACTIONS,
  FAILURE_REASONS,
  MAX_EVENT_STRING,
  subjectOf,
  notificationEvent,
  messageEvent,
  notSentEvent,
  createFailureEvents,
};
