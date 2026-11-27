# Enoch signing page

A minimal, single-purpose static page. It does one job: create a Hedera HCS topic, then submit one message to it. All signing happens in the user's HashPack wallet over WalletConnect. There is no backend, no build step, and no key material anywhere in this directory.

## Files

- `index.html`: the page. Shows the connected account, the exact transaction details before each approval, and the results after.
- `app.js`: the page logic. Plain script, no imports, no bundler.
- `dist/hashinal-wc.umd.js`: the Hashinal WalletConnect SDK, pinned at `@hashgraphonline/hashinal-wc` version 2.0.64, vendored from jsDelivr. SHA-256 verified against the hash jsDelivr lists for that version: `hXNEMacvDQnCxwFS+s6FTranWdFuvcqmtPz5ERV/Xnw=`. 6,028,597 bytes.

## What it does

1. Connects HashPack over WalletConnect (mainnet by default, testnet selectable for testing).
2. Reads the connected account public key from the public mirror node record for the account. That key is already public.
3. Step 1, Create topic: builds a `TopicCreateTransaction` with memo `Enoch verification records`, admin key and submit key both set to the account public key, no custom fees. Expected cost about $0.01. Executes it through the wallet signer.
4. Step 2, Submit message: builds a `TopicMessageSubmitTransaction` with the prefilled message below and executes it through the wallet signer. Expected cost about $0.0001.
5. Shows the results: topic ID, sequence number, consensus timestamp, transaction IDs, fee charged, and HashScan links. After the submit it re-reads the message from the mirror node and checks it is byte-identical to the message shown on the page.

The prefilled message, shown in full on the page before any approval:

```json
{"spec":"1.1","digest":"01ae732d5bf4476f8159d2a02e23c58a6f33044d0dae2d0bd8a605c057187284","envelope":"record_id=EN-2026-0001;event=document.captured;file=engagement-letter.pdf;captured_at=2026-10-15T21:42:18Z","domain":"enoch.goodcode.ca"}
```

This message text is proposed, not approved. Nothing is submitted unless the user taps the button on the page and approves the transaction in HashPack.

## What it never does

- Never asks for, stores, or sends a seed phrase or a private key. There is no input for one anywhere on the page or in the code.
- Never submits a transaction on its own. Each step needs a tap on the page and an approval in HashPack.
- Never talks to a server of ours. The only network calls are to WalletConnect (to reach the wallet), to the public Hedera mirror node (to read the account public key and confirm results), and to Hedera consensus nodes through the wallet signing session.
- Never uses mainnet unless Mainnet is picked on the page.

## The two open points, resolved

Both were resolved by reading the published SDK source for version 2.0.64 (`dist/es/index.js` from jsDelivr) and its type declarations, not from memory.

1. Key format for `createTopic()`: NOT accepted. The SDK method does `PrivateKey.fromString(adminKey)` and `PrivateKey.fromString(submitKey)`, so a public-key string would throw. The SDK method is therefore not used. The page builds the `TopicCreateTransaction` directly with `@hashgraph/sdk` (exposed by the UMD bundle as `window.HashgraphSDK`), sets the admin and submit keys to the account `PublicKey` object, and executes it with the SDK `executeTransaction()` method, which freezes the transaction with the wallet signer and executes it with the wallet signer. The wallet signature satisfies the admin key requirement because the admin key is the account key.
2. Signing the submit on a submit-key topic: confirmed to route through the wallet. The SDK `submitMessageToTopic()` only signs locally if a submit key is passed; with no submit key it calls `executeTransaction()`, which freezes and executes with the wallet signer (`freezeWithSigner` then `executeWithSigner` on the connected `DAppSigner`). The page builds the submit transaction directly for the same reason as step 1 (so it knows the transaction ID and can look up the exact fee), and passes no key. No private key enters the page at any point.

## What was verified

