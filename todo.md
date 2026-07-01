# tb-nudge todo

- **Auto-clear the tag/flag when a reply eventually comes in.** Right now, once a message
  is tagged "Needs Reply" and flagged, it stays that way even if the recipient replies
  later - we mark the message `handled` on first nudge and never revisit it. Fix would be:
  keep tagged-but-unresolved message ids in storage even after `handled`, and on a later
  `runCheck()` pass, re-check `hasReply()` for just that subset and clear `flagged`/the tag
  if a reply has since arrived.

- **Visual polish pass on preferences/details before considering ATN submission.** Compared
  to a published extension like Provider for Google Calendar, our options/preferences UI is
  plain (no icon, minimal layout, bare-bones styling). Not worth doing while still validating
  correctness/model quality - revisit once the functionality itself is solid and actually
  being considered for the marketplace.
