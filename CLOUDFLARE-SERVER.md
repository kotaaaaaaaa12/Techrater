# Techrater Server on Cloudflare Workers and Containers

This overlay adds a standalone official Techrater server to a clean Techrater clone. The Web client is deployed separately to Cloudflare Pages.

## Install

Clone Techrater with its vcpkg submodule, then merge this overlay into the repository root:

```sh
git clone --recurse-submodules https://github.com/26F-Studio/Techrater.git
```

The Docker build intentionally stops with a clear error if the submodule is missing.

## Supabase

1. Create a Supabase project.
2. Enable anonymous sign-ins in Authentication settings.
3. Run `cloudflare/supabase/schema.sql` in the SQL editor.
4. Copy the Session pooler connection values. Use the pooler host and port `5432` for the persistent Techrater database connections.

## Cloudflare secrets

Set every value before the first deployment:

```sh
npx wrangler secret put CLIENT_ORIGIN
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_DB_HOST
npx wrangler secret put SUPABASE_DB_PORT
npx wrangler secret put SUPABASE_DB_NAME
npx wrangler secret put SUPABASE_DB_USER
npx wrangler secret put SUPABASE_DB_PASSWORD
npx wrangler secret put TECHRATER_AUTH_TOKEN
```

`CLIENT_ORIGIN` must be the exact Pages origin, such as `https://techmino.example.com`, without a path. `TECHRATER_AUTH_TOKEN` must be a newly generated long random value and must never be placed in the client repository.

## Cloudflare Workers Builds

| Setting | Value |
| --- | --- |
| Root directory | Repository root |
| Build command | `npm run typecheck` |
| Deploy command | `npx wrangler deploy` |

The first image build is slow because vcpkg compiles the native Techrater dependencies. The configuration uses one `basic` Container instance because rooms and Redis tokens are stored in memory.

## Verification

After deployment, open `https://YOUR-SERVER/_worker/health`. It should return `ok` after the Container connects to Supabase.

The build-time patch corrects the official generated `Data` model so the Supabase row uses the authenticated player ID instead of dropping it during INSERT.
