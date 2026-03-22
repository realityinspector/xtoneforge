# Upstream Merge Guide

How to pull updates from the upstream [Stoneforge](https://github.com/realityinspector/stoneforge) repository into XTONEFORGE.

## Prerequisites

- A clean working tree (`git status` shows no uncommitted changes)
- The `upstream` remote pointing to Stoneforge

Verify your remotes:

```bash
git remote -v
# origin    https://github.com/realityinspector/xtoneforge.git (fetch)
# upstream  https://github.com/realityinspector/stoneforge.git (fetch)
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/realityinspector/stoneforge.git
```

## Step 1 — Fetch upstream

```bash
git fetch upstream
```

This downloads all new commits from Stoneforge without modifying your local branches.

## Step 2 — Merge upstream into main

Make sure you're on the `main` branch:

```bash
git checkout main
git merge upstream/main
```

### Merge strategy

Use a **merge commit** (the default) rather than rebasing. This preserves the upstream history as a distinct lineage and makes future merges simpler.

If you prefer an explicit flag:

```bash
git merge upstream/main --no-ff
```

> **Tip:** For routine merges with no expected conflicts, `--no-edit` accepts the default commit message automatically:
> ```bash
> git merge upstream/main --no-edit
> ```

## Step 3 — Resolve conflicts

Conflicts are expected when upstream Stoneforge changes touch files that XTONEFORGE has customised. The table below lists the most common conflict areas and how to handle each.

### XTONEFORGE-specific files (keep ours)

These files are unique to XTONEFORGE and should almost always keep **our** version:

| File / Directory | Why |
|---|---|
| `README.md` | XTONEFORGE has its own README; upstream's is different |
| `XTONEFORGE.md` | Exists only in this fork |
| `brand/` | XTONEFORGE branding assets (logos, favicons) |
| `.stoneforge/config.yaml` | Workspace config with `cross_messaging: true` and name `xtoneforge` |
| `tools/boss/xtoneforge` | XTONEFORGE-specific init/management script |
| `apps/feed/` | The social-feed app (XTONEFORGE-only) |

For these files, resolve conflicts by keeping our version:

```bash
# Accept our version for a specific file
git checkout --ours README.md
git add README.md

# Or for an entire directory
git checkout --ours brand/
git add brand/
```

### Shared packages (merge carefully)

These directories are shared with upstream and may receive legitimate changes from both sides:

| Directory | Notes |
|---|---|
| `packages/smithy/` | Core orchestration — upstream fixes matter; check for peer-bridge/peer-broker additions |
| `packages/quarry/` | Data layer — upstream schema changes matter; check `crossMessaging` config additions |
| `packages/core/` | Shared types — upstream changes almost always apply cleanly |
| `tools/boss/stoneforge-boss.sh` | Upstream's process manager — merge upstream changes, keep XTONEFORGE broker lifecycle additions |

For shared packages, review each conflict individually:

```bash
# Open conflicted files in your editor
git diff --name-only --diff-filter=U

# After resolving each file
git add <resolved-file>
```

### Config and lockfiles

| File | Strategy |
|---|---|
| `package.json` | Merge both; ensure XTONEFORGE-specific deps remain |
| `pnpm-lock.yaml` | After resolving `package.json`, regenerate: `pnpm install` then `git add pnpm-lock.yaml` |
| `turbo.json` | Merge both; keep any XTONEFORGE pipeline additions |
| `pnpm-workspace.yaml` | Merge both; ensure `apps/feed` remains listed |

### Completing the merge

Once all conflicts are resolved:

```bash
git add .
git commit
# The default merge commit message is fine
```

## Step 4 — Test after merge

Run the full test and build suite to verify nothing broke:

```bash
# Install dependencies (lockfile may have changed)
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# If you have a running workspace, restart services
./tools/boss/xtoneforge stop
./tools/boss/xtoneforge start
```

Check these areas specifically after an upstream merge:

- [ ] Feed UI loads and displays the timeline
- [ ] Cross-workspace messaging still works
- [ ] Agent orchestration (create workspace, spawn agents) functions
- [ ] Peer broker starts without errors

## Step 5 — Push

```bash
git push origin main
```

## Troubleshooting

### Large number of conflicts

If an upstream merge produces many conflicts (e.g. after a long gap between syncs), consider merging in smaller steps:

```bash
# Find upstream tags or notable commits
git log upstream/main --oneline

# Merge up to a specific commit first
git merge <commit-sha>
# Resolve, test, commit

# Then merge the rest
git merge upstream/main
```

### Lockfile conflicts

Never try to manually resolve `pnpm-lock.yaml` conflicts. Instead:

```bash
git checkout --theirs pnpm-lock.yaml   # or --ours
pnpm install                            # regenerates correctly
git add pnpm-lock.yaml
```

### Accidental upstream overwrite

If you accidentally accepted upstream's version of an XTONEFORGE file:

```bash
# Restore our version from before the merge
git checkout HEAD~1 -- <file>
git add <file>
git commit -m "fix: restore XTONEFORGE version of <file>"
```

## Recommended cadence

Merge upstream at least **weekly** to keep conflicts small and manageable. Set a recurring reminder or automate with CI.
