// -----------------------------------------------------------------------------
// The dashboard widgets of the Bluesky integration (pure: the contents are
// built from plain data, so that docs/illustrations draws them with this
// code).
//
//   account         the profile of the account: followers, follows, posts and
//                   unread notifications (tiles), what was sent and received
//                   today, the connection, direct messages and notifications
//                   status, a "Check" button. 1 caption, 4 tiles, 1 body,
//                   1 status, 1 button (8 of 8).
//   notifications   the last notifications (mentions, replies, quotes,
//                   followers, likes, reposts) as cards linking to bsky.app;
//                   the `include_likes` setting hides likes and reposts.
//   messages        the last direct messages received; their text only with
//                   the `show_text` setting (a dashboard can be shared), kept
//                   in memory only. 2 tiles, 1 card-list.
// -----------------------------------------------------------------------------

import { t } from './i18n.js';
import { shorten } from './richtext.js';

const WIDGETS = { ACCOUNT: 'account', NOTIFICATIONS: 'notifications', MESSAGES: 'messages' };
const WIDGET_ACTIONS = { CHECK: 'check' };
const MAX_CARDS = 8;

const CONNECTION = {
  connected: { key: 'widgetConnected', color: 'success' },
  connecting: { key: 'widgetConnecting', color: 'warning' },
  unreachable: { key: 'widgetUnreachable', color: 'warning' },
  rate_limited: { key: 'widgetRateLimited', color: 'warning' },
  refused: { key: 'widgetRefused', color: 'danger' },
  not_configured: { key: 'widgetNotConfigured', color: 'neutral' },
};

const MESSAGES_STATE = {
  on: { key: 'widgetDmOn', color: 'success' },
  off: { key: 'widgetDmOff', color: 'neutral' },
  no_access: { key: 'widgetDmNoAccess', color: 'danger' },
  unknown: { key: 'widgetDmUnknown', color: 'neutral' },
};

const REASON_BADGES = {
  mention: { key: 'badgeMention', color: 'primary', text: true },
  reply: { key: 'badgeReply', color: 'info', text: true },
  quote: { key: 'badgeQuote', color: 'info', text: true },
  follow: { key: 'badgeFollow', color: 'success', what: 'whatFollow' },
  like: { key: 'badgeLike', color: 'danger', what: 'whatLike' },
  repost: { key: 'badgeRepost', color: 'success', what: 'whatRepost' },
};

/**
 * @description A tile number: '—' when unknown (no profile yet).
 * @param {number|null|undefined} value - The value.
 * @returns {number|string} The value.
 */
const tile = (value) => (Number.isFinite(value) ? value : '—');

/**
 * @description The content of the account widget.
 * @param {object} data - The data.
 * @param {string} data.connection - A key of CONNECTION.
 * @param {object|null} data.profile - getProfile (handle, displayName, followersCount…).
 * @param {number|null} data.unread - Unread notifications.
 * @param {{ received: number, sent: number, posts: number }} data.counters - Today.
 * @param {string} data.messages - A key of MESSAGES_STATE.
 * @param {boolean} data.notifications - Notifications watched.
 * @param {number} data.linked - Linked Gladys users.
 * @param {string} data.language - en, fr, de or es.
 * @returns {object} The widget content.
 */
function buildAccountWidget({
  connection,
  profile,
  unread,
  counters,
  messages,
  notifications,
  linked,
  language,
}) {
  const state = CONNECTION[connection] ?? CONNECTION.not_configured;
  const dm = MESSAGES_STATE[messages] ?? MESSAGES_STATE.unknown;
  const name = profile?.displayName?.trim();
  const components = [
    {
      type: 'text',
      variant: 'caption',
      text: profile
        ? shorten(name ? `${name} · @${profile.handle}` : `@${profile.handle}`, 80)
        : t('widgetNoProfile', language),
    },
    {
      type: 'value',
      value: tile(profile?.followersCount),
      label: t('widgetFollowers', language),
      icon: 'users',
      color: 'primary',
    },
    {
      type: 'value',
      value: tile(profile?.followsCount),
      label: t('widgetFollows', language),
      icon: 'user-plus',
      color: 'info',
    },
    {
      type: 'value',
      value: tile(profile?.postsCount),
      label: t('widgetPosts', language),
      icon: 'edit-3',
      color: 'neutral',
    },
    {
      type: 'value',
      value: notifications ? tile(unread) : '—',
      label: t('widgetUnread', language),
      icon: 'bell',
      color: unread > 0 ? 'warning' : 'neutral',
    },
    {
      type: 'text',
      variant: 'body',
      text: t('widgetToday', language, {
        received: counters.received,
        sent: counters.sent,
        posts: counters.posts,
      }),
    },
    {
      type: 'status',
      items: [
        {
          label: t('widgetConnection', language),
          value: t(state.key, language),
          color: state.color,
        },
        { label: t('widgetMessages', language), value: t(dm.key, language), color: dm.color },
        {
          label: t('widgetNotifications', language),
          value: t(notifications ? 'widgetWatched' : 'widgetOff', language),
          color: notifications ? 'success' : 'neutral',
        },
        { label: t('widgetLinked', language), value: String(linked) },
      ],
    },
  ];
  if (connection !== 'not_configured') {
    components.push({
      type: 'button',
      label: t('widgetCheck', language),
      icon: 'refresh-cw',
      style: 'secondary',
      action: { key: WIDGET_ACTIONS.CHECK, params: {} },
    });
  }
  return { ttl_seconds: 300, components };
}

