# Omniflow

**A payout engine with the documents built in.** You pay many people from one account, and each payment produces its own record: who asked for it, who approved it, the amount, the date and the transaction hash. The tax forms a payment needs are part of the same flow.

[Pitch video](https://www.youtube.com/watch?v=DLH3iBm0F7o) · [Developer guide](README.DEV.md) · [Tell us what you think](https://docs.google.com/forms/d/e/1FAIpQLSctmQsrwjFSDQLeN8fPYaNhO669yKvvqBY7lV7uiIYcECPQLA/viewform)

## What works

Run it locally and all of this is there, with a demo organisation, 2 of 3, and three months of history already in it. There is also a live example you can open without signing up.

**Paying**

- Sign in by email. Create an organization, name the approvers, each one signs the member set.
- Upload a CSV. The review screen holds back any row that is missing something, by name and reason.
- Approve. Each approver signs the batch, and approvals are bound to the call data.
- Send. Money goes to addresses, and rows that only have an email go to an escrow.
- Claim. The recipient opens the link, signs in by email, and receives into an embedded wallet. Claiming also works without us: the link, any RPC, and their own wallet.
- Unclaimed money returns to the payer after the deadline, judged by chain time. There is no admin path that can move it.

**Documents**

- A payment record for every row, as a page and as a PDF. `GET /payments/:rowId/record.pdf` is built with pdf-lib, not by printing a page.
- Tax forms from recipients. The payer requests a W-9, W-8BEN or W-8BEN-E. The recipient picks the one that applies, downloads the official IRS blank unchanged, and uploads the signed PDF. The file is emailed to the address set in Settings. We keep only the form type, the date and a SHA-256.
- Year-end forms. Form 1099-NEC, Copy B and its instructions page, filled for each recipient who has a W-9 on file. Box 1 is the year's payments. Copy A is never produced, because the IRS does not accept it printed from a download.
- A `DOCUMENT` column on the payout page and in the report, and an optional `doc_required` column in CSV import.
- The official IRS PDFs are kept unchanged in `apps/api/assets/irs`, with their source URL, revision and SHA-256.

We do not file anything, we do not withhold, and we do not tell anyone which form applies to them.

**Everything else**

Address book, repeat a payout with edits, schedules, members, settings, activity log, report with CSV export.

## What does not work yet

- **Nothing of ours is deployed to a public network.** Everything runs on a local chain or a fork.
- **Privy, ZeroDev, email and the on-ramp are emulated.** The ZeroDev emulator sits in front of a real Alto bundler, so operations take the same path, but it has never run against real ZeroDev.
- **A second signed batch with the same transfers would pay twice.** Only the backend prevents this today.
- **Two users at once is not tested.** There are no row locks in the API.
- **USD value is at par**, 1 USDC = 1 USD, labelled on screen as not a market quote.
- Receiver side is not built: recipient rules, profile, forwarding and cash out. Billing is not built.
- On Windows the stack starts `npx` without a shell and fails. Run it from WSL.

## What is ours, and what is not

Unmodified submodules: Kernel (zerodevapp), account-abstraction (eth-infinitism), OpenZeppelin, solady, forge-std. npm: NestJS, React, viem, `@privy-io/react-auth`, `@pimlico/alto`, jose, pg.

Everything else here was written from scratch during the Buildathon, starting 27 September. Nothing is carried over from our earlier project, [blockchain-enjoyers/payments](https://github.com/blockchain-enjoyers/payments). `ClaimEscrow` is ours and uses solady only for ECDSA, EIP712, SafeTransferLib and ReentrancyGuard.

The cross chain routing with automatic conversion mentioned in the pitch lives in that earlier project, which won the LI.FI track at ETHGlobal HackMoney in February 2026. It is not in this repository.

## Decisions we can defend

**The wedge.** Finance teams that pay many people in stablecoins. Paying people creates paperwork, and the more people you pay the more of it there is. Today you can have the paperwork, or you can keep your own wallet, not both: the services that collect a W-9 and file a 1099 hold your money and are funded in fiat, and the tools that pay from your own wallet gate on amount, asset, destination and signers, never on a document.

**Why on chain.** Take the contract away and "nobody can take this money back" becomes our promise instead of a property. The escrow has no admin withdrawal path, and the return of unclaimed funds can be triggered by anyone but only ever pays the payer.

**Why Arbitrum.** Gas is cheap and predictable, which matters when one payout is many transfers rather than one. The fork stack runs against the EntryPoint, Kernel and Circle USDC already deployed on Arbitrum Sepolia, and the Kernel suite is tested against that deployed bytecode. And the receiver leg we are building toward puts a recipient's money into whatever protocol they chose, right after they are paid, so we need those protocols in one place.

**What is out of scope for this Buildathon.** Receiver-side rules, profiles, cross chain legs and the yield leg: research turned up no buyer asking for them yet, so the build was frozen to the escrow, the claim flow, the record and the documents. The verifier and billing are out of scope too. Most of these three weeks went into talking to people and reading the market, and what we heard changed who we think the customer is, twice.

**Tradeoffs we are naming ourselves.** The claim link key is generated on the server, held encrypted until the email is sent, then deleted. If the backend were compromised, the exposure is limited to deposits whose keys have not yet been deleted. That is the weakest point in the design. The escrow has had no external audit and no deposit cap.

## What changed after each feedback session

- **Session 1.** Told the market we had picked was small and hard, and to find a different ideal customer. We scored our directions against each other and came back with five open hypotheses instead of one claim.
- **Session 2.** Three questions: regulation, the tax trail of moving stablecoins, and how we fit a treasury stack a company already runs. We came back with answers from primary sources, and the record became per payment.
- **Session 4.** Told to name one region, then decide whether to build the off chain part or plug into someone who already does it. The region is the United States. The documents a payment needs are now in the product, and the local expertise behind them should come from a partner who already does that work.

## Team

Two founders. First place on the LI.FI track at ETHGlobal HackMoney, February 2026.

## Tell us what you think

If you run this and something is confusing, broken or missing, we want to hear it: [two minute form](https://docs.google.com/forms/d/e/1FAIpQLSctmQsrwjFSDQLeN8fPYaNhO669yKvvqBY7lV7uiIYcECPQLA/viewform)
