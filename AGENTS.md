# AGENTS.md

Instructions for any agent (or human) extending tb-nudge. Read this before making changes.

## What this is

A Thunderbird MailExtension (Manifest V2) that nudges the user about sent emails that never
got a reply, filtered through a locally-trained TF-IDF + logistic regression classifier.
Everything runs on-device; nothing is sent anywhere external. See `README.md` for the
user-facing feature description - this file is about how to work on the code itself.

## Conventions

- **Bump `manifest.json`'s `version` with every change**, then commit. One version per
  logical change, not one per session. Check the current value before bumping - don't assume
  the last commit you see in history is the last bump (verify by reading the file).
- **No new dependencies.** Everything here is plain JS by design - the dataset is too small
  to justify a ML library, and the extension logic is simple enough not to need a framework.
  Keep it that way unless the scale of the problem genuinely changes.
- **Run before every commit:**
  ```
  node test.js
  node --check <every .js file you touched>
  node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
  ```
- **Non-trivial branching logic goes in `lib.js`**, kept free of `browser.*` calls so it's
  testable with plain `node test.js`. Browser-API-dependent helpers shared across multiple
  pages/scripts go in `mailapi.js` instead (not unit-testable, but avoids duplicating the
  same `browser.messages`/`browser.folders` calls in three places).
- **Never commit real email content or anything derived from it.** `model.json` and any
  `*dataset*.json` files are gitignored on purpose - they encode real vocabulary/text from
  the user's mailbox. If you add a new artifact that's derived from a real mailbox scan,
  gitignore it too, don't ask, just do it and mention it.

## Known gotchas (hard-won, don't rediscover these)

- **Reloading the temporary add-on only refreshes the background script.** Any already-open
  extension page (`diagnostics.html`, `dataset.html`, `model-inspect.html`, `options.html`)
  keeps running whatever JS was loaded when it was first opened. Close and reopen the tab,
  don't just reload the add-on, when testing changes to a page's own `.js` file.
- **`messageDisplay.open({location: "window"})` throws `NS_MSG_ERROR_FOLDER_MISSING`** for
  at least some Gmail accounts, even with a correctly-resolved, valid message id - confirmed
  as a bug isolated to that API's standalone-window code path (`messageWindow.js`), not a
  bug in our id resolution (proven by `mailTabs.setSelectedMessages()` working fine with the
  exact same id). Use `openMessageInTab()` in `mailapi.js` (which passes an explicit
  `windowId` and uses `location: "tab"`) instead of calling `messageDisplay.open()` directly.
- **Never store or reuse a raw `message.id` across time.** It can go stale (IMAP
  resync/reindex reassigns them) and throw `NS_MSG_ERROR_FOLDER_MISSING` when later used.
  Store `message.headerMessageId` (the real RFC Message-ID, stable) instead, and re-resolve
  the current id via `resolveCurrentMessageId(headerMessageId, sentFolders)` right before
  acting on it.
- **Scope that re-resolution to the Sent folder(s) specifically.** Gmail exposes the same
  physical message under multiple IMAP folders (Sent, All Mail, labels) - an unscoped
  `messages.query({headerMessageId})` can match the "All Mail" copy, and Thunderbird's
  tree-view handles that aggregated/virtual folder differently (selecting a message there
  can silently fail). We only ever deal with sent messages here, so always pass
  `sentFolders` (from `browser.folders.query({specialUse: ["sent"]})`).
- **The nudge-check runtime window (hours/days in Settings) and the dataset-extraction
  window (730 days, hardcoded in `dataset.js`) are unrelated.** Don't conflate "why isn't
  X showing up in diagnostics" with "why isn't X in the training dataset" - check which
  window is actually relevant.

## Weak-supervision dataset (`dataset.html`/`dataset.js`)

No manual labeling. Labels are inferred from thread structure:
- **Positive** (needed a reply): first message in a thread, got a direct reply.
- **Negative** (didn't need a reply): a reply-to-a-reply that itself got a short/closing
  acknowledgment back, AND the reply-to-a-reply's own text doesn't look like a question/
  request itself (see `looksLikeRequest` in `lib.js` - without this check, a short REAL
  ANSWER to a question gets mislabeled the same as a "thanks!" closer).
- Everything else (no reply ever observed, or an ambiguous reply) is **skipped**. Silence is
  never treated as a negative label - that's indistinguishable from the exact case tb-nudge
  exists to catch. Don't "fix" this by treating unanswered messages as negatives; that
  reintroduces the exact bias the current design deliberately avoids.

If you build a "correction" feature (marking a suppressed/nudged decision as wrong), feed
corrections back into training as additional labeled rows, not by hand-editing the model.

## Testing without live Thunderbird for most logic

Most non-trivial logic is pure and covered by `node test.js` (see `lib.js`). Anything that
calls `browser.*` can only really be verified by loading the extension in Thunderbird itself
(⚙ → Debug Add-ons → Load Temporary Add-on → this folder's `manifest.json`) and using
`diagnostics.html`'s "Run check now" / "Reset" buttons to exercise it without waiting for the
hourly alarm.
