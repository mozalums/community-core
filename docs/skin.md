# Skin format

A skin is a directory of data that makes one build of the platform belong to one community: its name and domain, how its mail signs off, its logos, colors and typefaces, its long copy, and the fields a member profile has. Platform code names no community; everything that does is here. This page is the reference for the format, version `1`.

A skin holds no code. The loader refuses a skin directory that contains a `.svelte`, `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, or `.jsx` file, or a symbolic link, and names the file. That is what lets someone review a skin change without reading TypeScript.

## Directory layout

A skin directory holds four entries, and the loader refuses one that lacks any of them.

| Entry       | Kind      | Purpose                                                                                    |
| ----------- | --------- | ------------------------------------------------------------------------------------------ |
| `skin.yaml` | file      | Every setting on this page.                                                                |
| `copy`      | directory | Long copy as Markdown files. See [Copy](#copy).                                            |
| `theme.css` | file      | Colors and typefaces as CSS custom properties. See [Theme](#theme).                        |
| `static`    | directory | Logos, icons and font files, served from the site root. See [Static files](#static-files). |

One skin ships in this tree: `skin/default`, a neutral community named "Example Community" on `example.org`. A community's own skin is a sibling directory, `skin/<name>`, and this page calls it `skin/your-community`. It may also hold the site's own `RUNBOOK.md` and a `deploy` directory (server blocks, an env template for `deploy/bootstrap.sh --env-example`); the loader reads neither, and `.dockerignore` keeps both out of the image.

## Skin selection

One variable, `SKIN_DIR`, selects the skin. It is a path relative to the repository root and defaults to `skin/default`.

```bash
SKIN_DIR=skin/your-community pnpm build
```

An image takes the skin as a named build context called `skin`, so the skin can sit outside the tree being built, as it does when a site's repository pins core as a submodule. `docker-compose.yml` passes `SKIN_DIR` to every service it builds as that context, from the environment or from the files given to `--env-file`, and resolves a relative path from core's checkout. A bare `docker build` takes the default skin unless the context is named:

```bash
docker build --build-context skin=skin/your-community .
```

The image copies the skin's `skin.yaml`, `theme.css`, `copy` and `static` to `/app/skin` and sets `SKIN_DIR=skin`, and compose pins that value for the containers it starts, so a `SKIN_DIR` in the secrets file, which names the host's path for the build, never reaches a container where that path means nothing. Scripts run from a checkout (`pnpm seed`, `pnpm export-members`, and the rest) read `SKIN_DIR` from the environment, so set it in `.env` when your database holds another skin's fields. `pnpm test` always runs on `skin/default`, and loads `src/lib/skin/register-node.ts` so a `$skin/skin.yaml` import resolves under plain Node the way the build serves it. That hook resolves `$skin` from `SKIN_DIR`, not from the alias the last `svelte-kit sync` or build wrote into `.svelte-kit/tsconfig.json`, so running the tests after building another skin still tests the default. A test that covers a role the default skin leaves out doesn't switch skins: it replaces the field list in memory with one from `src/lib/server/field-schema-fake.ts`. That module refuses to run when `SKIN_DIR` or the loaded skin is any directory other than the shipped `skin/default`, so a test file run by hand with another skin selected fails instead of passing on it.

A deployed page reports its skin beside the build commit and core's release tag, as `build 116bdb2 · core v1.4.0 · skin your-community`, or without the `core` part when the image was built from an untagged core: in the footer of the landing page, and in the tooltip of the sidebar logo.

## Validation

The skin is validated twice by the same loader: by `pnpm build`, which fails on a bad skin, and by the server when it starts, which exits instead of serving. At start the server also compares `skin.yaml` in `SKIN_DIR` with the one compiled into the build and exits if they differ.

Every message names the file, the key, what was found, and what was expected:

```text
skin/default/skin.yaml: site.legl_name: found an unknown key, expected one of domain, legal_name
skin/default/skin.yaml: site.legal_name: found nothing, expected a string (required)
```

An unknown key is an error, so a misspelled key never reads as unset. So are a missing required key, a value of the wrong type, and a key that appears twice.

## Format version

`skin.yaml` opens with `schema: 1`. A core release reads a fixed set of versions and refuses any other, naming the version it found, the versions it reads, and which side is behind:

```text
skin/default/skin.yaml: schema: found the number 2, expected one of the schema versions this core reads (1). This skin is newer than this core: pin a newer core release
```

## Keys

The following table lists every key in the order the schema declares it. No key has a default in version `1`: a required key must be present, and an optional key that is absent stays unset. A key marked required inside an optional mapping (`mail.credit.name`) is required only when that mapping is present.

<!-- skin-keys:begin -->

| Key                    | Type                                                                                                                                                                    | Required | Default | Example                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ------------------------------------------------------ |
| `schema`               | integer (1)                                                                                                                                                             | yes      | none    | `schema: 1`                                            |
| `id`                   | string                                                                                                                                                                  | yes      | none    | `id: default`                                          |
| `site`                 | mapping                                                                                                                                                                 | yes      | none    | See the following rows.                                |
| `site.domain`          | string                                                                                                                                                                  | yes      | none    | `domain: example.org`                                  |
| `site.legal_name`      | string                                                                                                                                                                  | yes      | none    | `legal_name: Example Community`                        |
| `site.name`            | string                                                                                                                                                                  | yes      | none    | `name: Example Community`                              |
| `site.default_group`   | string                                                                                                                                                                  | yes      | none    | `default_group: example`                               |
| `mail`                 | mapping                                                                                                                                                                 | yes      | none    | See the following rows.                                |
| `mail.from_name`       | string                                                                                                                                                                  | yes      | none    | `from_name: Example Community`                         |
| `mail.sign_in_subject` | string                                                                                                                                                                  | yes      | none    | `sign_in_subject: Your Example Community sign-in link` |
| `mail.signature`       | string                                                                                                                                                                  | yes      | none    | `signature: Example Community`                         |
| `mail.credit`          | mapping                                                                                                                                                                 | no       | none    | See the following rows.                                |
| `mail.credit.name`     | string                                                                                                                                                                  | yes      | none    | `name: Sign Co`                                        |
| `mail.credit.url`      | string                                                                                                                                                                  | yes      | none    | `url: https://sign.example.net/`                       |
| `brand`                | mapping                                                                                                                                                                 | yes      | none    | See the following rows.                                |
| `brand.wordmark`       | string                                                                                                                                                                  | yes      | none    | `wordmark: imgs/wordmark.svg`                          |
| `brand.mark`           | string                                                                                                                                                                  | yes      | none    | `mark: imgs/mark.svg`                                  |
| `brand.email_logo`     | string                                                                                                                                                                  | yes      | none    | `email_logo: email/shared/logo.png`                    |
| `analytics`            | mapping                                                                                                                                                                 | no       | none    | See the following rows.                                |
| `analytics.provider`   | one of `fathom`                                                                                                                                                         | yes      | none    | `provider: fathom`                                     |
| `analytics.site`       | string                                                                                                                                                                  | yes      | none    | `site: ABCDEFGH`                                       |
| `fields`               | list of mappings                                                                                                                                                        | yes      | none    | See the following rows.                                |
| `fields[].key`         | string                                                                                                                                                                  | yes      | none    | `key: name`                                            |
| `fields[].label`       | string                                                                                                                                                                  | yes      | none    | `label: Name`                                          |
| `fields[].type`        | one of `text`, `longtext`, `list`, `year`, `url`, `email`, `checkbox`                                                                                                   | yes      | none    | `type: text`                                           |
| `fields[].visibility`  | one of `members`, `private`                                                                                                                                             | yes      | none    | `visibility: private`                                  |
| `fields[].role`        | one of `name`, `givenName`, `familyName`, `email`, `handle`, `bio`, `tenureStart`, `tenureEnd`, `affiliation`, `affiliationOther`, `publicProfile`, `avatar`, `retired` | no       | none    | `role: name`                                           |
| `fields[].column`      | one of `email`, `name`, `city`, `linkedin`                                                                                                                              | no       | none    | `column: name`                                         |
| `fields[].placeholder` | string                                                                                                                                                                  | no       | none    | `placeholder: e.g. Lisbon`                             |
| `fields[].options`     | one of `countries`, `cities`, `years`, `sizes`, `dialingCodes`                                                                                                          | no       | none    | `options: countries`                                   |
| `fields[].required`    | boolean                                                                                                                                                                 | no       | none    | `required: true`                                       |

