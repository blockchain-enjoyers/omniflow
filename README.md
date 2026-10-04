# Omniflow

**A payout engine with the documents built in.** One list, one signature, and each payment produces its own record: who asked for it, who approved it, the amount, the date and the transaction hash. The tax forms a payment needs are part of the same flow.

[Pitch video](https://www.youtube.com/watch?v=DLH3iBm0F7o) · [Developer guide](README.DEV.md) · [Tell us what you think](https://docs.google.com/forms/d/e/1FAIpQLSctmQsrwjFSDQLeN8fPYaNhO669yKvvqBY7lV7uiIYcECPQLA/viewform)

## Who it is for

Finance teams at companies that pay many people in stablecoins. Today they pick who gets paid in a spreadsheet, chase a tax form from each person by hand, send the money, and then match it all up by transaction hash at the end of the quarter.

## What people use today

A free Safe sends money to addresses and leaves no paper at all.

Dots, Tipalti and Rise collect a W-9 or a W-8BEN and file the 1099, but they hold your money, they are funded in fiat, and they ask for the form once, when the person signs up.

Request Finance is accounts payable for crypto, with approvals. Its own help centre says an approval rule supports two parameters, Amount and Tag. Searching it for W-8BEN or 1099 returns nothing.

Den and Fordefi let you pay from your own wallet, and they gate on amount, asset, destination and signers. Never on a document.

**So today you can have the paperwork, or you can keep your own wallet. Not both.**

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
- The payer requests a W-9, W-8BEN or W-8BEN-E. The recipient picks the one that applies, downloads the official IRS blank unchanged, and uploads the signed PDF. The file goes to the address set in Settings. We keep only the form type, the date and a SHA-256.
- At the end of the year, Form 1099-NEC Copy B comes out filled for every recipient who has a W-9 on file, with box 1 taken from the payments themselves.
- A `DOCUMENT` column on the payout page and in the report, and an optional `doc_required` column in CSV import.
- The official IRS PDFs are kept unchanged in `apps/api/assets/irs`, with their source URL, revision and SHA-256.

We do not file anything, we do not withhold, and we do not tell anyone which form applies to them. Copy A of the 1099 is never produced, because the IRS does not accept it printed from a download.

**Everything else**

Address book, repeat a payout with edits, schedules, members, settings, activity log, report with CSV export.

## Where it stands

This is a pre-production build, put together from working parts to be shown rather than sold. Nothing of ours is on a public network yet, Privy, ZeroDev, email and the on-ramp run against emulators, and receiver-side rules are out of this scope. Two users at once is not tested, and a second signed batch with the same transfers would pay twice, prevented today only by the backend.

We are not satisfied with it, and we are already rebuilding. The next version is **document first, not crypto first**: a new frontend with an interface a finance person can read, and the paperwork, rather than the wallet, as the thing the product is organised around.

The local expertise behind those documents comes from a partner who already does that work. We are a technical team, not an accounting one.

## What is ours, and what is not

Unmodified submodules: Kernel (zerodevapp), account-abstraction (eth-infinitism), OpenZeppelin, solady, forge-std. npm: NestJS, React, viem, `@privy-io/react-auth`, `@pimlico/alto`, jose, pg.

Everything else here was written from scratch during the Buildathon, starting 27 September. Nothing is carried over from our earlier project, [blockchain-enjoyers/payments](https://github.com/blockchain-enjoyers/payments). `ClaimEscrow` is ours and uses solady only for ECDSA, EIP712, SafeTransferLib and ReentrancyGuard.

The cross chain routing with automatic conversion mentioned in the pitch lives in that earlier project, which won the LI.FI track at ETHGlobal HackMoney in February 2026. It is not in this repository.

## Decisions we can defend

**Why now.** Two things changed this year. Coinshift, a payout service that had moved about $1.5B, closed its payout product, and its customers were left without a tool. And since the end of last year, when a company in the United States pays a contractor, that payment is reported on its own, not at the end of the quarter. More payments, smaller payments, and the paper for each one still made by hand.

**Why on chain.** A record is only evidence if nobody can rewrite it. The payment, the approvals and the amount are fixed by the chain, and our record reads them rather than asserting them. Off chain, an auditor would be trusting our database.

**Why Arbitrum.** One payout is many transfers, so cheap and predictable gas is the difference between a batch worth running and one that is not. And the receiver leg we are building toward puts a recipient's money straight into whatever protocol they chose, which needs those protocols in one place.

**What is out of scope for this Buildathon.** Receiver-side rules, profiles, cross chain legs and the yield leg: research turned up no buyer asking for them yet, so the build was frozen to the escrow, the claim flow, the record and the documents. The verifier and billing are out of scope too. Most of these three weeks went into talking to people and reading the market, and what we heard changed who we think the customer is, twice.

**Tradeoffs we are naming ourselves.** The claim link key is generated on the server, held encrypted until the email is sent, then deleted. If the backend were compromised, the exposure is limited to deposits whose keys have not yet been deleted. That is the weakest point in the design. The escrow has had no external audit and no deposit cap.

**Money.** A subscription paid by the payer. Base $100 a month, Pro $500, custom above that. The person being paid never pays. We take no cut of the money that moves: moving money is free next to a Safe, and nobody will pay for it.

## What changed after each feedback session

- **Session 1.** Told the market we had picked was small and hard, and to find a different ideal customer. We scored our directions against each other and came back with five open hypotheses instead of one claim.
- **Session 2.** Three questions: regulation, the tax trail of moving stablecoins, and how we fit a treasury stack a company already runs. We came back with answers from primary sources, and the record became per payment.
- **Session 4.** Told to name one region, then decide whether to build the off chain part or plug into someone who already does it. The region is the United States. The documents are now in the product, and the local expertise behind them should come from a partner.

## Team

Two founders. First place on the LI.FI track at ETHGlobal HackMoney, February 2026.

## Tell us what you think

If you run this and something is confusing, broken or missing, we want to hear it: [two minute form](https://docs.google.com/forms/d/e/1FAIpQLSctmQsrwjFSDQLeN8fPYaNhO669yKvvqBY7lV7uiIYcECPQLA/viewform)
