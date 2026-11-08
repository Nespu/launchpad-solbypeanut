# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Token creators who use Wire to create and manage Solana tokens, pools, wallets, and trading activity. (Confirmed by the product roadmap.)

## Product Purpose

Wire provides a Devnet launchpad and wallet tools for creating Solana tokens, configuring liquidity, and reviewing operations. Success means users can understand, review, and verify each operation before signing it. (Confirmed by the roadmap and existing workflows.)

## Positioning

Wire keeps launch and wallet activity reviewable in the browser, verifies confirmed chain results before recording them, and does not represent a user's own trades as independent demand. (Confirmed by the roadmap and existing implementation.)

## Operating Context

Users connect a Solana wallet, work on Devnet, review transactions in their wallet provider, and may manage additional project wallets whose keys are encrypted locally in the browser. Transfers and swaps are manually approved by default. A narrowly scoped automation run may be enabled only after a separate, explicit per-run confirmation that names every wallet, amount, quote limits, fees, network, aggregate cap, and consecutive confirmed-error limit. It stops on quote drift, a connection or preparation failure, an uncertain or pending signature, vault lock, or page close; only a confirmed on-chain failure may be skipped to the next already reviewed wallet, up to the authorized limit. A failed wallet is never automatically retried, and a run never resumes after reload. (Confirmed by the current multiwallet workflow, Vortex task documentation, and roadmap.)

## Capabilities and Constraints

- The current supported environment is Solana Devnet; do not imply Mainnet support.
- Preserve the planned Svarog/Vortex-inspired capabilities as staged roadmap work; do not present incomplete controls as available.
- Wallet balances and public addresses can be read for account management. Private keys must not be sent to the backend.
- Do not simulate market demand, manufacture volume, or hide wallet relationships.
- Token Disperse transfers to explicit public addresses or other project-vault wallets in simulated, manually reviewed batches signed by the selected wallet in the browser. It can generate a selected count of recipient wallets inside the encrypted local vault; creation moves no funds and adds those addresses to the recipient list. It can generate editable per-recipient amounts inside a minimum/maximum percentage range of the mint's current supply, using Devnet mint data and secure randomness; the maximum aggregate is bounded to 100%, and the total must fit the source balance. An optional equal SOL amount can be sent to each recipient from the selected source wallet in the same simulated, browser-signed token batch. The user can choose one to four recipients per batch. Between confirmed batches, an adjustable base delay of 0–300 seconds plus 0–120 seconds of random jitter gates the next manual review, even after reloading; the timer never signs or sends. A per-run limit of 0–5 consecutive confirmed on-chain failures can be configured; only confirmed failures within that limit are skipped, never retried, and every next batch still requires a manual signature. Pending or uncertain outcomes stop the run. Generated wallets stay under the user's local vault control; show their relationship to the source and the complete funding/fee review before signing. Either the connected wallet or a local-vault wallet can be selected as the source; the review preserves its type and address, and that wallet signs each manually approved batch.
- The source task catalog also includes persistent tasks such as Snipe, Anti-Sniper, Migrate & Buy, Holder/Pro Trader Boost, Hand Switcher, wallet warm-up, limit orders, Ladder, Mirror, DCA, trailing stop and scheduled launch. These are full staged-scope items, not removed. Preserve local signing and truthful attribution. Fake Volume and Mixer remain explicitly recorded for product review because they conflict with Wire's stated principle not to manufacture demand or hide wallet relationships.
- `/tasks` currently lists strictly validated multiwallet swap sequences stored in this browser, filters them by state, and links back to the token page to review or continue them. Persisted runs distinguish ready, running, paused, stopped, completed and failed; a restored running task becomes paused and requires fresh authorization before it can continue. The task list never starts or signs a task. Any automated run remains a separate, explicit authorization and signs locally from the unlocked vault while the page stays open.

## Evidence on Hand

- The current interface, wallet and liquidity workflows, and `WIRE-ROADMAP-STATUS.md` in this project.
- The user's Svarog/Vortex walkthrough references and product decisions in this conversation.
- Official Svarog documentation: https://svaroglauncher.com/docs
- Official Vortex Token Sender documentation: https://www.vortexdeployer.com/docs/tasks/token-sender
- Official Vortex task lifecycle documentation: https://www.vortexdeployer.com/docs/tasks/overview

## Product Principles

- Show the network, source wallet, destinations, amounts, and estimated costs before signing.
- Keep explicit approval as the default for each on-chain operation. A multi-operation run requires a separate, bounded, per-run authorization over the exact reviewed wallet list, aggregate cap, and failure-continuation policy.
- Explain partial completion and never automatically resend a transaction with an uncertain result.
- Distinguish wallet funding, token transfers, and market purchases.
- Report only balances and activity that Wire can verify.