<!-- skin-keys:end -->

A test compares this table with the schema in `src/lib/skin/schema.ts`, so a key added there without a row here fails `pnpm test`.

## Identity keys

`id` is a lowercase slug (`a-z`, `0-9`, and `-`). It is the name a running build reports for its skin.

`site.domain` is the bare domain the community is served on, with no scheme and no `www`. It is the fallback for the `PUBLIC_BASE_DOMAIN` environment variable, which scopes the session cookie. If neither names a domain you serve, the browser drops the cookie and sign-in doesn't persist.

`site.legal_name` is who operates the site, for legal copy. No page renders it yet.

`site.name` is the name visitors see: the browser title of any page that sets none of its own, the sign-in page and dialog ("Sign in to Example Community"), and the alt text of every logo the pages and the mail show. It is not the group's name, which lives in the database and heads the directory pages.

`site.default_group` is the slug of the group served at the site's clean root URLs (`/`, `/members`, `/admin`, and the rest), which map onto `/group/<slug>/…`. `pnpm seed` creates that group, named `site.name`. A lowercase slug, as for `id`. Changing it on a running deployment points the root URLs at a different group row.

## Mail

`mail` is how the platform's messages name the community.

- **`from_name`** is the display name on the From line of the sign-in and membership-approved messages. The address beside it is the transport's (`MAIL_FROM` or `no-reply@` the site domain), not the skin's.
- **`sign_in_subject`** is the sign-in message's subject, its HTML title and accessible label, and the first line of its plain-text part.
- **`signature`** closes the sign-in message, after "Thanks,", in both parts. In the HTML it links to the site.
- **`credit`** is optional. When set, the sign-in message ends with a small "Sign-in secured by" line linking `name` to `url` (an `https://` URL). When absent, that line is not rendered at all.

