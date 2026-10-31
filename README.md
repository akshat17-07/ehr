# EHR backend

Backend for a single-hospital EHR in Madhya Pradesh: an API on AWS Lambda plus the AWS infrastructure that runs it.
Everything runs in **AWS Mumbai (ap-south-1)**, serverless, with no servers to maintain.

Design documents (outside this repo): `docs/india/aws-hosting-plan.md`, `docs/india/build-plan.md`, `docs/india/2-day-dev-plan.md`.

## What gets deployed

| Part | AWS service | Notes |
|---|---|---|
| API | API Gateway HTTP API → Lambda (Node 22, ARM) | [Hono](https://hono.dev) app in `src/` |
| Login | Cognito (Essentials): a **staff** pool and a **patient** pool | No self sign-up; **TOTP 2FA required**; no SMS |
| Database | Aurora DSQL | Serverless SQL, encrypted, deletion protection on; IAM-token login, no passwords |
| Files | S3 | Private, versioned, encrypted, **Object Lock** (dev: governance 1 day; prod: compliance 10 years) |
| Monitoring | CloudWatch alarm → SNS email | Any API error emails `ALERT_EMAIL` |
| Logs | CloudWatch Logs | Kept 1 year (CERT-In requires ≥ 180 days, in India) |

Routes and who may call them:

| Route | Who |
|---|---|
| `GET /health` | Anyone (no data) |
| `/api/*` | Staff pool token (checked by API Gateway, then the pool is re-checked in `src/middleware/auth.ts`) |
| `/portal/*` | Patient pool token |

## Project layout

```
.github/workflows/deploy.yml   test on every push/PR; deploy on main (GitHub OIDC, no stored AWS keys)
infra/                         AWS infrastructure (CDK, TypeScript)
  app.ts                       entry: one stack per stage
  ehr-stack.ts                 wires the constructs together, prints outputs
  constructs/
    database.ts                Aurora DSQL cluster
    files.ts                   S3 files bucket
    auth.ts                    Cognito pools, staff groups
    api.ts                     Lambda, HTTP API, JWT authorizers, rate limits, access logs
    monitoring.ts              error alarm → email
src/                           the API
  app.ts                       builds the app and mounts modules
  handler.ts                   Lambda entry
  server.ts                    local dev server
  config/env.ts                validated environment variables
  db/client.ts                 DSQL connection
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

## Deploying

Deploys run **from GitHub Actions only**. Nobody needs AWS keys on a laptop.

1. A push or pull request runs typecheck + tests.
2. A merge to `main` also deploys to the **dev** stack in ap-south-1.
3. The run summary (Actions tab) shows the API URL, Cognito pool/client IDs, DSQL endpoint and bucket name.

Repository secrets (Settings → Secrets and variables → Actions → Secrets):

| Secret | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | ARN of the IAM role `ehr-github-deploy` (trusts only this repo's `main` branch) |
| `ALERT_EMAIL` | Email address for error alerts |

Protect `main` (Settings → Branches): require a pull request with 1 approval, and block force pushes.

## Running locally

Requires Node 22+.

```
npm install
npm test          # unit tests
npm run typecheck
npm run dev       # API on http://localhost:3000
```

Locally there is no API Gateway, so a test user is passed in a header (development only):

```
curl http://localhost:3000/api/me -H "x-dev-user: test-sub|admin@example.com|admin"
```

`npm run synth` builds the CloudFormation template without deploying (no AWS access needed).

## Status

Done: infrastructure, routing, auth middleware, error handling, tests, CI/CD.
Next: database migrations and the `ehr_app` role (no DELETE), `save()` with version history + hash-chained audit log, then users, patients, visits, files, billing.
