# Changelog

All notable changes to tb-nudge are documented here. Versions match `manifest.json`.

## [0.5.8]
- Add `package.sh` to build a versioned, distributable `.xpi` (tests first, `manifest.json` at root, dev files and personal `model.json` excluded).
- Add a GitHub Actions release workflow: pushing a `vX.Y.Z` tag matching the manifest version builds the `.xpi` and publishes it as a GitHub Release.
- Change the extension id from `...@nbrandizzi.local` to `tb-nudge@nicolobrandizzi.com` so it's marketplace-valid.
- README: correct install/signing notes for Thunderbird (ATN, not AMO) and document packaging + release.

## [0.5.7]
- Add Download/Upload corrections to the training page's Human corrections section. Upload validates each row and merges with dedup (re-importing the same file is a no-op), so corrections are portable across machines/profiles.
- Persist the extracted dataset, so returning to the training page shows the Train step directly without re-extracting.
- Rename the preference links and page headings: "Build ML training dataset" → "Train the classifier", "Run check / diagnostics" → "Diagnostics & labeling".

## [0.5.6]
- Rename the dataset page to "train the classifier" and reframe it as three numbered steps (extract → corrections → train), since it now trains and merges human corrections, not just builds a dataset.
- Add a "Human corrections" section showing how many corrections are stored (with the needed/didn't-need split) and that they're merged automatically at training time, plus a "Clear corrections" button.

## [0.5.5]
- Update the dataset page's Positive/Negative description to match the redesigned labeling logic (self-bump / request / own-closeout; thread position no longer used).
- Make the diagnostics result sections (Nudged / Already replied / Suppressed) collapsible; "Already replied" starts folded since it's the largest, least-actionable group.

## [0.5.4]
- Add a "Scan all for labeling" pass in diagnostics: a read-only whole-mailbox sweep that shows what the model would decide **without** firing notifications or tagging anything, with a live progress log (streamed over a runtime port). Correct the wrong rows with the ✓/✗ buttons, then retrain — the human labels are merged in. Uses a single inbox-index pass instead of per-message reply lookup so it scales to the full mailbox.

## [0.5.3]
- Flag corrections for wrong **nudges** too: a "✗ Didn't need reply" button on nudged rows untags the message and saves a negative (label 0) training correction, mirroring the existing "✓ Needed reply" on suppressed rows.
- Deduplicate nudges by thread: when several unanswered sent messages share a conversation, only the most recent one nudges (older siblings, and any thread that already got a reply, are skipped). The run summary reports how many were deduplicated.
- Nudging now only applies the "Needs Reply" tag — it no longer marks messages as important/flagged.
- In-page training merges human corrections, so the ✓/✗ buttons shape the active model (previously corrections only reached the CLI trainer).

## [0.5.2]
- In-page training now logs live per-fold progress (tokenizing → fold 1/5 … → fitting final model), yielding a frame between steps so the page no longer looks frozen during the CPU-bound fit.
- After training, the Save-As dialog for `model.json` opens automatically (in addition to saving the model as active), so it's one step to grab the file for committing to the repo.

## [0.5.1]
- In-page training now sets the **active** model: the trained model is saved to storage, and both the nudger and the word-weights inspector prefer it over the bundled `model.json` — no more save-to-disk + reload-extension dance to make a retrain take effect.
- The nudger picks up a retrained model live (via a storage-change listener) instead of only at extension restart.
- The inspector shows which model it's displaying (trained in-app vs. bundled). Save-As download stays for committing `model.json` to the repo.

## [0.5.0]
- Redesign the dataset labeling heuristic (fixes the 212/33 class imbalance and noisy word weights). Thread position is no longer consulted; labels come from a priority cascade: self-bump-before-reply → positive, request-that-got-a-reply → positive, bare-closeout-reply → negative, otherwise skip.
- Add a self-bump signal: a sent message the sender chased with their own later mail (immediate-parent match) counts as needed-a-reply, but only when the bump preceded any recipient reply.
- Add an own-closeout negative source: a sent message that is itself a bare acknowledgment ("thanks!", "sounds good") and asks nothing is labeled didn't-need-a-reply from its own content, with no reply required. This lifts the negative class off the floor (a reply-closeout-only rule yielded ~23 negatives / 0.00 negative-recall on a real 1267-message mailbox).
- Harden the closeout-negative rule: a short reply that itself asks a question no longer counts as a courtesy ack.
- Extraction now reports per-source label counts (self-bump / request / closeout / silence / ambiguous).

## [0.4.1]
- Correct wrongly-suppressed nudges: tag them and save the correction as training data.
- View the actual reply for rows marked as already-replied.

## [0.4.0]
- Configurable dataset lookback window.
- In-page training.
- Save-As downloads with overwrite confirmation.

## [0.3.6]
- Add `homepage_url` pointing to the GitHub repo.

## [0.3.5]
- Open messages via `messageDisplay.open` with `location: "tab"` (bug traced to the window-only code path).

## [0.3.4]
- Open a real new window and select the message via `mailTabs`, avoiding `messageDisplay.open`'s broken window path.

## [0.3.3]
- Switch back to `messageDisplay.open` (new window) now that Sent-folder scoping is in place.

## [0.3.2]
- Scope message re-lookup to Sent folders, avoiding Gmail's All Mail virtual folder.

## [0.3.1]
- Stop swallowing window-focus errors; log them instead.

## [0.3.0]
- Display messages via `mailTabs` selection instead of `messageDisplay.open`, working around `NS_MSG_ERROR_FOLDER_MISSING`.

## [0.2.9]
- Fix `NS_MSG_ERROR_FOLDER_MISSING`: resolve a fresh message id by Message-ID header before opening.

## [0.2.8]
- Force body fetch before opening a message (attempted fix for blank message body).

## [0.2.7]
- Open messages in a window instead of a tab (fixes click-to-open from diagnostics/notifications).

## [0.2.6]
- Auto-save settings.
- Fix notification-click race.
- Sectioned diagnostics table.

## [0.2.5]
- Developer/icon metadata, GitHub-ready README, MIT license.

## [0.2.4]
- Add author field to manifest.

## [0.2.3]
- Split diagnostics into its own page; keep Preferences settings-only.

## [0.2.2]
- Per-message decision trace in Run check (explains suppressions too).

## [0.2.1]
- Break down run-check results (replied/suppressed/nudged) for testing visibility.

## [0.2.0]
- Explainability: per-message and global word weights.
- Manual test triggers.

## [0.1.0]
- Heuristic-only reply-nudge MailExtension.
- Weak-supervision dataset extraction for the reply-needed classifier.
- TF-IDF + logistic regression classifier, wired in as a nudge pre-filter.
- Flag and tag nudged messages; document native Saved Search folder setup.
