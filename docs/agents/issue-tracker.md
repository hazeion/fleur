# Fleur issue tracker

Fleur planning lives in GitHub Issues for hazeion/fleur. Use the gh CLI with the repository explicitly selected when the current checkout is elsewhere.

## Wayfinding operations

- Map: one issue labelled wayfinder:map with Destination, Notes, Decisions so far, Not yet specified, and Out of scope.
- Tickets: native sub-issues with one of wayfinder:research, wayfinder:prototype, wayfinder:grilling, or wayfinder:task.
- Blocking: native GitHub issue dependencies using the blocker's numeric database ID.
- Frontier: open, unblocked, unassigned children in map order.
- Claim: assign a ticket to the driving developer before work.
- Resolve: post a resolution comment, close the ticket, and add a linked one-line gist to the map.
- Only if native relationships are unavailable, use explicit named links in ticket bodies for parent and blocker relationships.

Use titles when referring to issues. Keep secrets, credentials, and machine-local details out of GitHub.
