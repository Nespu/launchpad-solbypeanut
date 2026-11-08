# Wire UI redesign — research and starting directions

**State:** research only. This is a preparation brief, not approval to replace the current interface.

## When to start the redesign

The best point is after the remaining product flows stop changing and before the final responsive review. That gives the redesign a stable feature map and lets us review desktop and mobile together instead of styling unfinished flows twice. Until then, new features should follow the current Wire interface.

## Evidence reviewed

- The Svarog/Vortex tutorial and screenshots supplied in this conversation. They are useful workflow references for the five-step launch, wallet groups, buy modes, and launch tools; they are not a visual template to copy.
- [Jupiter](https://jup.ag/) groups a large product into Trade, Earn, Manage, and other task areas while keeping the active swap central. Its structure is useful for Wire's growing toolset.
- [Raydium Liquidity](https://v2.raydium.io/liquidity/add/) keeps balances, `Max`/`Half`, the liquidity form, and the user's positions close together. Raydium's [pool creation flow](https://v2.raydium.io/liquidity/create/) makes advanced work a visible sequence of steps.
- [Raydium's liquidity guide](https://github.com/raydium-io/raydium-docs-v1/blob/main/user-flows/add-remove-liquidity.mdx) separates the entered LP amount from the estimated underlying assets and asks users to review the outputs before signing.
- [Phantom's transaction-preview explanation](https://phantom.com/learn/blog/security-at-phantom) emphasizes readable transaction context and clear warnings at the point of approval. Wire should show its own review before Phantom opens, then leave the final approval to the wallet.
- The official [Solana Next.js guide](https://solana.com/docs/frontend/nextjs-solana) and [Metaplex Next.js templates](https://www.metaplex.com/docs/solana/templates/metaplex-nextjs-tailwind-template) are useful for wallet and framework patterns. They are starter code, not a finished product design; replacing Wire's stack just to adopt their UI would add risk without solving the visual brief.

## What the local design skills suggest

- UI/UX Pro Max matches a financial dashboard with **Dark Mode OLED + Data-Dense Dashboard**, with Minimalism/Swiss and Accessible & Ethical as useful secondary references.
- The style search found generic matches such as data-dense, OLED, and Bento. It did **not** find a launchpad-specific visual style. Its first generated page pattern, “Enterprise Gateway,” is a marketing/conversion layout and does not fit Wire's operating screens, so it should not be used.
- Impeccable's product context describes Wire as a Devnet operations tool where users inspect an operation, understand its effects, and approve it in their wallet. The eventual visual concept should make that review loop the signature interaction.

## Three visual directions to compare later

| Direction | Visual language | Strength | Risk |
|---|---|---|---|
| **Signal Console** — provisional recommendation | Graphite and warm light text, one vivid signal-green action color, restrained violet only for wallet/provider identity; fine rules and compact data, with a deliberate typographic scale. | Keeps the launchpad's technical character while making wallet, network, fees, and irreversible actions easier to scan. | Needs enough quiet space so dense screens do not become another wall of cards. |
| **Launch Studio** | Neutral ink/stone canvas, strong editorial headings, green used only for active network and primary action, larger token previews and progress steps. | Makes creation feel approachable and gives metadata, supply, and launch decisions a clearer narrative. | Could make trading and wallet-management screens feel too spacious or slow. |
| **Night Terminal** | Deep black, crisp mono data labels, restrained cyan/purple market accents, dense tables and a compact command-like workspace. | Familiar to advanced multiwallet users and well suited to activity, market, and automation tools. | Can read as a generic bot console; neon and tiny text hurt readability if overused. |

These are directions to test against real Wire screens, not final palette or font decisions. The user's choice about retaining the existing name, mark, and green identity is still open for the redesign kickoff.

## Proposed information architecture

Use a small persistent workspace shell and group the existing capabilities by the job the user is doing:

1. **Launch** — create token, configure market and liquidity, select wallet strategy, review and sign.
2. **Wallets** — connected wallet, project vault, balances, funding, transfer/disperse.
3. **Trade** — token buy/sell, multiwallet execution, alerts, and supported venues.
4. **Liquidity** — pools, LP balance, withdraw, burn, and temporary lock.
5. **Activity** — verified transaction history, external activity checks, FIFO cost basis, and portfolio view.

Keep network, active wallet, identification/session status, and RPC health visible in the shell. Keep advanced tools inside the relevant job rather than exposing every tool as an equal top-level link. On mobile, use a compact task navigation and one active workflow at a time; never compress desktop tables into a horizontally scrolling page when cards can express the same data.

## Launch flow concept

The final step names should be confirmed against the complete Svarog/Vortex walkthrough. A first Wire draft can retain five deliberate stages:

1. **Identity** — name, symbol, description, image, and links.
2. **Market setup** — supply, pair currency, creator-reward choices, and initial liquidity.
3. **Buy strategy** — Dev, bundle, timed buys, and other launch execution modes that Wire actually supports.
4. **Wallets and safety** — choose the participating wallets, amounts, timing, and relevant risk controls.
5. **Review and sign** — one readable summary of every wallet, asset movement, fee, order, and transaction; then open the wallet for explicit approval.

Treat this as a provisional map, not a claim that these are the exact original Svarog step labels. Keep a persistent progress rail on desktop, a compact step header on mobile, a live token preview, and one sticky primary action. The review step should be the strongest and most consistent screen in the product.

## Interaction rules worth carrying into the redesign

- Every chain action states **network, source wallet, recipient, token, amount, expected result, fees, and reversibility** before opening Phantom.
- A quote, simulation, signed transaction, confirmed transaction, and history registration are distinct states. The UI should name each one and offer retry actions that cannot silently resubmit a transaction.
- Pool operations should show the LP amount and the estimated underlying assets side by side, label estimates as estimates, and refresh on-chain balances after confirmation.
- Multiwallet tools should show each wallet as a separate reviewed operation. No automatic signing or sending between steps.
- Distinguish connected and vault wallets visibly without exposing private keys or implying that grouped wallets are unrelated.
- Use concise explanations next to unfamiliar choices and a deeper guide behind disclosure, rather than long warning paragraphs on every screen.
- Mobile-first review targets: 375, 768, 1024, and 1440 px; minimum 44 px touch controls; no modal or sticky footer may cover the focused field.

## Template and reuse recommendation

Use the official Solana and Metaplex starters as references for wallet-provider composition and Next.js conventions only. Wire already has wallet adapters, vault signing, localization, route logic, and transaction review; wholesale starter replacement would discard product-specific safety work. During the redesign kickoff, make a small set of Wire-native screen comps first: the launch wizard, manage-liquidity workspace, token detail/trading screen, and wallet activity. Then extract shared tokens/components from those approved screens.

## Redesign kickoff checklist

- Confirm which brand elements stay: name, logo, green, English/Spanish language model.
- Freeze the five-step workflow and map every Svarog/Vortex capability to a Wire screen.
- Pick one of the three visual directions after comparing the same four screen types.
- Create desktop and mobile comps, including loading, empty, error, pending, success, and irreversible-action states.
- Keep chain behavior and wallet-review flows unchanged while replacing the visual layer.
- Inspect the finished UI in a browser at desktop and mobile sizes before marking responsive review complete.
