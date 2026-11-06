# Roadmap

TeamPilot v0.1 covers the core loop: standups, timesheets, leave, a weekly report, and a
supervisor checking all of it. Next up, roughly in order:

## Integrations

- [ ] **Issue trackers** — Jira first, then Linear and GitHub Issues: ticket status in
      standup summaries, releases and milestones in the weekly report
- [ ] **Spreadsheet sinks** — write the leave ledger and timesheet status to Google Sheets
      or an Excel workbook (CSV export exists today)
- [ ] **Form confirmations** — count a Microsoft Forms / Google Forms submission as a
      timesheet confirmation
- [ ] **Slack intake** — read standup replies and leave posts from Slack (posting already works)

## Modules

- [ ] **Multiple timesheet tracks** per workspace (per manager or client, each with its own chat)
- [ ] **"Hours are final" gate** — hold timesheet chases until an external source of truth is published
- [ ] **Standup memory** — carry open items across days and surface stale ones in a pre-meeting briefing
- [ ] **Filtered leave digests** — e.g. a daily list of who's out on client-facing projects

## Platform

- [ ] **Teams app (Bot Framework)** — one-click install, "Done" buttons instead of typed
      replies, no per-channel webhook setup
- [ ] **Admin web UI** — edit a workspace with the same validation `doctor` runs
- [ ] **Published Docker image** and signed release tarballs
- [ ] **Hosted edition** — multi-tenant, encrypted per-tenant token storage, retention controls

Ideas and requests are welcome via GitHub issues.
