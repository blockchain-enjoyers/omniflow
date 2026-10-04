# Omniflow — developer guide

How to run everything locally, run the tests, and run the API against a real network.

In local development every external service is **emulated** behind the same interface as the real one: Privy (sign-in and embedded wallets), ZeroDev (bundler and paymaster), email, and the on-ramp. The chain is a local anvil node — either built from source or a fork of Arbitrum Sepolia.

## Requirements

| Tool | Version | Used for |
|---|---|---|
| Node.js | 22 or newer | API, frontends, emulators, tests |
| Foundry (`forge`, `anvil`) | recent stable | contracts, local chain |
| PostgreSQL | 16 or 17 (both used) | API database; the user must be allowed to create databases |
| Chromium or Chrome | any recent | browser tests only |

## First setup

```bash
git clone git@github.com:blockchain-enjoyers/omniflow.git
cd omniflow
git submodule update --init --recursive   # contracts/lib: Kernel, account-abstraction, OpenZeppelin, solady, forge-std
npm install
```

The Solidity compiler is pinned to 0.8.28. `contracts/foundry.toml` points `solc` to a fixed path; to let Foundry install and use 0.8.28 itself, set:

```bash
export FOUNDRY_SOLC=0.8.28
(cd contracts && forge build)             # downloads solc once; the stack later builds offline
```

## Run the whole app with one command

```bash
export DEVSTACK_DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/omniflow_dev
npm run dev:stack
```

The database is **dropped and recreated on every start** (the chain is fresh too). To protect real data, its name must end in `_dev` or `_test`.

The command starts:

- anvil and the contract stack (EntryPoint v0.7, Kernel, `WeightedECDSAValidator`, test USDC, `ClaimEscrow`, a reference verifying paymaster);
- the Alto bundler with the ZeroDev RPC emulator in front of it — operations take the same path they will take through ZeroDev;
- the Privy emulator and the on-ramp emulator;
- the API with its scheduler (indexer, keeper, recurring payouts);
- the dashboard and the claim page.

It then creates a demo organisation, **"Demo DAO", 2 of 3**, through the regular HTTP API, puts 100,000 test USDC on its account and gives it three months of history, so there is something to look at right after signing in:

- July, August and September contributor payouts and a hackathon prizes payout — paid to addresses, claimed by email link, one link that expired and returned, one still unclaimed, one row waiting for details;
- a W-9 received and a W-8BEN requested, a monthly schedule, a filled address book, reports and the activity log;
- today: the October payout waiting for its second signature (sign in as `boris@demo.test` or `vera@demo.test` to send it).

On the local chain the history happens on its real dates: anvil starts 98 days ago and its clock is moved forward between the steps; the timestamps the API records are moved to the same dates. On a fork (`STACK=fork`) the same history is created with today's date.

| What | URL |
|---|---|
| Dashboard (choose "Demo") | http://localhost:5173 |
| Demo mailbox: sign-in codes and every email | http://localhost:5173/?mode=demo#/demo/mailbox |
| Claim page | http://localhost:5174 |
| API | http://localhost:3001 |
| Privy emulator | http://localhost:3010 |
| On-ramp emulator | http://localhost:3020 |
| ZeroDev RPC emulator | http://localhost:3030 |
| Chain (anvil) | http://127.0.0.1:8545, chain id 31337 |

**Signing in:** choose "Demo", enter an email, take the code from the demo mailbox.

| Demo account | Role |
|---|---|
| `ops@demo.test` | operator and admin |
| `anna@demo.test`, `boris@demo.test`, `vera@demo.test` | approvers (threshold 2) |

**Live example without sign-up:** "Open a live example" on the first page builds a separate organisation for each visitor (the visitor plus two simulated approvers, 2 of 3) with one payout already carried through: one recipient paid to an address, one link unclaimed, one row waiting for details, one expired link refunded. Building an example moves the demo chain clock forward by a day, because the escrow refunds only by block time.

Stop everything with `Ctrl+C`.

### Options

| Variable | Effect |
|---|---|
| `STACK=fork` | anvil forks Arbitrum Sepolia and uses the deployed EntryPoint, Kernel 0.3.1, validator and Circle USDC; only the escrow and the paymaster are deployed |
| `FORK_URL` | RPC for the fork (default: `https://sepolia-rollup.arbitrum.io/rpc`) |
| `AA=self` | no bundler: the API calls `EntryPoint.handleOps` itself (default is the ZeroDev path through Alto) |
| `SEED=0` | start without the demo organisation |
| `HISTORY=0` | the demo organisation without its three months of history |
| `EXAMPLES=0` | turn the live example off |
| `EXAMPLE_POOL` | how many live examples to keep ready in advance (default 0: each is built on the click, in about 3 seconds). Every example moves the demo chain clock a day forward, so a pool built at start would put payment dates ahead of today |
| `FOUNDRY_BIN` | directory with `anvil` and `forge` |
| `ALTO_LOG_LEVEL`, `ALTO_LOG_FILE` | bundler logging |
| `DEV_MAILBOX_FILES` | where the demo mailbox keeps email attachments (default: the OS temp directory); the database keeps only their name, size and SHA-256 |

