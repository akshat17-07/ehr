# EHR backend

Backend for a single-hospital EHR in Madhya Pradesh: an API on AWS Lambda plus the AWS infrastructure that runs it.
Everything runs in **AWS Mumbai (ap-south-1)**, serverless, with no servers to maintain.

The React website is a separate repo (`ehr-frontend`). This repo creates where it is hosted and writes its `config.json`.

Design documents (next to this repo, in `docs/india/`): `api-list.md` (every endpoint), `todo.md` (numbered tasks), `aws-hosting-plan.md`, `build-plan.md`.

**Commits** start with the task number from `todo.md`: `114 - Set custom permissions: PUT /admin/users/{id}/permissions`.

## What gets deployed

| Part | AWS service | Notes |
|---|---|---|
| API | API Gateway HTTP API → Lambda (Node 24, ARM) | [Hono](https://hono.dev) app in `src/` |
| Login | Cognito (Essentials): a **staff** pool and a **patient** pool | No self sign-up; **TOTP 2FA required**; no SMS |
| Database | Aurora DSQL | Serverless SQL, encrypted, deletion protection on; IAM-token login, no passwords |
| Migrations | Lambda run by a CDK Trigger on deploy | Only this function logs in as the DSQL admin; the API uses `ehr_app` (no DELETE) |
| Files | S3 | Private, versioned, encrypted, **Object Lock** (dev: governance 1 day; prod: compliance 10 years); Glacier IR after 90 days; copied to the backup account |
| Exports | S3 | Short-lived copies (record-copy PDFs, FHIR exports), deleted after 7 days |
| Website | S3 + CloudFront | Private bucket, HTTPS, security headers; frontend repo uploads with its own limited role |
| Jobs | EventBridge → the API Lambda | One rule per nightly/monthly job, off until the job is built |
| Backup 1 | S3 in AWS account 2 (`ehr-backup-<stage>` stack) | Object Lock; the app account can add, never delete; read-only user for the hospital PC (Backup 2) |
| Audit | CloudTrail | All regions, log file validation, kept 400 days |
| Monitoring | CloudWatch alarm → SNS email | Any API error emails `ALERT_EMAIL` |
| Logs | CloudWatch Logs | Kept 1 year (CERT-In requires ≥ 180 days, in India) |

Routes and who may call them (every endpoint: `docs/india/api-list.md`):

| Route | Who |
|---|---|
| `GET /health` | Anyone (no data) |
| `/staff/*` | Workforce: admin, head_doctor, doctor, nurse, staff, medical. **Shared endpoints; each one checks its own permission** |
| `/admin/*` | Management: admin, head_doctor (some endpoints admin only) |
| `/patient/*` | Patient pool token; own (and linked family) records only |
| `/other/insurance/*` | Insurance agents; linked patients, insurance section only |
| `/other/gp/*` | Referring GPs; own referrals only |
| `POST /other/share/*` | Anyone with a record-copy link + OTP (no login) |

API Gateway checks the token (staff or patient pool). Then `requireUser(pool, groups)` in `src/middleware/auth.ts` re-checks the pool and the Cognito group for each prefix.

## Project layout

```
.githooks/pre-commit           runs `npm run check` before every commit
.github/workflows/deploy.yml   `npm run check` on every push (any branch) and PR; deploy on main (GitHub OIDC, no stored AWS keys)
infra/                         AWS infrastructure (CDK, TypeScript; its own package.json)
  app.ts                       entry: app stack per stage, plus the backup-account stack
  config.ts                    stage settings (cdk.json context) and fixed resource names
  ehr-stack.ts                 wires the constructs together, prints outputs
  backup-stack.ts              Backup 1 bucket in AWS account 2
  constructs/
    auth.ts                    Cognito pools, staff groups
    database.ts                Aurora DSQL cluster
    migrations.ts              migration Lambda + deploy trigger
    files.ts                   files + exports buckets, replication
    website.ts                 website bucket, CloudFront, config.json
    frontend-deploy-role.ts    role for the frontend repo's GitHub Actions
    backend-function.ts        how every Lambda from src/ is built
    api.ts                     API Lambda, HTTP API, JWT authorizers, CORS, rate limits, access logs
    jobs.ts                    EventBridge schedules
    audit-trail.ts             CloudTrail
    monitoring.ts              error alarm → email
  test/                        CDK assertion tests
src/                           the API
  app.ts                       builds the app and mounts modules
  handler.ts                   Lambda entry: HTTP requests and scheduled jobs
  migrate.ts                   migration Lambda entry
  server.ts                    local dev server
  config/env.ts                validated environment variables
  db/client.ts                 DSQL connection
  db/migrations.ts             database changes, in order
  db/migrate.ts                runs pending migrations
  jobs/index.ts                scheduled jobs
  middleware/auth.ts           current user from the verified token
  middleware/errors.ts         one error format: { error, message }
  modules/<name>/              one folder per feature (routes, then service/repository as they grow)
test/                          Vitest tests
```

Rules for new code:

- **One feature = one folder** in `src/modules/` (for example `patients/`, `billing/`).
- **No deletes.** The app never deletes records or files: corrections are new versions, and every change is audit-logged.
- **Errors** are thrown as `AppError(status, code)` and returned as `{ "error": code }`.
- **Config** is read only through `src/config/env.ts`.
- **Database changes** only as a new entry in `src/db/migrations.ts`; never edit one that has run.

## Deploying

Deploys run **from GitHub Actions only**. Nobody needs AWS keys on a laptop.

1. Every push to any branch, and every pull request, runs `npm run check`: all typechecks, all tests, and `cdk synth`. Nothing deploys unless it passes.
2. A merge to `main` also deploys the **dev** stack (`ehr-dev`) in ap-south-1. Migrations run during the deploy.
3. The run summary (Actions tab) shows every output: website URL, API URL, Cognito IDs, bucket names, role ARNs.
4. Copy `WebsiteBucket`, `WebsiteDistributionId` and `FrontendDeployRoleArn` into the frontend repo's secrets (once).

Repository secrets (Settings → Secrets and variables → Actions → Secrets):

| Secret | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | ARN of the IAM role `ehr-github-deploy` (trusts only this repo's `main` branch) |
| `ALERT_EMAIL` | Email address for error alerts |

Protect `main` (Settings → Branches): require a pull request with 1 approval, and block force pushes.

The frontend repo's name is set in `infra/cdk.json` (`frontendRepo`, default `akshat17-07/ehr-frontend`); only its `main` branch can upload the website.

**Backup account (later, once):** deploy `ehr-backup-dev` with account 2's credentials (`-c backupAccountId=<account 2> -c appAccountId=<account 1>`), then add `-c backupAccountId=<account 2>` to the app deploy so files start replicating.

## Running locally

Requires Node 24+ (the Lambda runtime; CI uses the same).

```
npm install
npm test          # unit tests
npm run typecheck
npm run dev       # API on http://localhost:3000, database in .data/db (see below)

cd infra
npm install
npm test          # infrastructure tests
npm run synth     # CloudFormation templates, no AWS access needed
```

### Tests before every commit

`npm install` turns on the git hook in `.githooks/` (the `prepare` script sets `core.hooksPath`). Before each commit it runs `npm run check`:

1. API typecheck + tests
2. infra typecheck + tests (they synth the real templates and check the safety rules)
3. `cdk synth`, which also bundles both Lambdas

If any step fails, the commit is refused. Install both folders first (`npm install` here and in `infra/`). CI runs the same command on every push.

Locally the database is **PGlite**: real Postgres compiled to WebAssembly, installed by `npm install` (no Docker, no AWS). With no `DSQL_ENDPOINT` set, `npm run dev` keeps it in `.data/db` (git-ignored; delete the folder to start empty) and applies every migration on start. Tests use an in-memory one, so every migration is tested against real Postgres. Two DSQL-only statements differ locally: `AWS IAM GRANT` is skipped and `CREATE INDEX ASYNC` becomes `CREATE INDEX` (`toPostgres` in `src/db/migrations.ts`).

Locally there is no API Gateway, so a test user is passed in a header (development only):

```
curl http://localhost:3000/staff/me -H "x-dev-user: test-sub|doctor@example.com|doctor"
curl http://localhost:3000/admin/me -H "x-dev-user: test-sub|admin@example.com|admin"
```

## Status

See `docs/india/todo.md`. Done: tasks 1–32 (infrastructure, routing, auth, migrations runner, jobs dispatcher, CI).
Next: task 50 onward (local database, audit log, permission engine), then the endpoint tasks from 100.