Each value is inserted as text, so markup in it is escaped rather than rendered.

```yaml
mail:
  from_name: Example Community
  sign_in_subject: Your Example Community sign-in link
  signature: Example Community
  credit:
    name: Sign Co
    url: https://sign.example.net/
```

## Brand

`brand` names the skin's logos by their path under its `static` directory, with no leading slash. A build serves each at `/` and that path (see [Static files](#static-files)), and the loader refuses a skin whose `brand` names a file that is not there.

- **`wordmark`** is the logo with the community's name in it, an `.svg` or `.png`. Every page that shows a logo shows this one: the landing hero, the sidebar, the top bar, the sign-in page and dialog, the sign-in link page, and the membership request form. Pages draw it in dark mode with a CSS `invert`, so draw it dark on a transparent background.
- **`mark`** is the square symbol without the name, an `.svg` or `.png`. It is the browser tab's icon.
- **`email_logo`** heads both messages the platform sends to members, a `.png` because mail clients render no SVG. Messages link it by absolute URL, so a message already delivered keeps requesting the path it was sent with: keep the old file when you rename this one.

The `alt` text of every one of these images is `site.name`.

Name the files for what they are, not for whose they are: `imgs/wordmark.svg`, not `imgs/<community>-logo.svg`.

```yaml
brand:
  wordmark: imgs/wordmark.svg
  mark: imgs/mark.svg
  email_logo: email/shared/logo.png
```

## Analytics

`analytics` is optional, and the default skin sets none. Without it, no page carries an analytics script and the Content-Security-Policy allows no analytics origin, so a page makes no third-party request beyond Gravatar's avatar fallback.

With it, every page loads the provider's script and the policy allows the provider's origin in `script-src`, `connect-src`, and `img-src`. Both follow from the same block at build time, so they can't disagree.

- **`provider`** is one core knows. Core holds each provider's script URL and origin (`src/lib/skin/analytics.js`), so a skin switches analytics on but can't add an origin of its own to the policy. `fathom` loads `https://cdn.usefathom.com/script.js`.
- **`site`** is the provider's site id, letters and digits.

```yaml
analytics:
  provider: fathom
  site: ABCDEFGH
```

The policy is fixed when the app is built, so changing the block takes a rebuild, like every other key.

## Copy

Long copy is Markdown in the skin's `copy` directory, rendered on the server when first used and kept for the life of the process. Raw HTML in a file is escaped, not passed through. Every file is optional: a page leaves out whatever its skin does not ship.

