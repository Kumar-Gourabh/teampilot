# Configuration reference

A workspace is a folder in **~/.teampilot/workspaces/&lt;name&gt;/** (or under
$TEAMPILOT_HOME). It contains:

| File | Holds | Commit to version control? |
|---|---|---|
| workspace.yaml | what runs, when, where | yes (no secrets in it) |
| people.yaml | the people directory | yes, if your policy allows |
| holidays.yaml | non-working days | yes |
| .env | webhook URLs, AI keys | **never** |
| secrets/ | Microsoft sign-in token cache | **never** |
| state/ | posts log, standup replies, leave ledger, timesheet confirmations | no (back it up) |
| logs/ | monthly log files | no |

The template that **teampilot init** writes is fully commented. This page is the reference.

## Schedules

Every schedule is a standard 5-field cron line (minute hour day-of-month month day-of-week),
read in the **workspace timezone**. Some examples:

- "30 17 * * 1-5": 17:30 on weekdays
- "*/15 10-16 * * 4,5": every 15 minutes from 10:00 to 16:45, Thursday and Friday

Jobs skip the days listed in holidays.yaml, and days missing from workspace.workdays.

## workspace

| Key | Default | Meaning |
|---|---|---|
| name | folder name | display name |
| timezone | UTC | IANA timezone |
| workdays | Mon–Fri | days jobs run |
| signoff | "TeamPilot" | card footer ("" for none) |
| uptime | none | {from, to} if the host is only up part of the day. Jobs outside it are flagged. |
| catchUpMinutes | 180 | after a late start or restart, run slots missed within this many minutes (once) |

## identity.graph

| Key | Meaning |
|---|---|
| tenant | tenant id, or "common" |
| clientId | your Entra app's client id (default: Microsoft's Graph CLI public app) |
| account | the username to use if the token cache holds several |
| fallback.account | optional read-only second identity |
| enabled | false to switch off every Graph read (posting still works) |

## llm

| Key | Meaning |
|---|---|
| provider | anthropic, openai-compatible or none |
| model | default claude-opus-5-5 for anthropic |
| apiKey | the **name** of the .env secret |
| effort | anthropic only: low / medium / high |
| baseUrl | openai-compatible only |
| fallbacks | a list of further providers, tried in order |
| serverFallback | anthropic only: set false to turn off Anthropic's server-side refusal fallback |

## venues

Each venue is a named place cards go to:

```yaml
venues:
  standup-channel:
    kind: teams-workflow   # teams-workflow | teams-connector | slack | console
    webhook: WEBHOOK_STANDUP
    teamId: ...            # + channelId, for a channel TeamPilot must read
    channelId: ...
  timesheet-chat:
    webhook: WEBHOOK_TIMESHEET
    chatId: ...            # for a chat TeamPilot must read
```

**kind: console** prints instead of posting, which is useful while you try things out.
**slack** posts to a Slack incoming webhook. Reading Slack isn't supported yet, so a Slack
venue can't be used for intake.

## modules.standup

```yaml
standup:
  teams:
    - key: platform              # used in job ids and state paths
      name: Platform             # used in card titles
      venue: standup-channel
      summaryVenue: ...          # optional, defaults to venue
      intake: thread             # thread: replies under today's check-in card
                                 # venue:  any message in intakeVenue that day (e.g. a group chat)
      intakeVenue: ...           # optional, defaults to venue
      members: [ids]             # or omit → everyone with teams: [platform]
      leads: [ids]               # their messages don't count as standups
      cc: [ids]                  # tagged on the summary
      tagMissing: true           # tag people with no update in the summary
      escalate: { to: [ids], afterDays: 3 }
      questions: [...]           # the check-in prompt lines
      context: "..."             # one line of background for the AI
      schedule: { checkin: cron, nudge: cron, summary: cron }   # each optional
```

Job ids: **standup:&lt;key&gt;:checkin**, **…:nudge**, **…:summary**.

## modules.timesheet

| Key | Meaning |
|---|---|
| venue | where the reminder goes and confirmations are read (must be readable) |
| finalVenue | where the final pending list goes |
| periodEnds | weekday the period ends (default friday) |
| instructions, link, deadline, holidayNote | card text. TeamPilot never states hours on its own. |
| confirmWords | regex alternatives (default "done\|submitted\|filled\|completed\|updated\|sent") |
| participants | ids (default: everyone with timesheet: true) |
| coordinators | their "done for @name" counts; they're tagged on the final list |
| tagOnReminder | tag everyone pending on the first reminder (default false) |
| schedule | reminder, poll, nudge, final (cron or a list of crons) |

## modules.leave

| Key | Meaning |
|---|---|
| sources | readable venues where people announce leave |
| codes | { CODE: label }. Leave is recorded as one of these. |
| defaultCode | used when the type is unclear (recorded as provisional) |
| clarifyVenue | where "we've noted X as Y, reply if wrong" goes. A reply there corrects it. |
| digestVenue | optional "Out today" card |
| lookbackDays | how far back to read, including replies under older posts (default 7) |
| schedule | ingest, digest |

Leave entered by hand (**teampilot leave set**) is never overwritten by automation.

## modules.weeklyReport

| Key | Meaning |
|---|---|
| venue, schedule | where and when |
| title | the card title |
| teams | which standup teams (default: all) |
| cc | ids to tag |
| includeLeave, includeTimesheet | default true |

## modules.supervisor

| Key | Default | Meaning |
|---|---|---|
| alertVenue | — | a **private** chat for the operator |
| owners | [] | tagged when a finding is high severity |
| graceMinutes | 20 | how late a post may be before it counts as missing |
| verifyDelivery | true | read venues back to confirm cards landed and weren't duplicated |
| judge | false | AI checks each summary against the updates it came from |
| quietDays | 3 | end-of-day signal for members who have gone quiet |
| allClear | true | end-of-day heartbeat when nothing was found |
| schedule | — | passes: [crons], endOfDay: cron |

## people.yaml

| Key | Meaning |
|---|---|
| id | stable, never reused |
| name | as shown in Teams |
| email | lets @mentions work before the person's first reply |
| aliases | other spellings |
| teams | standup team keys |
| timesheet | true if they confirm weekly timesheets |
| neverTag | never @mention on routine cards |
| departedOn | **last working day**. Set this; don't delete the person. |
| aadId | optional Teams user id. Usually learned automatically from the person's replies. |