### Example CSV for a payout

Columns: `name,email,address,chain_id,amount[,category]`. A row without address and email waits for payment details. In the demo network `chain_id` is `31337`; a row on another chain is not sent and is shown as such on the review screen.

```csv
name,email,address,chain_id,amount,category
Alice,alice@example.com,0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc,31337,1500,grant
Bob,,0x976EA74026E726554dB657fA54763abd0C3a0aa9,31337,750.50,bounty
Carol,carol@example.com,,31337,300,bounty
Erin,,,31337,200,contributor
```

The import also accepts real spreadsheet exports: BOM, comma / semicolon / tab, quoted cells, column aliases in any order, optional `chain_id`, amounts like `1 500,50` or `$1,000.00`.

### Hosted demo

The same stack can run on a host that exposes one port (Railway, Fly, a VM). `Dockerfile.demo` holds everything it needs: anvil and forge, solc, the contracts built at image time. Postgres comes from the host.

```bash
docker build -f Dockerfile.demo -t omniflow-demo .
docker run -e PUBLIC_URL=https://demo.example -e DEVSTACK_DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/omniflow_dev -p 8080:8080 omniflow-demo
```

With `PUBLIC_URL` set, a gateway on `PORT` (default 8080) serves every browser-facing service from that one origin, by path:

| Path | Service |
|---|---|
| `/` | dashboard |
| `/claim/` | claim page |
| `/api/` | API |
| `/privy/` | Privy emulator |
| `/onramp/` | on-ramp emulator |
| `/rpc` | chain RPC, public subset: read methods and signed transactions; not `anvil_*` / `evm_*`, not `eth_sendTransaction`, not transactions from the stack's own accounts (their keys are anvil's public development keys) |

- Links in emails point to `PUBLIC_URL`. The seed and live examples reach the services inside the machine.
- `TRUST_PROXY` (default 1): how many proxies of the host sit in front of the gateway, so per-visitor limits see the visitor.
- Every start recreates the database and the chain and seeds the demo history again (a few minutes): nothing survives a restart.
- Anyone with the link can read the demo mailbox — sign-in codes included. That is the demo's design: test money only.

## Tests

```bash
export FOUNDRY_SOLC=0.8.28
export TEST_DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/omniflow_test   # recreated; must end in _test
export CHROMIUM_PATH=/path/to/chromium                                         # browser tests; default /opt/pw-browsers/chromium

(cd contracts && forge test)              # escrow unit, fuzz and invariant tests; Kernel 2-of-3; TS↔Solidity fixture
(cd packages/shared && npx vitest run)    # manifest, batch calldata, approval hash, claim link, review
(cd apps/privy-emulator && npx vitest run)
(cd apps/api && npx vitest run)           # the whole sender side over HTTP on anvil, incl. an ERC-7562 trace check
(cd apps/api && AA=zerodev npx vitest run) # the same through Alto and the ZeroDev RPC emulator
(cd apps/web && npx vitest run)           # the whole app in a browser, every screen at 390 px, the live example
(cd apps/claim && npx vitest run)         # claim page in a browser without the API; wallet on another network
```

- `SCREENSHOTS_DIR=/some/dir` with the dashboard test also saves a desktop and a phone screenshot of every screen.
- `STACK=fork` runs the API, dashboard and claim tests on an Arbitrum Sepolia fork.
- Kernel tests against deployed bytecode: `(cd contracts && forge test --match-contract KernelPayout --fork-url https://sepolia-rollup.arbitrum.io/rpc)`; `KERNEL=0.3.3` runs the same suite against 0.3.3 instead of 0.3.1.
- `UPDATE_FIXTURE=1` regenerates the shared TS↔Solidity fixture.

## Real setup

The code does not change between emulated and real; only environment variables do. Templates: `apps/api/.env.example`, `apps/web/.env.example`, `apps/claim/.env.example`.

| Emulated | Real |
|---|---|
| `PRIVY_EMULATOR_URL` | `PRIVY_APP_ID` and `PRIVY_VERIFICATION_KEY` (API), `VITE_PRIVY_APP_ID` (both frontends) |
| ZeroDev RPC emulator over Alto | `ZERODEV_RPC` — the project RPC from dashboard.zerodev.app (bundler and paymaster in one URL); a gas sponsorship policy must be enabled there. Alternatives: `BUNDLER_URL` + `PAYMASTER_URL` (ERC-7677) |
| anvil | `CHAIN_ID`, `RPC_URL`, `ENTRYPOINT`, `KERNEL_FACTORY`, `WEIGHTED_VALIDATOR`, `ESCROW`, `TOKEN` — check every address with `eth_getCode` on the target network first |
| demo mailbox (`DEV_ENDPOINTS=1`) | an email provider (not wired in yet: in the real mode emails are not sent) |
| `ONRAMP_EMULATOR_URL` | an on-ramp partner (not chosen yet; without it the buy button is hidden) |
| hashes without links | `EXPLORER_URL` (API, payment records) and `VITE_EXPLORER_URL` (dashboard): `https://sepolia.arbiscan.io` or `https://arbiscan.io` |