- SDK docs read at hol.org (API Methods and Overview pages) and package metadata read from jsDelivr: version 2.0.64 exists, UMD and ESM builds present, `createTopic(memo, adminKey, submitKey)` and `submitMessageToTopic(topicId, message, submitKey)` documented, mainnet default.
- SDK source read: `executeTransaction`, `createTopic`, and `submitMessageToTopic` implementations quoted above.
- Vendored UMD hash verified: SHA-256 matches the jsDelivr-listed hash for 2.0.64.
- Offline construction test in Node with `@hashgraph/sdk` 2.78.0: built the exact `TopicCreateTransaction` (memo, admin key, submit key) and the exact `TopicMessageSubmitTransaction` (the 239-byte message above), froze them, signed locally only to simulate the wallet signature, serialized to bytes, decoded with `Transaction.fromBytes`, and confirmed every field: memo exact, admin and submit keys equal to the public key (tested both with a generated key and with the real account 0.0.8077235 public key read from the mainnet mirror node), topic ID and message byte-identical. The envelope digest was recomputed with SHA-256 and matches the digest in the message exactly.
- Bundle load test in jsdom over local HTTP: the page loads with zero errors, `window.HashinalsWalletConnectSDK` is the singleton instance with `init`, `connect`, `disconnect`, `executeTransaction`, `getAccountInfo`, `getAccountBalance`, `submitMessageToTopic`, `createTopic` present, and `window.HashgraphSDK` exposes `TopicCreateTransaction`, `TopicMessageSubmitTransaction`, `TopicId`, `PublicKey`, `TransactionId`, `AccountId`, `LedgerId`. The page `app.js` passes `node --check`.
- User-facing text in `index.html` and `app.js`: 0 em dashes, 0 en dashes, checked with grep.
- Testnet connect fixed Nov 27, 2026: the page now tries `testnet.mirrornode.hedera.com` when `testnet-public.mirrornode.hedera.com` returns empty replies, and connect errors name the step (WalletConnect step or Mirror node step). The connect then worked on a phone: account 0.0.5448473, testnet, 10 HBAR.
- "list is locked" fixed Nov 27, 2026: the page used to set the transaction ID itself before calling `executeTransaction`. The wallet signer's `populateTransaction` sets the transaction ID unconditionally, and setting it first locks the ID list, so the signer threw "list is locked" before any signing request reached HashPack (which is also why HashPack opened to its dashboard with nothing to approve). The page no longer sets the transaction ID; it reads it from the transaction after execution. Fix verified from the vendored SDK source, not yet proven by a live run.

## What was NOT verified (read this before mainnet)

No live testnet run happened, and no testnet topic or message exists. There is no testnet proof link to give, because the run was blocked in this environment:

- No funded testnet account could be obtained from this VM. The Hedera Portal is Cloudflare-blocked from here, the faucet API needs a Portal personal access token (which needs a Portal sign-up), and the web faucet needs a browser and a captcha. No testnet account was created, and no testnet key exists.
- Testnet gRPC from this VM fails: balance queries to testnet consensus nodes fail with DEADLINE_EXCEEDED after retries. The page itself is unaffected, because in real use the wallet submits the transaction, but no transaction could be submitted from this VM.
- The `testnet-public.mirrornode.hedera.com` host returns empty replies from this VM. The alternate host `testnet.mirrornode.hedera.com` answers HTTP 200, and the mainnet mirror node answers normally.

So the live HashPack tap-through on testnet (connect, approve topic creation, approve message submit) and the on-chain testnet topic and message are still unverified. Do not run this on mainnet until that live testnet run is done.

## What remains

1. WalletConnect Cloud project ID. Done Nov 27, 2026: the project ID 30e6b7be7e28aa8c55317773c9534d57 is set as the default in app.js, so the field on the page is already filled in. It is a public identifier, not a secret. The page saves whatever is in the field in that browser only.
2. Hosting. Serve this directory from any static host (or a local HTTP server for testing). The page is static and has no server side.
3. Live testnet run. On a phone with HashPack set to Testnet and a funded throwaway testnet account: open the page, pick Testnet, connect, create the topic, submit the message, and confirm the topic and message on HashScan testnet (`https://hashscan.io/testnet/topic/<topic-id>`). Record the testnet topic ID, sequence number, and HashScan link here before mainnet.
4. Mainnet run. Only after step 3 works and the message text above is approved: pick Mainnet, connect the real account, create the topic (about $0.01), submit the message (about $0.0001), and verify on HashScan mainnet.

## If the page reports an error

- "The signing library did not load": `dist/hashinal-wc.umd.js` is missing or did not load. Check all three files are served together.
- "A WalletConnect Cloud project ID is needed first": paste a project ID (step 1 above).
- "The wallet connected on ... but this page is set to ...": the network picked on the page and the network in HashPack do not match. Disconnect, pick the matching network, reconnect.
- A rejected transaction in HashPack is not an error in the page. Nothing was submitted. Check the details on the page and try again.
