# tb-nudge

Thunderbird MailExtension that nudges you about sent emails that never got a reply — like
Gmail's "Nudge", but fully local: nothing leaves your machine, and the classifier that decides
whether a reply was expected is trained on your own mailbox.

Requires Thunderbird 128+.

## Install

**Quick try** (temporary, unloads on restart):

1. **Tools → Add-ons and Themes** → gear (⚙) → **Debug Add-ons**
2. **Load Temporary Add-on** → pick `manifest.json`

**Permanent:**

```
./package.sh        # -> dist/tb-nudge-<version>.xpi (runs the tests first)
```

Add-ons Manager → gear (⚙) → **Install Add-on From File** → pick the `.xpi`. Release Thunderbird
rejects unsigned add-ons unless you set `xpinstall.signatures.required=false` in the Config
Editor — or install it from the marketplace once listed, which signs it for you.

## What it does

Every hour it scans your Sent folders for messages older than ~30 hours (configurable) and newer
than 14 days, checks the Inbox for a reply (by `Message-ID`/`References`, falling back to
subject + sender), and if none is found fires one desktop notification and applies a **Needs
Reply** tag. Clicking the notification opens the message. Multiple unanswered messages in the
same thread are deduplicated to a single nudge.

A locally-trained classifier pre-filters nudges down to messages that actually look like they
needed a reply. Untrained, it nudges on everything unanswered.

For a persistent cross-account view of tagged messages, make a **Saved Search folder** once:
`Ctrl+Shift+F` → search All Folders → filter **Tags: Needs Reply** → **Save As Search Folder**.

## Train it on your mailbox (optional, improves accuracy)

Preferences → **Train the classifier**:

1. **Extract dataset** from your Sent folders. Labels are inferred (weak supervision), not
   hand-typed — spot-check a sample before trusting it.
2. **Train** — runs in the page (nothing sent anywhere), prints 5-fold cross-validation metrics,
   and becomes the active model immediately (the nudger and the inspector pick it up live).

Improve it by correcting mistakes: Preferences → **Diagnostics & labeling** → **Run check now**
or **Scan all for labeling**, then the ✓/✗ buttons on any wrong rows. Corrections are stored and
merged automatically into the next training run (or export/import `corrections.json`). Watch the
**recall on negatives** metric — it stays low until you've accumulated enough "didn't need a
reply" examples.

## More

- **Explainability** — each notification has a `Why:` line (the 3 words that most drove the
  decision); Preferences → **Inspect classifier word weights** shows the model's global view.
- **CLI training** — `node train.js dataset.json [corrections.json]` writes `model.json`.
- **`model.json` is gitignored on purpose** — it encodes vocabulary from your emails; it's a
  local artifact, regenerate any time, never ship it.
- **Release** — push a `vX.Y.Z` tag matching `manifest.json`; GitHub Actions builds the `.xpi`
  and publishes a Release (`.github/workflows/release.yml`). To list it, submit that `.xpi` at
  [addons.thunderbird.net](https://addons.thunderbird.net) → Developer Hub (volunteer review,
  then ATN signs it).
- **Tests** — `node test.js` (covers the pure logic in `lib.js`).

## License

[MIT](LICENSE)
