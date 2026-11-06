# Operations runbook

## Daily rhythm

- The **supervisor** posts to the private alert chat only when it finds something new, and
  posts an all-clear at the end of the day. **No all-clear means the supervisor itself didn't
  run.** Check the service first.
- **teampilot jobs &lt;ws&gt;** shows what runs today. Use **teampilot run &lt;ws&gt; &lt;job&gt; --dry**
  to see exactly what a job would post.

## Golden rules

1. **Dry-run first.** Every job and every module command that writes takes **--dry**.
2. **Never test in shared channels.** Use a **kind: console** venue, or a private test chat.
3. **Re-running is safe.** Posts carry a per-day key, so a job that already posted today
   skips. A restart or catch-up can't double-post.
4. **Deactivate leavers; don't delete them.**
   ```
   teampilot people <ws> depart <id> <last-day>
   ```
   They drop out of every module at once, and their history stays.
5. **Hand corrections win.** **teampilot leave set** is never overwritten by automation.
6. **A .env change needs a service restart.** workspace.yaml and people.yaml are also read at
   start-up.

## When something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| Supervisor: "Microsoft 365 sign-in isn't working" | password reset or revoked session on the bot account | **teampilot login &lt;ws&gt;** |
| "accepted by the webhook but isn't in the venue" | the Workflows flow is broken, turned off, or owned by someone who left | recreate the flow as the service account and update .env |
| "can't read this venue (not a member?)" | the bot account isn't in that team or chat | add it, or configure a fallback identity |
| "no post today (due …)" | host was down, job failed, or service not running | check **systemctl status teampilot@&lt;ws&gt;** and the log, then **teampilot run &lt;ws&gt; &lt;job&gt;** |
| "appeared 2 times" | a second copy of TeamPilot running somewhere (an old laptop, a test box) | find and stop it, or rotate the webhook URL so only this install can post |
| "scheduled … outside the host's uptime window" | the cron time is when the machine is off | move the job, or keep the host up |
| "leave messages haven't been read today" | AI provider out of credit or down, or a source unreadable | check the log; top up the provider; add an llm fallback |
| Summary says "posted N updates" instead of a real summary | AI unavailable at that moment | nothing to do; the next run uses the AI again. Add an llm fallback. |
| A person never gets @mentioned | no email in people.yaml and they haven't replied yet | add their email |
| Someone on leave was chased | the leave wasn't recorded | **teampilot leave &lt;ws&gt; set …**, then check the leave sources |

## Hosting notes

- **Keep it on a server.** A laptop that sleeps runs nothing; slots missed while it sleeps are
  caught up on wake only within **catchUpMinutes**.
- **Part-time hosts.** If the VM stops at night, set **workspace.uptime**. Doctor and the
  supervisor will flag any job scheduled outside that window.
- **IPv6.** TeamPilot prefers IPv4. Some hosts publish an IPv6 address with no IPv6 route,
  and then every webhook post fails while reads still work.
- **Verify the service is enabled** (not just started) so it survives a reboot:
  ```
  systemctl is-enabled teampilot@<ws>
  ```
- **Back up** each workspace's **state/** and **secrets/** folders. Everything else can be
  recreated.

## Several workspaces on one host

Each workspace is its own service, for example teampilot@acme and teampilot@client-b. They
share the code and nothing else: different people, secrets, AI keys, schedules and state.
Upgrading the app (re-run install.sh) never touches workspaces. Restart the services
afterwards.

## Where things are

```
~/.teampilot/app/                         the code
~/.teampilot/workspaces/<ws>/workspace.yaml
~/.teampilot/workspaces/<ws>/state/posts/<date>.jsonl   every post: title, body, tagged, untagged
~/.teampilot/workspaces/<ws>/state/scheduler/<date>.json   every run, ok or error
~/.teampilot/workspaces/<ws>/state/leave/ledger.json
~/.teampilot/workspaces/<ws>/logs/
```
