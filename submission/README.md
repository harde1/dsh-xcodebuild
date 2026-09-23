# Submitting XcBuild to `awesome-dsh-plugin`

The submission is **one YAML file** in someone else's repository. Everything else on this page is
either a prerequisite only you can satisfy, or a decision already made here with the evidence.

Upstream rules: <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>

## What is already satisfied in this repository

| Requirement | State |
| --- | --- |
| `dsh.bundle` manifest in `package.json` | ✅ `{"patch": "./cordis.patch.yml"}` — this is what CI checks first |
| `cordis.patch.yml` at the root, inserting the row | ✅ `id: dsh-xcodebuild`, `name: dsh-xcodebuild` |
| `dsh.client` for browser UI | ✅ `platform: web` |
| Real, working code rather than a placeholder | ✅ 6 tools, 3361 checks across 18 test files |
| `LICENSE` file for the MIT declared in `package.json` | ✅ added, copyright chuckliang |
| `node_modules/` not committed | ✅ already in `.gitignore` |
| Public repository | ✅ `https://github.com/harde1/dsh-xcodebuild` |

## What only you can do

1. ~~**Create the GitHub repository and push.**~~ **Done** — pushed to
   `git@github.com:harde1/dsh-xcodebuild.git` (`main`).
2. **Wait out the 1-day bar.** CI rejects a repo created less than a day before the PR. This is
   automated and is not a judgement about the plugin — it filters out repos created minutes before
   submitting. Resubmitting later costs nothing.
3. **Add the `dsh-plugin` topic** to the repository (`Settings → Topics`), or via
   `gh repo edit harde1/dsh-xcodebuild --add-topic dsh-plugin`. CI does not check this; the list's
   own tooling does.
4. **Keep the description honest.** See the note under *What gets reviewed* below.

## The steps

The repository already exists and is pushed, so only steps 2 and 3 remain:

```sh
# 1. Already done — https://github.com/harde1/dsh-xcodebuild
#    git init -b main && git add -A && git commit
#    git remote add origin git@github.com:harde1/dsh-xcodebuild.git
#    git push -u origin main

# 2. Add the topic (or use Settings → Topics)
gh repo edit harde1/dsh-xcodebuild --add-topic dsh-plugin

# 3. Fork and clone the list, add the entry, open the PR
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
cp /path/to/this/repo/submission/plugin-entry.yml data/plugins/harde1__dsh-xcodebuild.yml
git checkout -b add-dsh-xcodebuild
git add data/plugins/harde1__dsh-xcodebuild.yml
git commit -m "Add harde1/dsh-xcodebuild"
gh pr create --fill
```

The filename and the entry must agree: repository `harde1/dsh-xcodebuild` takes
`data/plugins/harde1__dsh-xcodebuild.yml`, with `url` and `name` both
`https://github.com/harde1/dsh-xcodebuild` and `harde1/dsh-xcodebuild`. Both are already filled in.

PRs may add at most **3** entries, which is not a constraint here.

## Two decisions, and the evidence for them

### `@deepseek-ai/*` stays out of `peerDependencies`

Upstream recommends declaring official packages as `peerDependencies`, and warns that a peer range
without an explicit prerelease branch silently excludes every prerelease build of the harness. That
warning is correct, and the range it recommends as the fix **does not admit the harness this plugin
is actually running against.**

Measured with semver against `@deepseek-ai/dsh-tools@0.1.5-rc.2`, the version installed here:

```
version:                  0.1.5-rc.2  0.1.0-rc.6  0.1.0  0.1.5  0.2.0-rc.1
>=0.0.1-rc.1 <0.2.0            .          .         Y      Y        .
*                              .          .         Y      Y        .     <- excludes every prerelease
>=0.1.0-rc.1 <0.2.0-0          .          Y         Y      Y        .     <- the suggested fix
>=0.1.0-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0
                               .          Y         Y      Y        .     <- the full example, still misses it
```

The rule semver enforces is that a prerelease satisfies a range only if some comparator in the range
shares its exact `major.minor.patch` tuple **and** carries a prerelease tag. The recommended example
puts its comparators on the `0.1.0` tuple; the installed version is on `0.1.5`. No static range can
cover every prerelease of a moving `0.1.x` line, so following that advice verbatim would hand users
an `ERESOLVE` on a plugin that installs correctly today.

`package.json` therefore declares nothing, as before, and documents why in `dshHostRuntime` — the
loader resolves host packages itself for a mounted plugin row, so nothing is missing at runtime.
A wrong peer range is worse than no peer range: it converts a working install into a failure.

If you would rather satisfy the recommendation, the range must be re-derived per harness release
rather than copied, and the `0.1.5` tuple needs its own branch:

```jsonc
"peerDependencies": {
  "@deepseek-ai/dsh-tools": ">=0.1.0-rc.1 <0.1.0 || >=0.1.5-rc.1 <0.2.0-0"
}
```

This admits `0.1.5-rc.2` and stable `0.1.x` from `0.1.5` up, and stops admitting the next
prerelease line, which is the honest cost of the approach.

### No npm package and no tarball, for now

Both are listed as *recommended* for a better install experience, not required. The `allowBuilds`
approval they avoid only applies to packages that run build scripts on install, and this one is plain
ESM with no `prepare` script, so installing from the repository source needs no approval and no
tarball. Publishing to npm would be nicer for users — `dsh plugin add dsh-xcodebuild` instead of a
git URL — and is worth doing once the repository is settled.

If it is ever needed, the tarball field must point at GitHub's own release hosting and must not put a
version in the filename unless the tag is pinned; `latest/download/` takes the filename literally, so
a versioned asset name works on submission day and 404s after the next release.

```yaml
tarball: https://github.com/harde1/dsh-xcodebuild/releases/latest/download/dsh-xcodebuild.tgz
```

## Screenshots

None are declared, and that is allowed — storefronts fall back to images in the README. To take
control of the set later, add a `screenshots.json` beside `package.json` listing 1–8 paths relative
to itself, pointing at images already committed here. Keeping them in this repository matters: a
relative path breaks visibly when the file is renamed, whereas an absolute URL written into the
other repository can only rot unnoticed.

## What gets reviewed, and where this plugin stands

A green CI run is the precondition, not the decision. A maintainer reads this repository. The
description in the entry is treated as a claim about the code and is checked against it:

- "Builds, tests, archives and runs Xcode projects and workspaces" — the actions are Build,
  Build & Run, Test, Clean and Archive; `xcode_project` detects both `.xcodeproj` and `.xcworkspace`.
- "a live filterable build log" — the log panel, filtered on the host.
- "scheme and destination pickers" — both, plus configuration, read from the project itself.
- "simulator or device log streaming" — `xcode_device_log`, over CoreDevice or the classic channel.
- "macOS only" — `xcodebuild` exists nowhere else.

Nothing in the entry claims a number, so there is no count to keep in sync. If that changes, the
number becomes a claim and must match the code.