/**
 * @description The content of the notifications widget.
 * @param {object} data - The data.
 * @param {object[]} data.items - `{ reason, name, handle, text, at, url }`, newest first.
 * @param {boolean} data.includeLikes - Show likes and reposts.
 * @param {boolean} data.watching - Notifications are read.
 * @param {string} data.language - en, fr, de or es.
 * @returns {object} The widget content.
 */
function buildNotificationsWidget({ items, includeLikes, watching, language }) {
  if (!watching) {
    return {
      ttl_seconds: 300,
      components: [{ type: 'text', variant: 'body', text: t('widgetNotificationsOff', language) }],
    };
  }
  const cards = items
    .filter((item) => REASON_BADGES[item.reason])
    .filter((item) => includeLikes || !['like', 'repost'].includes(item.reason))
    .slice(0, MAX_CARDS)
    .map((item) => {
      const badge = REASON_BADGES[item.reason];
      const name = item.name || `@${item.handle}`;
      // The list only shows the title: the text (or what happened) goes in it,
      // the whole text in the description (shown on click).
      const what =
        badge.text && item.text ? `: ${item.text}` : ` ${t(badge.what ?? 'whatPost', language)}`;
      const card = {
        title: shorten(`${name}${what}`, 60),
        date: new Date(item.at).toISOString(),
        badge: { text: t(badge.key, language), color: badge.color },
        description:
          badge.text && item.text
            ? shorten(item.text, 2000)
            : t(badge.what ?? 'whatPost', language),
      };
      if (item.url) {
        card.links = [{ url: item.url, label: 'Bluesky' }];
      }
      return card;
    });
  if (cards.length === 0) {
    return {
      ttl_seconds: 60,
      components: [{ type: 'text', variant: 'body', text: t('widgetNoNotification', language) }],
    };
  }
  return { ttl_seconds: 60, components: [{ type: 'card-list', display: 'list', items: cards }] };
}

/**
 * @description The content of the messages widget.
 * @param {object} data - The data.
 * @param {object[]} data.items - `{ name, handle, text, at, linked }`, newest first.
 * @param {{ received: number, sent: number }} data.counters - Today.
 * @param {string} data.messages - A key of MESSAGES_STATE.
 * @param {boolean} data.showText - The widget setting.
 * @param {string} data.language - en, fr, de or es.
 * @returns {object} The widget content.
 */
function buildMessagesWidget({ items, counters, messages, showText, language }) {
  const components = [
    {
      type: 'value',
      value: counters.received,
      label: t('widgetReceivedToday', language),
      icon: 'inbox',
      color: 'primary',
    },
    {
      type: 'value',
      value: counters.sent,
      label: t('widgetSentToday', language),
      icon: 'send',
      color: 'info',
    },
  ];
  if (messages === 'off' || messages === 'no_access') {
    components.push({
      type: 'text',
      variant: 'body',
      text: t(messages === 'no_access' ? 'widgetMessagesNoAccess' : 'widgetMessagesOff', language),
    });
    return { ttl_seconds: 60, components };
  }
  const cards = items.slice(0, MAX_CARDS).map((item) => ({
    title: shorten(
      showText && item.text
        ? `${item.name || `@${item.handle}`}: ${item.text}`
        : item.name || `@${item.handle}`,
      60,
    ),
    date: new Date(item.at).toISOString(),
    badge: item.linked
      ? { text: t('badgeLinked', language), color: 'success' }
      : { text: t('badgeNotLinked', language), color: 'neutral' },
    description: showText ? shorten(item.text || '…', 2000) : t('widgetHiddenText', language),
  }));
  components.push(
    cards.length > 0
      ? { type: 'card-list', display: 'list', items: cards }
      : { type: 'text', variant: 'body', text: t('widgetNoMessage', language) },
  );
  return { ttl_seconds: 60, components };
}

export {
  WIDGETS,
  WIDGET_ACTIONS,
  MAX_CARDS,
  CONNECTION,
  MESSAGES_STATE,
  REASON_BADGES,
  buildAccountWidget,
  buildNotificationsWidget,
  buildMessagesWidget,
};
