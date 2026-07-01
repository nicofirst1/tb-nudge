# tb-nudge

Thunderbird MailExtension that nudges you about sent emails that never got a reply, the same
idea as Gmail's "Nudge" but running locally: no data leaves your machine, and the classifier
that judges whether a reply was expected is trained on your own mailbox.

Requires Thunderbird 128+. Personal project, not (yet) published on
[addons.thunderbird.net](https://addons.thunderbird.net/); see "Load it" below for local
install.

## How it decides "no reply yet"

Every hour it scans each account's Sent folder for messages older than 30 hours
(configurable) and newer than 14 days. For each one it checks the matching Inbox for a
reply, first by `References`/`In-Reply-To` header match against the sent message's
`Message-ID`, falling back to normalized-subject + sender-address match if headers are
missing. If nothing matches, it fires one desktop notification and stops re-checking that
message. Clicking the notification opens the original sent message.

Before a match is scored, `needsReply()` runs it through a locally-trained classifier (see
below) that decides whether it looks like it needed a reply at all. If no model has been
trained yet, this step is a no-op, and everything unanswered gets nudged, same as before.

## Flagging + a cross-account "Needs Reply" view

Alongside the notification, tb-nudge flags the message (the star) and applies a "Needs
Reply" tag, creating that tag on first run if it doesn't exist yet. Once tagged, sort any
folder by the Flag column to bring them to the top, or, for a persistent cross-account view,
create a **Saved Search folder** once (Thunderbird native feature, nothing to build):
`Ctrl+Shift+F` → set folder to search to "All Folders"/your accounts → filter by
**Tags: Needs Reply** → **Save As Search Folder**. That folder then live-updates with every
message tb-nudge tags, across all your accounts, permanently in your folder pane.

The tag is applied once, when first nudged: it isn't automatically cleared if a reply comes
in later (known simplification; remove the tag/flag by hand if it bothers you, or ask to add
auto-clearing later).

## Load it (temporary, for testing)

1. Thunderbird → **Tools → Add-ons and Themes**
2. Gear icon (⚙) → **Debug Add-ons**
3. **Load Temporary Add-on** → select this folder's `manifest.json`

Temporary add-ons unload when Thunderbird restarts, so you'll need to reload it each
session. Once you're happy with it, the next step is getting it signed for permanent
install (AMO, addons.mozilla.org, unlisted submission; or `xpinstall.signatures.required=false` in
`about:config` for a fully local permanent install).

## Settings

Add-ons Manager → tb-nudge → **Preferences**: adjust the hour threshold and lookback
window.

## Building a machine-learning (ML) training dataset (no manual labeling)

Add-ons Manager → tb-nudge → **Preferences** → **Build ML training dataset**. This is a
weak-supervision extraction, not manual labels: labels are inferred from thread structure,
not typed in by hand:

- **Positive** (needed a reply): the first message in a thread, and it got a direct reply.
- **Negative** (didn't need a reply): a reply-to-a-reply that itself got back a short or
  clearly-closing acknowledgment (e.g. "thanks!", "sounds good").
- Everything else (no reply ever observed, or a reply that wasn't a closeout) is **skipped**:
  silence is never treated as "didn't need a reply", since that's indistinguishable from
  the exact case tb-nudge exists to catch.

Lookback window is adjustable (default 730 days; `-1` mines the entire mailbox, which can be
slow). If a dataset was already generated before, running extraction again asks for
confirmation first rather than silently redoing the scan. Click **Run extraction**, then
**Download dataset.json** — this prompts a native Save dialog (not a fixed Downloads-folder
drop), so you can save it wherever you like, e.g. straight into this repo folder.

**Before training on it: spot-check ~20-30 rows by hand.** This is inferred, not verified,
labeling: check it's not systematically wrong before trusting the whole set.

## Training the classifier

Two ways to train, same underlying code (`trainModel()` in `lib.js`) either way:

- **In the browser**: after extraction finishes on the dataset page, a **Train classifier**
  section appears — trains on the rows just extracted (nothing leaves the page), prints
  5-fold cross-validation metrics, then **Download model.json** (again a real Save dialog).
- **From the command line**:
  ```
  node train.js ~/Downloads/tb-nudge-dataset.json
  ```
  Useful if you want to train on an older exported dataset, or script it.

Hand-rolled TF-IDF (term frequency, inverse document frequency) + logistic regression, no
dependencies since the dataset is far too small to justify one, class-weighted for the
positive/negative imbalance. `model.json` is **gitignored on purpose**: it encodes real
vocabulary from your emails (names, project terms), which is more sensitive than the code
that produces it. It's a local build artifact: regenerate it any time, no need to version it.
Save it into this folder (overwriting the existing `model.json`) for `background.js` to use it.

Read the "recall on negatives" number specifically: that's how often it correctly recognizes
a message that *didn't* need a reply, and with only a couple dozen negative examples it'll be
the weak number for a while. It only gets better with a bigger negative pool: re-run
`dataset.html` periodically as more thread closeouts accumulate, then retrain.

After retraining, **reload the temporary add-on**: `background.js` loads `model.json` once
at startup, so it won't pick up a new model until reloaded.

## Explainability

Every nudge notification includes a `Why:` line: the 3 words from that specific message
that contributed most to the classifier's decision (highest `tfidf value x learned weight`).
That's the per-message explanation.

For the model's *global* view (every word it's ever seen, ranked by learned weight),
open Add-ons Manager → tb-nudge → Preferences → **Inspect classifier word weights**. Two
columns: words that push toward "needs a reply" and words that push toward "no reply
needed", with their raw weight. Useful for sanity-checking the model isn't keying off
something spurious: with this little training data (a few dozen examples), it sometimes
picks up coincidental correlations (e.g. a name that happened to appear disproportionately
in one class) rather than a real linguistic pattern. Worth an eyeball before trusting it.

## Testing without waiting for the hourly alarm

Preferences → **Run check / diagnostics →** opens a page with **Run check now** (runs the
same check the hourly alarm does, immediately) and **Reset "already checked" state** (forces
a re-scan of everything in the current window). Each run shows a per-message trace: subject,
outcome (nudged / already replied / suppressed), and the words behind that decision. Handy
after changing the model or the matching logic, without waiting for the alarm.

## Tests

```
node test.js
```

Covers the pure matching/labeling logic in `lib.js` (the only non-trivial branching logic;
the rest is direct Thunderbird API calls that can only really be tested by loading it in
Thunderbird).

## License

[MIT](LICENSE)
