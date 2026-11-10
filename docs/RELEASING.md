# Developing and releasing

## Work on the code

```bash
git clone https://github.com/Kumar-Gourabh/teampilot.git
cd teampilot && npm install
npm test                         # unit + end-to-end tests, no network needed
node bin/teampilot.js demo       # run the CLI straight from the checkout
```

To try a change against a real workspace without installing, run the CLI from the checkout:

```bash
node bin/teampilot.js run <workspace> <job-id> --dry
```

## Publish a new version

1. Bump **version** in package.json (for example 0.1.0 → 0.2.0) and add a section to
   CHANGELOG.md.
2. In the README's install command, update the version in both places it appears: the
   release folder (v0.2.0) and the file name (teampilot-0.2.0.tgz).
3. Test, build the package, commit, tag and push:
   ```bash
   npm test && npm run package
   git add -A && git commit -m "TeamPilot 0.2.0" && git tag -a v0.2.0 -m "TeamPilot 0.2.0"
   git push && git push --tags
   ```
4. On GitHub, go to **Releases → Draft a new release**, choose the new tag, paste the
   CHANGELOG section as the notes, and attach **dist/teampilot-0.2.0.tgz**.
   Tick **Pre-release** if the version hasn't run against a real Teams workspace yet.

## Upgrade an existing install

Re-run the install command with the new release URL. The app in ~/.teampilot/app is
replaced; workspaces in ~/.teampilot/workspaces are never touched. Then restart each
workspace's service, for example:

```bash
sudo systemctl restart teampilot@<workspace>
```
