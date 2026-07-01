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


- Can we remove the save button? So that ideally it's saved when you change the value.

- Clicking on the notification of not reply yet doesn't really open the email, it should probably open the email.
- In the run check diagnostik I only see like a weird list. The list should be split between nudged already had a reply and suppressed. All of this should be clickable to the link to the email. And the reason for um like the reason should be a different column.

- We should also either add the instructions or automatically create a folder where all the tags are visible.

- Speaking of visual polish, uh we should also polish the diagnosis uh page.

- We should also remove the version from the preferences.