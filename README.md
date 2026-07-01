# tb-nudge

Thunderbird MailExtension that nudges you about sent emails that never got a reply — a
heuristic-only version of Gmail's "Nudge" (no ML, just header/subject matching).

## How it decides "no reply yet"

Every hour it scans each account's Sent folder for messages older than 30 hours
(configurable) and newer than 14 days. For each one it checks the matching Inbox for a
reply, first by `References`/`In-Reply-To` header match against the sent message's
`Message-ID`, falling back to normalized-subject + sender-address match if headers are
missing. If nothing matches, it fires one desktop notification and stops re-checking that
message. Clicking the notification opens the original sent message.

Before a match is scored, `needsReply()` runs it through a locally-trained classifier (see
below) that decides whether it actually looks like it needed a reply at all — if no model
has been trained yet, this step is a no-op and everything unanswered gets nudged, same as
before.

## Flagging + a cross-account "Needs Reply" view

Alongside the notification, tb-nudge flags the message (the star) and applies a "Needs
Reply" tag, creating that tag on first run if it doesn't exist yet. Once tagged, sort any
folder by the Flag column to bring them to the top, or — better, for a persistent
cross-account view — create a **Saved Search folder** once (Thunderbird native feature,
nothing to build): `Ctrl+Shift+F` → set folder to search to "All Folders"/your accounts →
filter by **Tags: Needs Reply** → **Save As Search Folder**. That folder then live-updates
with every message tb-nudge tags, across all four Gmail accounts, permanently in your
folder pane.

The tag is applied once, when first nudged — it isn't automatically cleared if a reply
comes in later (known simplification; remove the tag/flag by hand if it bothers you, or
ask to add auto-clearing later).

## Load it (temporary, for testing)

1. Thunderbird → **Tools → Add-ons and Themes**
2. Gear icon (⚙) → **Debug Add-ons**
3. **Load Temporary Add-on** → select this folder's `manifest.json`

Temporary add-ons unload when Thunderbird restarts — you'll need to reload it each
session. Once you're happy with it, the next step is getting it signed for permanent
install (AMO unlisted submission, or `xpinstall.signatures.required=false` in
`about:config` for a fully local permanent install).

## Settings

Add-ons Manager → tb-nudge → **Preferences**: adjust the hour threshold and lookback
window.

## Building an ML training dataset (no manual labeling)

Add-ons Manager → tb-nudge → **Preferences** → **Build ML training dataset**. This is a
weak-supervision extraction, not manual labels — labels are inferred from thread structure,
not typed in by hand:

- **Positive** (needed a reply): the first message in a thread, and it got a direct reply.
- **Negative** (didn't need a reply): a reply-to-a-reply that itself got back a short or
  clearly-closing acknowledgment (e.g. "thanks!", "sounds good").
- Everything else (no reply ever observed, or a reply that wasn't a closeout) is **skipped**
  — silence is never treated as "didn't need a reply," since that's indistinguishable from
  the exact case tb-nudge exists to catch.

Scans the last 730 days. Click **Run extraction**, then **Download dataset.json**.

**Before training on it: spot-check ~20-30 rows by hand.** This is inferred, not verified,
labeling — check it's not systematically wrong before trusting the whole set.

## Training the classifier

```
node train.js ~/Downloads/tb-nudge-dataset.json
```

Hand-rolled TF-IDF + logistic regression (no dependencies — the dataset is far too small to
justify one), class-weighted for the positive/negative imbalance. Writes `model.json` next
to this script and prints 5-fold cross-validation metrics first. `model.json` is
**gitignored on purpose** — it encodes real vocabulary from your emails (names, project
terms), which is more sensitive than the code that produces it. It's a local build artifact:
regenerate it any time by re-running this script, no need to version it.

Read the "recall on negatives" number specifically — that's how often it correctly
recognizes a message that *didn't* need a reply, and with only a couple dozen negative
examples it'll be the weak number for a while. It only gets better with a bigger negative
pool: re-run `dataset.html` periodically as more thread closeouts accumulate, then retrain.

After retraining, **reload the temporary add-on** — `background.js` loads `model.json` once
at startup, so it won't pick up a new model until reloaded.

## Tests

```
node test.js
```

Covers the pure matching/labeling logic in `lib.js` (the only non-trivial branching logic;
the rest is direct Thunderbird API calls that can only really be tested by loading it in
Thunderbird).