| File                   | Where it appears                                                                                                   | Without it                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `landing-hero.md`      | The top of the landing page, above the sign-in button. Its level-1 heading is the page's only one.                 | The hero shows the logo and the button alone.            |
| `landing-band.md`      | The dark band below the hero.                                                                                      | No band.                                                 |
| `sidebar.md`           | The signed-in sidebar, above the links to the documents below.                                                     | No text; the document links still show.                  |
| `affiliations-help.md` | Under the "Associated with" heading of the profile edit form. Shown only when the skin has an `affiliation` field. | No helper line.                                          |
| `manifesto.md`         | The page at `/manifesto`, linked from the landing footer and the sidebar.                                          | `/manifesto` answers 404, and nothing links to it.       |
| `code-of-conduct.md`   | The page at `/code-of-conduct`, linked from the landing footer and the sidebar.                                    | `/code-of-conduct` answers 404, and nothing links to it. |

Start `landing-hero.md` with one level-1 heading and use none elsewhere; `landing-band.md` uses level 2. A `#` heading is one line. To break a heading across lines, underline it with `=` instead and end each line but the last with a backslash:

```text
Welcome.\
You're among friends.
=====================

A private directory for the members of Example Community.
```

A number typed into copy ("200 members") is wrong the day after someone joins. The member count the platform knows is in the sidebar.

## Theme

`theme.css` sets the colors and typefaces as CSS custom properties. Core's Tailwind configuration binds class names to them, so a page asks for a role (`bg-accent`, `text-link`, `font-serif`) and the skin picks its value. The file is CSS, read with the `postcss` package pinned in `pnpm-lock.yaml`, and holds only the following:

| Property                  | Block               | Holds                                                                               |
| ------------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| `--color-accent`          | `:root` and `.dark` | The accent: primary buttons, focus rings, the browser theme color and mail buttons. |
| `--color-accent-contrast` | `:root` and `.dark` | Text on the accent.                                                                 |
| `--color-link`            | `:root` and `.dark` | Links in Markdown and in the directory and admin pages.                             |
| `--font-sans`             | `:root`             | The body typeface stack. Tailwind's `font-sans`, and the page default.              |
| `--font-serif`            | `:root`             | The serif stack, applied only where a page asks for `font-serif`.                   |

`:root` holds the light-mode values and `.dark` the dark-mode colors, which apply while the page carries the `dark` class. Both blocks are required and each must set every property listed for it. Beside them the file may hold `@font-face` rules and comments. The loader refuses any other selector, at-rule, or property, a property set twice in one block, and a color that is not a hex value (`#rgb` or `#rrggbb`). Colors are hex because mail clients get them inlined: the sign-in and membership-approved messages color their button and signature with the light-mode accent and its contrast color, and the `theme-color` meta every page carries is that same accent. The server renders the light accent into the meta; while the page is in dark mode, whether chosen in the theme menu or followed from the OS, the pre-paint script in `src/app.html` and `ThemeToggle.svelte` rewrite it from the page's own `--color-accent`, so the browser chrome and the page never disagree.

The platform sets a contrast floor of 4.5:1, the WCAG AA level for body text, and the loader refuses a theme under it, naming the property, the ratio and what it was measured against. In each mode it measures the accent against its contrast color, and the accent and the link color against each background the platform paints in that mode: `#f3f4f6`, `#f9fafb` and `#ffffff` in light mode, `#0a0a0a`, `#171717` and `#000000` in dark mode. Those backgrounds are core's, so a skin can't pass the floor by naming a friendlier one.

```css
:root {
	--color-accent: #4338ca;
	--color-accent-contrast: #ffffff;
	--color-link: #4338ca;
	--font-sans: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	--font-serif: Georgia, 'Times New Roman', serif;
}

.dark {
	--color-accent: #a5b4fc;
	--color-accent-contrast: #000000;
	--color-link: #a5b4fc;
}
```

A typeface the skin ships is the skin's to declare: its `@font-face` rules go in `theme.css`, its files in `static`, and its license beside the files. The Content-Security-Policy loads fonts from the site's own origin only, so a face from a font CDN does not load. `skin/default` uses system font stacks and ships no font file.

## Static files

Everything in a skin's `static` directory is served from the site root, at the URL it would have had in core's own `static` directory: `static/imgs/wordmark.svg` in the skin is `/imgs/wordmark.svg` on the site. Core's `static` keeps only files no community replaces, which today is `robots.txt`.

