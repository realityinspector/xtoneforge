# stoneforge-boss

Multi-workspace manager for Stoneforge. Starts, stops, monitors, and manages port conflicts across multiple Stoneforge workspaces, plus the Feed social UI and sync service.

## Turnkey Setup with `xtoneforge`

The fastest way to get a Stoneforge workspace running from a fresh clone:

```bash
git clone https://github.com/your-org/your-repo.git
cd your-repo
./tools/boss/xtoneforge init
```

This single command will:
1. Install dependencies (`pnpm install`)
2. Initialize `.stoneforge/` with cross_messaging enabled
3. Register the workspace with stoneforge-boss
4. Start all services (broker, workspace, feed)
5. Open the feed UI in your browser

Options:
```bash
# Custom workspace name and review preset
./tools/boss/xtoneforge init my-project review

# Skip opening browser
XTONEFORGE_SKIP_OPEN=true ./tools/boss/xtoneforge init

# Other xtoneforge commands
./tools/boss/xtoneforge status    # Show service status
./tools/boss/xtoneforge start     # Start all services
./tools/boss/xtoneforge stop      # Stop all services
```

## Manual Quick Start

```bash
# Initialize config
stoneforge-boss init

# Register workspaces
stoneforge-boss register myproject /path/to/start-sf-myproject.sh 3457
stoneforge-boss register another  /path/to/start-sf-another.sh 3460

# Start everything
stoneforge-boss start

# Check status
stoneforge-boss status

# Start the feed UI
stoneforge-boss feed

# Live dashboard
stoneforge-boss dashboard
```

## Configuration

Config lives in `~/.config/stoneforge-boss/` (or `$XDG_CONFIG_HOME/stoneforge-boss/`):

- `workspaces.conf` -- workspace registry (`name|script_path|port`)
- `sync.conf` -- remote feed sync credentials

State (PIDs, logs) lives in `~/.local/state/stoneforge-boss/`.

## Commands

| Command | Description |
|---------|-------------|
| `init` | Create config directory and template files |
| `register <name> <script> <port>` | Add a workspace |
| `unregister <name>` | Remove a workspace |
| `start [name]` | Start workspace(s), default all |
| `stop [name]` | Stop workspace(s), default all |
| `restart [name]` | Restart workspace(s) |
| `status` | Show all workspace status |
| `feed [start\|stop]` | Manage the Feed social UI |
| `sync start [url] [token]` | Start syncing to remote feed |
| `sync stop` | Stop syncing |
| `dashboard` | Live-updating CLI dashboard |
| `logs <name>` | Show recent logs |

## Installation

```bash
# Option 1: alias (add to ~/.zshrc or ~/.bashrc)
alias stoneforge-boss='/path/to/stoneforge/tools/boss/stoneforge-boss.sh'

# Option 2: symlink
ln -s /path/to/stoneforge/tools/boss/stoneforge-boss.sh /usr/local/bin/stoneforge-boss
```
