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

It does **not** classify whether a reply was actually expected (that's the part Gmail's ML
does) — it will nudge about anything unanswered, including FYIs and "thanks!" closers. If
that turns out to be too noisy in practice, that's the next thing to add.

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

## Tests

```
node test.js
```

Covers the pure matching logic in `lib.js` (the only non-trivial branching logic; the rest
is direct Thunderbird API calls that can only really be tested by loading it in Thunderbird).