Each time SvelteKit loads `svelte.config.js` (for `pnpm build`, `vite dev` and `pnpm check`), `src/lib/skin/assets.js` reads every file in core's `static` and the selected skin's once, and writes those bytes into `.svelte-kit/skin-assets/<hash>`, named by a hash of each file's URL path and bytes; the config names that directory as SvelteKit's `kit.files.assets`.
The bytes that are checked for collisions, hashed and written are the same read, so a file edited while a load stages lands in the next directory, never under the hash of its earlier contents.
A staged directory is built under a temporary name, published with one rename and never changed afterward, so concurrent loads (the test runner, `vite dev` beside `pnpm check`) share a finished copy or write separate ones, and a file removed from a skin is absent because the changed hash names a new directory.
Earlier directories stay until `.svelte-kit` is cleared. SvelteKit serves that one directory, in development and from the built server alike, so a skin's files need no route or server code. Under `vite dev`, a skin file you change shows after a restart.

A skin file at a path core's `static` already holds is refused rather than allowed to replace it, and so is anything under `_app`, where SvelteKit writes its bundles. The build fails naming each file.

Two skins that ship the same file name build two sites that serve different bytes at the same URL. With `skin/one/static/imgs/wordmark.svg` and `skin/two/static/imgs/wordmark.svg` holding different drawings:

```bash
SKIN_DIR=skin/one pnpm build && cmp build/client/imgs/wordmark.svg skin/one/static/imgs/wordmark.svg
SKIN_DIR=skin/two pnpm build && cmp build/client/imgs/wordmark.svg skin/two/static/imgs/wordmark.svg
```

Both comparisons succeed, and the two builds' `imgs/wordmark.svg` differ. `pnpm test` runs those builds in a scratch tree and checks the same.

Every skin's `static` must also hold `favicon.ico` and `apple-touch-icon.png`, which every page links by those fixed names. The loader refuses a skin without them.

## Profile fields

`fields` is the list of fields a member has, in the order the profile, the edit form, and the CSV export show them. The list sets the privacy boundary: a `private` field is stored apart from the members-visible ones, shown to group admins only, and never read by search.

- **`key`** is the stable name the value is stored under: letters and digits, starting with a lowercase letter. Renaming a key does not move stored data; that takes a migration.
- **`label`** is the form label and the CSV column header. No two fields share a key or a label.
- **`type`** picks the control: `longtext` and `list` render a multi-line box, `checkbox` a checkbox, and every other type a single-line input.
- **`role`** is how the platform finds a field without knowing its key.
- **`column`** copies the field into a typed column of the member row, used for sorting and search. Fields that share a column are joined with a space, in list order.
- **`placeholder`** is the hint shown in an empty form control. On the field with the role `affiliationOther` it is also the hint in the membership request form's "Other" box.
- **`options`** turns the field's control in the profile edit form into a select over one of the built-in lists. See [Option lists](#option-lists).
- **`required`** set to `true` makes the profile edit form refuse an empty answer and marks the label with an asterisk. Absent or `false`, the field is optional.

A field's key never decides its control. A field keyed `startYear` or `country` that sets neither `options` nor `required` is an optional free-text input.

### Option lists

| `options`      | The select offers                                                |
| -------------- | ---------------------------------------------------------------- |
| `countries`    | A list of countries.                                             |
| `cities`       | The major cities of the country chosen in the `countries` field. |
| `years`        | The years 1994 to 2100.                                          |
| `sizes`        | Garment sizes, `XXS` to `XXXXXL`.                                |
| `dialingCodes` | International dialing codes, shown with their country.           |

A stored value that is not in its list stays selectable, so opening and saving a profile never drops it. The server stores whatever a select posts and doesn't check it against the list.

The loader refuses `options` on a field with no single-line control: a `longtext`, `list`, or `checkbox` field, and a field with the role `bio`, `email`, `affiliationOther`, `avatar`, or `retired`. It refuses `required` on a `checkbox` field and on the roles `email`, `affiliationOther`, `avatar`, and `retired`. A skin has at most one `countries` field and at most one `cities` field, and a `cities` field needs a `countries` field.

`required` is enforced by the browser on the profile edit form only. The server accepts an empty value for a required field, and the membership request form has its own fixed rules: it requires the name (the given name where the name is in two parts) and the `column: linkedin` field.