Secrets — `SUBMITTER_PRIVATE_KEY` (an EOA that only pays gas to relay already-signed operations) and `CLAIM_KEY_ENCRYPTION_KEY` (32 bytes hex) — come from a secret manager, never from files in the repository.

### API

The API and its scheduler run as one container:

```bash
docker build -f Dockerfile.api -t omniflow-api .   # behind a TLS-intercepting proxy: --secret id=ca,src=/path/ca.crt
docker run --env-file api.env -p 3001:3001 omniflow-api
```

- The database schema is applied on start; `SIGTERM` stops it gracefully.
- `GET /health` returns 200 or 503 for a load balancer; the body reports the database, RPC, bundler, submitter ETH, stuck batches and indexer lag.
- Alerts go to the log (JSON) and to `ALERT_WEBHOOK_URL` (Slack-style `{"text": "..."}`).
- Behind a proxy set `TRUST_PROXY` so rate limits count clients, not the proxy. Allowed browser origins are those of `APP_URL`, `CLAIM_BASE_URL`, `FORM_BASE_URL`, plus `CORS_ORIGINS`.

Without Docker: `npm run start -w @omniflow/api` with the same variables.

### Frontends

Both are static builds served by any static host:

```bash
npm run build -w @omniflow/web     # dashboard → apps/web/dist
npm run build -w @omniflow/claim   # claim page → apps/claim/dist
```

Values are taken from the `.env` files next to them (public values only). The claim page works without any Omniflow service: with only an RPC it can claim with the recipient's own wallet.

### Contracts

`ClaimEscrow` is deployed with CREATE2, so the address is the same on every chain for the same token list:

```bash
cd contracts
ESCROW_TOKENS=0xTokenA,0xTokenB forge script script/DeployEscrow.s.sol \
  --rpc-url $RPC_URL --private-key $DEPLOYER_KEY --broadcast
```

The script refuses tokens that have no code on the target chain. Put the printed address into `ESCROW`.

## Documents

- **Payment record** — `GET /payments/:rowId/record.pdf`, built with `pdf-lib` (A4, Helvetica) from the same lines as the record page in the dashboard.
- **Tax forms from recipients** (W-9, W-8BEN, W-8BEN-E) — requested from the record page; the recipient picks the form, downloads the official blank and uploads the signed PDF. The file is emailed to the address in *Settings → Documents*; the API keeps only the form type, the date and the SHA-256.
- **Year-end Form 1099-NEC** — *Reports → Year-end forms*: Copy B (for the recipient) and its instructions page, filled for each recipient with a W-9 on file. Box 1 is the sum of the year's payments from the payment data; TINs and addresses are typed in and not stored. Copy A is never produced.
- The official IRS PDFs are kept unchanged in `apps/api/assets/irs/`; their source URL, revision and SHA-256 are in `apps/api/src/documents/irs.ts`.

## Repository layout

| Path | What |
|---|---|
| `contracts/src/ClaimEscrow.sol` | the only own contract on the money path: claim with the key from the link, refund, rekey, auto-refund; no admin |
| `contracts/script/` | `LocalStack` (stack from source), `ForkStack` (escrow and paymaster on a fork), `DeployEscrow` (CREATE2) |
| `packages/shared` | payout manifest, Kernel `execute(BATCH\|TRY)` calldata, approval hash, account `initData`, claim link, review screen |
| `packages/ui` | shared visual language of both frontends: tokens, light and dark theme, components, mobile layout |
| `packages/auth-client` | sign-in for both frontends: Privy or the emulator behind one interface |
| `packages/devchain`, `packages/devmail` | anvil and deployment, test money (anvil only), demo mailbox |
| `apps/api` | NestJS + Postgres: auth, roles, organisation setup, payouts, review, batches, N-of-M signatures, paymaster, indexer, emails, details forms, revoke and rekey, keeper, reports, audit log, on-ramp, rate limits |
| `apps/web` | dashboard; also the details form and the demo mailbox |
| `apps/claim` | static claim page |
| `apps/privy-emulator`, `apps/onramp-emulator`, `apps/zerodev-emulator` | emulators; the ZeroDev one answers `zd_*` and passes standard ERC-4337 methods to the real Alto bundler |
| `apps/devstack` | `npm run dev:stack` orchestrator, demo data and the live example |

## Windows

The project is developed on Linux and macOS. On Windows it runs with these adjustments:

- `FOUNDRY_BIN` must point to the Foundry directory, e.g. `C:/Users/you/.foundry/bin` — the default is a Linux path.
- `FOUNDRY_SOLC=0.8.28` (see above) — `foundry.toml` points to a Linux path.
- The stack and the browser tests start `npx` without a shell, which fails on Windows (`spawn npx ENOENT`). Run them from WSL, or patch the calls to pass `shell: true` on `win32`.
- `localhost` resolves to `::1`, while the claim page test reaches its preview server at `127.0.0.1`.
- Hyper-V / Docker may reserve TCP ports in the 5300–5600 range the claim page test picks from (`listen EACCES`); rerun the test, or check `netsh int ipv4 show excludedportrange protocol=tcp`.
