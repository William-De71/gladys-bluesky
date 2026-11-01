# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). This file is generated at
each release from the Conventional Commits: do not edit it by hand.

## [0.1.0] - unreleased

### Added

- **bluesky:** one Bluesky account (ideally an account of the house) through the official XRPC API of the AT Protocol, opened with an app password: one session kept in `/data` and renewed with refreshSession (createSession is limited to 300 a day), the real PDS read from the DID document, self-hosted PDS supported, pauses on 429 and `ratelimit-*` headers, clear messages for a refused password, an e-mail code (main password) or an app password without direct messages
- **chat:** a Bluesky user links their account by sending the link code of Gladys in a direct message; their direct messages then go to Gladys, who answers in the same conversation (parts of 1,000 graphemes, clickable links and mentions); messages of accounts that are not linked never reach Gladys and get no answer; the messages of the account itself, group conversations and messages read more than 15 minutes late are ignored; direct messages are read every 10 to 60 seconds, the first read being the reference
- **scenes:** triggers on new mentions, replies, quotes, followers, likes and reposts (notifications read every 30 seconds, never marked as seen), on direct messages of linked users and of other accounts, and when a message of Gladys could not be delivered (once until a message goes through again); actions to publish a post (facets in UTF-8 bytes, language, reply in a thread, optional image with its alt text, shortened to 300 graphemes, same post once a minute and 30 posts an hour at most), send a direct message to any account and delete a post of the account
- **widgets:** the account (followers, follows, posts, unread notifications, activity of the day, connection and a "Check" button), the last notifications, and the last direct messages with their text only on demand
- **i18n:** English, French, German and Spanish for the manifest, the runtime texts, the documentation and the README