### Roles

A skin names its members in one of two ways: one field with the role `name`, holding the whole name, or one field each with the roles `givenName` and `familyName`. The loader refuses a skin with neither, with both, or with half of the second. Each of these fields must set `column: name`, because the member's display name is read from that column.

Every other role is optional, and the feature that reads it is off when no field has it. That includes `email`: the sign-in address is stored with the member whether or not a profile field keeps a copy. A skin without an `email` field can't label another field "Email", because the CSV export gives that heading to the sign-in address.

| Role               | Fields      | Without it                                                                             |
| ------------------ | ----------- | -------------------------------------------------------------------------------------- |
| `name`             | exactly one | The skin must have `givenName` and `familyName` instead.                               |
| `givenName`        | exactly one | The skin must have `name` instead.                                                     |
| `familyName`       | exactly one | The skin must have `name` instead.                                                     |
| `email`            | at most one | The profile page shows the address to no one, and the export has no stored copy of it. |
| `handle`           | at most one | Search does not fuzzy-match a nickname.                                                |
| `bio`              | at most one | The profile card shows no bio.                                                         |
| `tenureStart`      | at most one | A year in a directory search is matched as a word.                                     |
| `tenureEnd`        | at most one | A year in a directory search is matched as a word.                                     |
| `affiliation`      | any number  | The request and edit forms ask for no affiliation.                                     |
| `affiliationOther` | at most one | The forms offer no free-text "Other" affiliation.                                      |
| `publicProfile`    | at most one | No member can opt in to the public homepage.                                           |
| `avatar`           | at most one | An uploaded photo is stored, and its URL is not in the export.                         |
| `retired`          | any number  | Nothing; a retired field is kept and never shown.                                      |

### Example

The following field is members-visible, is found by the platform as the member's name, and feeds the display name:

```yaml
fields:
  - key: name
    label: Name
    type: text
    visibility: members
    role: name
    column: name
```

### Shipped field sets

`skin/default` has five fields: `name`, `country`, `city`, `bio`, and one private field, `phone`. `country` and `city` offer the `countries` and `cities` lists, and `country` is the one required field.

### Form controls

The request and profile edit forms post some values under fixed control names. Each fixed control is bound to its field by role, so the value is stored under whatever key the skin gives that field. Where the skin lists a field decides only where its control is shown and, for the name parts, the order they join into the display name.

The membership request form has only fixed controls:

| Control                | Shown when the skin has                  | Stored under               |
| ---------------------- | ---------------------------------------- | -------------------------- |
| `name`                 | a `name` field                           | that field's key           |
| `firstName`            | a `givenName` field                      | that field's key           |
| `lastName`             | a `familyName` field                     | that field's key           |
| `linkedin`             | a field with `column: linkedin`          | the first such field's key |
| `aff_` and a field key | fields with the role `affiliation`       | each field's key           |
| `otherAffiliations`    | a field with the role `affiliationOther` | that field's key           |
| `publicProfile`        | a field with the role `publicProfile`    | that field's key           |

The profile edit form posts each editable text field under its own key (the `bio` field is set apart at the top of the form, still under its key), and the `aff_`, `otherAffiliations`, and `publicProfile` controls as above. Because a text field posts under its key, the loader refuses a skin where a field is keyed `otherAffiliations` or `publicProfile` while a different field holds the matching role: the form would post two values under one name.

## Compatibility

From `v0.1.0`, a minor or patch release of core keeps every released skin loading. `src/lib/skin/released/` holds one `skin.yaml` per core release, named by tag (`v0.1.0.yaml`), and a test loads each against the current schema. It is empty until the first tag.

That test failing is the definition of a breaking change. A breaking change ships only in a major release, and the file it broke is removed in that release's commit, never edited.

## Not yet covered

- The red of form errors is fixed in platform markup, not a theme property.
- The dark gray submit buttons on profile edit, the request form and the admin access, requests and audit pages are fixed in platform markup and do not follow the accent.
- The loader does not check that an `@font-face` source names a file the skin ships. A missing one loads no face, and the page falls back to the next family in the stack.
- The request form's labels ("First name", "Last name", "LinkedIn URL") are fixed text and do not follow the skin's field labels.
- The option lists are built into core. A skin can't define a list of its own.
- `required` isn't checked by the server. See [Option lists](#option-lists).
