---
title: CLI
---

`@dropit/cli` provides the `dropit` command, handy for scripts and for devices without the web app open. Requires Node.js 22+. The package is not published to the public npm registry, so do not run `npx dropit`.

## Install

```bash
pnpm install
pnpm --filter @dropit/cli build
npm install -g ./apps/cli
# or without installing: npx --yes ./apps/cli --help
```

## Sign in

```bash
dropit login --url https://dropit.example.com   # prints a code; approve it on the /device page in a signed-in browser
dropit whoami
dropit logout
```

- Optional flags: `--name <device name>`, `--scopes read,write`, `--expires-in-days 30|never`.
- The token is stored in `$XDG_CONFIG_HOME/dropit/config.json` (or `~/.config/dropit/config.json`) with mode `0600`; `DROPIT_CONFIG` overrides the path.
- Scripts / CI: set `DROPIT_URL` and `DROPIT_TOKEN`; they take precedence over the config file and are never written back.

## Common commands

| Command | Purpose |
| --- | --- |
| `dropit send "text"` / `echo x \| dropit send` | Send text |
| `dropit push <file...> [--keep]` | Upload; files ≥ 256 KiB use chunked upload (3 in parallel, retried on failure, resumable) |
| `dropit ls` | List items |
| `dropit get <id\|latest> [-o dir] [-c] [--jobs N] [--force]` | Download; `-c` resumes, `--jobs 1–8` parallel Range requests |
| `dropit rm <id\|latest>` | Retract an item |
| `dropit share <id\|latest> --expires 1d --max-views 1` | Create a share link |
| `dropit watch [--exec -- program args...]` | Watch for new items in real time, optionally running a program |
| `dropit room new [--code CODE [--pin PIN]]` / `dropit room join <link or token>` | Create / join a temporary room; `--code` sets a custom room code, optionally with `--pin` |
| `dropit room enter <CODE> [--pin PIN]` | Enter a room by its code |
| `dropit --space <id or name> ls` | Select (and remember) a space |

The `watch --exec` program receives the item body on stdin, plus the environment variables `DROPIT_ITEM_ID`, `DROPIT_ITEM_KIND`, `DROPIT_ITEM_FILENAME`, `DROPIT_ITEM_MIME`, `DROPIT_ITEM_SIZE`, `DROPIT_ITEM_SPACE` and `DROPIT_ITEM_TEXT`; it is not run through a shell.

## Output and exit codes

- `--json`: results go to stdout, errors to stderr (`{"error":{"code","message"}}`); `push` progress is emitted as JSON lines on stderr.
- Exit codes: `0` success, `2` usage error, `130` interrupted, any other non-zero value is a failure.
- Tokens are never printed; share links and room links are capabilities and are printed.

See [apps/cli/README.md](https://github.com/lthero-big/dropit/blob/main/apps/cli/README.md) for the full reference.
