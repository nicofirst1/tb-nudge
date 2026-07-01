# tb-nudge todo

- **Auto-clear the tag/flag when a reply eventually comes in.** Right now, once a message
  is tagged "Needs Reply" and flagged, it stays that way even if the recipient replies
  later - we mark the message `handled` on first nudge and never revisit it. Fix would be:
  keep tagged-but-unresolved message ids in storage even after `handled`, and on a later
  `runCheck()` pass, re-check `hasReply()` for just that subset and clear `flagged`/the tag
  if a reply has since arrived.
