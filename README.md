# community-core

A small, self-hosted member directory for a community that used to share a place: a former team, an alumni network, a program's past cohort. Members sign in with a link sent to their email, find each other in a searchable directory, and keep their own profiles current. Admins approve who gets in.

One deployment serves one community. The community's name, copy, logos, colors and profile fields live in a skin, a directory of YAML, Markdown, CSS and images; the platform is the same code for every community. Postgres holds the roster and everything else; Redis holds sessions.

## What a community gets

- **A public landing page** in the community's own words, Markdown from the skin plus a section admins edit in the app.
- **Passwordless sign-in.** A member enters an address and confirms the link mailed to it. Sessions last 24 hours.
- **Gated access.** A signed-in address that is a member reaches the directory; any other is offered a membership request form, which admins approve or deny.
- **A member directory** with free-text search across profile fields, starred people, profile pages and avatars served from the site's own domain, with Gravatar as a cached fallback.
- **Self-service profiles.** Members edit or delete their own; the fields, and which of them only admins see, come from the skin.
- **Admin tools**: admin grants, roster export and import as CSV with a preview before anything changes, and an audit trail of every change with retention windows.

[Features](docs/features.md) describes each one in full.

## Quick start

This runs the platform on your machine with the default skin, a community named "Example Community", in about ten minutes. You need Docker and Node 22.

1. Select Node 22. `.nvmrc` names it and `package.json` refuses any other major, so any version manager that reads `.nvmrc` works:

   ```bash
   fnm use --install-if-missing
   corepack enable                  # provides the pinned pnpm
   ```

2. Start Postgres (port 5881) and Redis (port 5882), both on `127.0.0.1` only:

   ```bash
   docker compose -f docker-compose.dev.yml up -d
   ```

3. Copy the environment template and point it at those two:

   ```bash
   cp .env.example .env
   ```

   ```dotenv
   POSTGRES_PORT=5881
   POSTGRES_PASSWORD=lorem
   REDIS_URL=redis://127.0.0.1:5882
   LOREM_REDIS_PREFIX=lorem-dev
   ADMIN_SUBJECTS=email:you@example.org
   ```

4. Create the schema, seed the default group with five invented members and make your address its admin, then start the server:

   ```bash
   pnpm install
   pnpm migrate
   pnpm seed
   pnpm dev                         # http://localhost:5870
   ```

5. Sign in as `you@example.org`. With no `SMTP_*` set, `pnpm dev` prints the sign-in link to its console instead of mailing it:

   ```text
   {"ts":"…","level":"warn","msg":"auth.magic.dev-link","url":"http://localhost:5870/auth/magic?token=…"}
   ```

   Open that URL and confirm. You land in the directory as an admin; sign in as any other address to see the membership request form.

`docker-compose.dev.yml` is a separate file, not a `docker-compose.override.yml`, because an override is merged into a bare `docker compose up` and would carry these fixture credentials into the production stack. [Configuration](docs/configuration.md) lists every variable, and [deployment](docs/deployment.md) puts the same thing on a server.

## Skins

A skin is a directory, selected at build time by `SKIN_DIR`, holding `skin.yaml` (the site's name and domain, the mail sender, the profile fields, optional analytics), a `copy` directory of Markdown for the landing page, sidebar, Manifesto and Code of Conduct, a `theme.css` of color and typeface custom properties, and a `static` directory of logos, icons and fonts. It contains no code, so a change to a skin cannot change what the server does with member data. `skin/default` ships here; build your own beside it and run `SKIN_DIR=skin/your-community pnpm build`. [Skins](docs/skin.md) is the format reference.

## Commands

| Command                             | Purpose                                                       |
| ----------------------------------- | ------------------------------------------------------------- |
| `pnpm dev`                          | Development server on port 5870                               |
| `pnpm check`                        | Node pin, neutral-tree check, `svelte-check`                  |
| `pnpm test`                         | Unit tests, against `skin/default`                            |
| `pnpm build`                        | Production build into `build/`                                |
| `pnpm preview`                      | Serve the production build on port 5880                       |
| `pnpm migrate`                      | Apply pending migrations                                      |
| `pnpm seed`                         | The default group, sample members, `ADMIN_SUBJECTS` as admins |
| `pnpm export-members <slug>`        | Roster as CSV                                                 |
| `pnpm import-members <slug> <file>` | Roster import, a dry run unless `--apply`                     |
| `pnpm prune-audit`                  | Prune the audit trail now                                     |

## Documentation

- [Features](docs/features.md): sign-in, membership requests, admin access, roster export and import, the audit trail, the directory, routes and mail.
- [Skins](docs/skin.md): every `skin.yaml` key, the copy files, the theme and the static files.
- [Configuration](docs/configuration.md): every environment variable, its type, default and what breaks without it.
- [Data model](docs/data-model.md): the tables, and how profile fields are stored.
- [Deployment](docs/deployment.md): first install, `deploy/deploy.env`, `deploy/deploy.sh`, CI deploys, migrations and moving hosts.
- [Operations](docs/operations.md): scripts on a host, backups and restore, container isolation, the reverse proxy, security headers and mail DNS.
- [Upgrading](docs/upgrading.md): the public interface, and what each kind of release may change.
- [Releasing](docs/releasing.md): tagging a core version, and moving a site's pin onto it.
- [Testing](docs/testing.md): what each CI job catches, when it runs, and running the tests locally.
- [Skin repository](docs/skin-repository.md): splitting a community's site into its own repository, its CI and review guardrail, and the GitHub settings they rely on.

## Built with

SvelteKit 2 and Svelte 5 on `adapter-node`, Tailwind 3, `markdown-it` for skin and admin Markdown, Postgres (`pg`) for all member data, Redis for sessions and sign-in tokens, and an SMTP submission client of its own in `src/lib/server/smtp.ts`. pnpm 10, Node 22.

## Authors

Matt Mankins of LoremLabs started the platform in May 2026 and wrote it through August 2026: the SvelteKit application, sign-in, the directory and the first deployment. The sign-in email template and the avatar color picker come from other LoremLabs projects. Ravi Pina has written it since August 2026: the move off Google Sheets to Postgres, roster import and export, the audit trail, the deploy and backup scripts, and the skin seam that separates the platform from one community. This repository starts from a single commit; the history before it is kept privately.

## Status

Pre-1.0. One community runs it in production. From `v0.1.0`, minor and patch releases follow the contract in [upgrading](docs/upgrading.md).

## License

No license has been chosen yet, so none is granted: you may read this code, but not copy, modify or redistribute it.
