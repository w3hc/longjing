# Credit settlement and request unlinkability

Design for issue 134, which binds the deposit amount to the note, settles withdrawals net of spending and removes every identifier that links a request to its deposit, compared against the original RLN proposal and ethereum/zkapi.

**Status:** implemented. The circuits landed in [#167](https://github.com/w3hc/longjing/issues/167), and the contract, server and client in [#168](https://github.com/w3hc/longjing/issues/168) and [#169](https://github.com/w3hc/longjing/issues/169). The circuits are named `request` and `settlement`. The sections below describe the design as built, and the problems they cite are those of v0.4.1.

## Why this redesign

At v0.4.1 the protocol in [ZK API Usage Credits: LLMs and Beyond](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) (Crapis and Buterin, "the paper" below) is in the circuits, but its two promises are not:

- **Spending is never settled** ([audit](audits/2026-10-internal-audit.md) LJ-01). `withdraw` returns the whole stake, and `redeemRefund` pays refunds in ETH from the shared pool on top of it.
- **The deposit amount is unchecked** (LJ-02). `initialDeposit` is a private input nothing constrains, so the solvency check `(i + 1) · C_max ≤ D + R` holds for any D the prover picks.
- **Requests are linkable** (LJ-03). `idCommitment` is a public output of every request proof. The server stores it next to the nullifier, and refund redemption publishes it onchain.

All three live in the same circuits and contract paths, so this document redesigns them together, as [#134](https://github.com/w3hc/longjing/issues/134) asks. Implementation is split into sub-issues at the end.

Working through the design turned up four more problems that any fix has to deal with:

1. **`maxCost` is chosen per request.** The paper's `C_max` is a constant. With a per-request value, request `i` only checks `(i + 1) · C_max_i ≤ D + R`. Picking `C_max_i = D / (i + 1)` lets total spending grow like `D · ln n`.
2. **Settling on the highest index needs a prefix.** If a client can skip ticket indices, it can use index 999, withdraw claiming it never went past index 0, and nobody can show otherwise without linking requests.
3. **The owner can slash their own note.** Whoever holds `k` can make two signals with the same nullifier, so the owner can always call `slashDoubleSpend` and collect the full stake. Once withdrawal deducts spending, self-slashing would refund every request.
4. **The client sends `ticketIndex` and the server stores it** with each nullifier. Indices count requests per user, which is a linking signal on its own.

### Constraints

The design keeps every property below. Each section says how.

- No stored identifier, log line, onchain event, or timing or size signal links a request to a deposit or to another request.
- The secret key `k` never leaves the client.
- RLN signals, the solvency formula and a stake that a double-spend forfeits stay as in the paper. Every departure is named in [Departures from the paper](#departures-from-the-paper).
- Pricing and refunds stay provider-agnostic.
- A depositor can exit using only the chain, their own state and a client-side prover: no server signature, API call or admin action.
- Everything needed to exit is onchain or held by the user.
- No admin power can block or redirect an exit faster than a user can complete it, and pausing never blocks an exit.
- Double-spend slashing stays permissionless.

## Overview

| | v0.4.1 | This design |
| --- | --- | --- |
| Leaf | `Poseidon(k)` | `Poseidon(Poseidon(k), D)`, computed by the contract from `msg.value` |
| Stakes | D and S, split 50/50 | One stake: the whole deposit D |
| `C_max` | Per request, chosen by the client | A constant of the deployment |
| Refunds | A list of up to 10 signed tickets, also redeemable in ETH | One accumulator commitment the server updates homomorphically, as in the paper's second variant |
| Request public signals | Include `idCommitment` | No identifier: nullifier, signal, root, a re-randomized accumulator |
| Requests per note | Any order | Strictly sequential |
| Withdrawal | Full stake, one step | `D + R − n · C_max`, after a challenge window |
| Slashing | Proof of two signals, full stake to the caller | Reveal `k`, a fixed bounty to the caller, the rest to the operator |
| Server stores | Nullifier, signal, payload hash, ticket index, `idCommitment` | Nullifier and signal `(N, x, y)` |

## Notes and deposits

A **note** is one deposit. The client draws a secret key `k` in the scalar field of [BN254](https://eips.ethereum.org/EIPS/eip-197) and computes its commitment `c = Poseidon(k)`.

```text
deposit(c) payable
  D    = msg.value
  leaf = Poseidon(c, D)          // computed onchain
  notes[c] = { amount: D, depositedAt, status: Active }
  insert leaf into the Merkle tree
```

The contract computes the leaf itself, so the D a proof uses is exactly what was paid (LJ-02). `c` is visible at deposit, as `idCommitment` is today. That is fine: the deposit transaction is public anyway. What matters is that no request ever shows `c`, the leaf or D.

There is one note per commitment, as today (`DepositAlreadyExists`). D is the whole deposit. The policy stake S goes away (see [The policy stake](#the-policy-stake)).

Deposit amounts are public, but a request proof hides which leaf it opens, so an unusual amount doesn't shrink a request's anonymity set. The set is every note in the tree.

## Constant `C_max`

`C_MAX` becomes an immutable of the contract, in wei, and a public input of every request proof. The server checks it against the contract, as it checks the root.

- The server rejects, before calling the provider, any request whose worst case exceeds `C_MAX`. That closes the negative-refund half of LJ-12.
- `C_MAX` is sized for the largest request the gateway serves. The refund returns the difference, so a small request still costs only what it used.
- Changing `C_MAX` would change what every open note owes, so it is fixed per deployment. A new price ceiling means a new contract, which the [exit properties](#exit-properties) already allow: users exit from the old one.

A request that costs more than `C_MAX` could consume several consecutive indices. It is left out of this design: each index would need its own nullifier in the proof to rule out overlapping ranges.

## Requests

### The accumulator

Refunds live in one **accumulator**, a [Pedersen commitment](https://en.wikipedia.org/wiki/Commitment_scheme) on [Baby Jubjub](https://eips.ethereum.org/EIPS/eip-2494), the curve [circomlib](https://github.com/iden3/circomlib) already uses for EdDSA:

```text
A = R·G + m·J + c·K + s·H
```

- `R` is the sum of refunds so far, `m` the next ticket index, `c` the note's commitment, `s` a blinding factor.
- `G`, `J`, `K` and `H` are independent generators of the prime-order subgroup, derived by hashing to the curve from fixed public seeds, so nobody knows a discrete log between them.
- `c·K` binds the accumulator to the note: nobody without `k` can open it.
- The **genesis accumulator** is `A₀ = c·K` (`R = m = s = 0`). It needs no signature.

Every accumulator after genesis is signed by the server's refund key (EdDSA-Poseidon over `Poseidon(A.x, A.y)`), the key already derived in the enclave and registered onchain.

### One request

For request `i`, the client holds a signed accumulator `A` that opens to `(R, m = i, c, s)`. It draws a fresh `s'` and proves, in one [Groth16](https://eprint.iacr.org/2016/260) proof:

1. `leaf = Poseidon(Poseidon(k), D)` is in the tree under the public root.
2. `A` is genesis and `i = 0`, or the server's signature on `A` is valid.
3. `A` opens to `(R, i, Poseidon(k), s)`.
4. The public `A_pub = A + s'·H`.
5. Solvency: `(i + 1) · C_MAX ≤ D + R`, with `R` and `D` range-checked.
6. RLN, as in the paper: `a = Poseidon(k, i)`, `N = Poseidon(a)`, `y = k + a · x`.

Public signals: root, `C_MAX`, `x`, the server key, `A_pub`, and the outputs `N` and `y`. No `c`, leaf, D, `i` or `R`.

The server checks the root against the contract (fail closed, as LJ-09 requires), checks `x`, verifies the proof, records `N` atomically, calls the provider and computes the refund `v = C_MAX − C_actual`, clamped to `[0, C_MAX]`. It returns

```text
A' = A_pub + v·G + J        and its signature
```

`A'` opens to `(R + v, i + 1, c, s + s')`. The server has added `v` and moved the index forward without learning `R`, `i` or the note. This is the paper's homomorphic variant `E(R_new) = E(R) ⊕ E(r)`. The re-randomization by `s'` is the fix that thread proposed for linkability: the server sees `A_pub`, which no earlier response showed, and the next request will show another fresh point.

### Why requests can't be linked

Per request the server sees `N`, `x`, `y`, the root, `C_MAX` and `A_pub`.

- `N = Poseidon(Poseidon(k, i))` is fresh for every index.
- `A_pub` is uniformly distributed thanks to `s'`, and nothing ties it to the `A'` the server signed last time. That would take the opening, which only the client has.
- `y` is a point on a line known only to the client. One point says nothing about `k`.
- The proof is zero-knowledge.

The server stores `(N, x, y)` and nothing else (see [What the server stores](#what-the-server-stores)). Timing and network correlation remain the job of the metadata hardening and of [#99](https://github.com/w3hc/longjing/issues/99).

### Sequential requests and the prefix property

Request `i` needs an accumulator signed with index `i`, which only the response to request `i − 1` provides. So by induction, **the indices a note has used always form a prefix `0, 1, …, n − 1`**. That is what makes settling on the highest index sound (problem 2 above).

The cost is that a note serves one request at a time. Two requests from the same accumulator share the index, so they share `N` with different `x`: the second is rejected and its signal reveals `k`. A client that wants parallel requests holds several notes. [ethereum/zkapi](https://github.com/ethereum/zkapi) has the same constraint.

### Failures and retries

- **Provider error.** The server still returns `A'` with `v = C_MAX`, a full refund (LJ-12).
- **Lost response.** The server keeps the signed `A'` keyed by `N` for a short time. A retry with the same `(N, x, y)` returns it without calling the provider again. This reveals nothing new, since `N` is already stored, and `A'` is never shown again in that form.
- **Refused service.** If the server withholds `A'`, the note can make no further requests. The user can still exit (next section), forfeiting the refund for that one request.

## Withdrawal

Withdrawal pays out what is left: `D + R − n · C_max`, where `n` is the number of indices the note used. It takes two steps with a challenge window `W` in between, because the contract can't see `n`. It has to trust the user's claim unless someone shows the claim is too low.

### The withdrawal proof

The client takes its latest signed accumulator `A`, which opens to `(R, m, c, s)`, chooses a claimed index count `n ≥ m`, and proves:

1. `Poseidon(k) = c`.
2. `A` is genesis, or the server's signature on `A` is valid.
3. `A` opens to `(R, m, c, s)` and `n ≥ m`.
4. The payout `P = D + R − n · C_MAX` and `P ≥ 0`.
5. An RLN signal at index `n`: `a = Poseidon(k, n)`, `N = Poseidon(a)`, `y = k + a · x`, with `x = Poseidon(recipient, chainId, contract)`.

Public signals: `c`, `D` (the contract supplies `notes[c].amount`), `C_MAX`, the server key, the recipient, `x`, and the outputs `N`, `y` and `P`. The recipient is bound twice, in `x` and as a public input with an explicit constraint, as today.

There is no Merkle path: the contract already knows the note by `c`. The withdrawal page then needs the note's commitment and amount, both onchain, plus the accumulator the user holds. It no longer needs `getMerkleProof`.

Normally `n = m`. A user whose last request got no response claims `n = m + 1` and pays full `C_MAX` for it. A user who lost their accumulator exits from genesis with an `n` at least as large as the requests they made, and forfeits their refunds but not the deposit.

### Two steps

```text
initiateWithdrawal(c, recipient, proof, N, y, P)
  require notes[c].status == Active and P ≤ D
  verify the proof, with x computed by the contract
  notes[c] = Exiting { N, x, y, P, recipient, exitAt: now + W }
  replace the leaf with the empty value; emit WithdrawalInitiated(c, N, x, y, P)

finalizeWithdrawal(c)            // anyone, after exitAt
  pay P to the recipient; operatorBalance += D − P; status = Closed
```

### Why the claim can't be too low

The used indices form a prefix `0 … n_true − 1` (see [Sequential requests](#sequential-requests-and-the-prefix-property)).

- **Claim too low** (`n < n_true`): index `n` was used by a real request, so the server already holds `(N, x', y')` with `x' ≠ x`. It recovers `k = (y · x' − y' · x) / (x' − x)` and slashes the note during the window.
- **Claim too high**: `N` is fresh, so nobody can challenge, and the user only underpays themselves.

The payout never exceeds D. Every signed step adds one to `m` and at most `C_MAX` to `R`, so `R ≤ m · C_MAX ≤ n · C_MAX`. The contract also checks `P ≤ D` itself, in case a signing key is ever compromised. Each note pays out at most D in total, split between recipient, slasher and operator, so the pool stays solvent whatever happens (LJ-01).

### After an exit starts

- The server reads `WithdrawalInitiated` and adds `N` to its spent set before serving anything else. A request at index `n` is then refused. Requests at indices between `m` and `n` are already paid for by the claim, and anything above `n` needs an accumulator for index `n + 1`, which can't exist.
- The leaf is replaced with the empty value, so new proofs can't use it. The server accepts a root only if it is one of the last few roots the contract records, and that history is much shorter than `W`. So once an exit is final, no root that contains the note is still accepted.

### What an exit reveals

The exit shows that note `c` closed, to which recipient, and for what payout. `D − P` is the note's net spending. It doesn't show which requests the note made, or how many apart from what `D − P` implies. A user who doesn't want the deposit address linked to the recipient picks a fresh recipient. The exit's own `N` has never been used for a request, so it links to nothing in the server's store.

## Slashing

```text
slash(k)
  c = Poseidon(k)
  require notes[c].status is Active or Exiting
  bounty = min(SLASH_BOUNTY, D) to msg.sender
  operatorBalance += D − bounty
  status = Slashed; replace the leaf with the empty value
```

Knowing `k` is the proof: only the owner holds it, and it leaks only when two signals share a nullifier. Anyone who has `k` can call `slash`, so slashing stays permissionless. Recovering `k` from two signals is one modular division, done offchain, so `double_spend_slashing.circom` and its verifier go away.

The caller gets a **fixed bounty, not the stake** (problem 3 above). If the caller took D, the owner could slash their own note at any time and get the whole deposit back, refunding every request. With a small `SLASH_BOUNTY`, self-slashing pays the owner at most the bounty, less than an honest exit unless the note is nearly drained. The rest of D goes to the operator, which is owed the spending the double-spend tried to dodge. The operator can't fake a slash, because that needs `k`.

Front-running a `slash` call only moves the bounty, so no commit-reveal scheme is needed.

## Expiry and operator revenue

- `claimExpired(c)`: the operator takes D from a note that is still `Active` after `NOTE_TTL`. As today, the TTL is pushed back by time spent paused. A note that is `Exiting` can't be claimed, so an exit started before expiry always completes.
- `operatorBalance` collects `D − P` from finalized exits, slash remainders and expired notes. `serverAddress` withdraws it.
- The operator gets paid when a note closes, not per request. ethereum/zkapi makes the same trade, with one net settlement at close.

## The policy stake

The policy stake S goes away. The paper burns S through `slashPolicyStake(nullifier)`, which has to find the deposit behind a request. Once requests carry no identifier, the only way to find it is the link this redesign removes. No proof statement fixes that: proving a nullifier belongs to a given note is exactly what unlinkability rules out.

Enforcement moves to what the server already controls:

- **Withholding the accumulator.** For a request that breaks the policy, the server serves nothing and returns no `A'`. The note can't make another request, and the user loses at most `C_MAX` at exit, since the refund for that request is forfeit.
- **Refusing service** before the provider call, as today.

The penalty is bounded and burns nothing. A malicious operator can freeze a note's service, but not its deposit: the exit doesn't need the server. This matches ethereum/zkapi's bounded `S_max` deduction more than the paper's burn, and it is listed under [departures](#departures-from-the-paper). LJ-17 (the stranded policy stake) goes away with S.

## What the server stores

| Data | Kept | Why |
| --- | --- | --- |
| `N`, `x`, `y` | Yes, for as long as the contract is live | Rejecting replays and recovering `k` from a second signal, both during requests and against exits |
| `A'` and its signature, keyed by `N` | Minutes | Retries after a lost response |
| `idCommitment`, leaf, D | Never sent | The request doesn't contain them |
| `ticketIndex` | Never sent | Private in the proof (problem 4) |
| `payload_hash` | Dropped | See below |
| Timestamps | No | Nothing needs them, and they help timing correlation |

`x` stays `Hash(M)` as in the paper, with a nonce: `x = Poseidon(H(M), ρ)`. The client sends `ρ` with the request, and the server recomputes `x` from the payload and `ρ`, then forgets both. Without `ρ`, anyone holding the database could confirm a guessed prompt by hashing it. With `ρ`, a stored `x` is just a field element. The separate `payload_hash` column was only a copy of what `x` encodes, so it goes.

## Departures from the paper

Restored by this design:

- **`C_max` is a constant**, as in the paper. The per-request `maxCost` was the departure.
- **Refunds raise the spending limit and withdrawal pays out what is left**, as in the paper. Paying refunds out in ETH through `redeemRefund` was the departure, and it goes.

New departures, each deliberate:

| Paper | This design | Why |
| --- | --- | --- |
| `ID = Hash(k)`, D implicit | Leaf `Poseidon(Poseidon(k), D)`, computed onchain | The circuit needs D bound to what was paid (LJ-02) |
| Two stakes, D and S | One stake, D | S can't be found without linking a request to its deposit. Policy is enforced by withholding the accumulator |
| Whoever proves a double-spend claims D | `slash(k)` pays a fixed bounty, the rest goes to the operator | Otherwise the owner self-slashes and recovers spending |
| Homomorphic `E(R)`, re-randomized, with [BBS+](https://datatracker.ietf.org/doc/draft-irtf-cfrg-bbs-signatures/) suggested in the thread | A Pedersen commitment, re-randomized inside the request proof, signed with EdDSA | The proof shows knowledge of a signed commitment without revealing it, so no blind signature is needed |
| Any request order with the ticket list | Strictly sequential per note | Settling on the highest index needs the used indices to form a prefix |
| No exit procedure | Two-step withdrawal with a challenge window | The contract can't see `n`, so an understated claim must be challengeable |
| [ZK-STARK](https://eprint.iacr.org/2018/046) | [Groth16](https://eprint.iacr.org/2016/260) | Unchanged from today. The trusted setup is tracked in [#135](https://github.com/w3hc/longjing/issues/135) (LJ-04) |

RLN signals, `a = Hash(k, i)`, `N = Hash(a)`, `y = k + a · x`, `x = Hash(M)` (with a nonce), the solvency formula and a stake forfeited on double-signaling all stay.

## Comparison with ethereum/zkapi

[ethereum/zkapi](https://github.com/ethereum/zkapi) replaces RLN with a state-anchor chain ([PROTOCOL.md](https://github.com/ethereum/zkapi/blob/main/protocol/PROTOCOL.md)): each request consumes a private state, and the server signs the next one.

| | ethereum/zkapi | This design |
| --- | --- | --- |
| Balance | Server-signed commitment to the balance, bound to the note | Server-signed commitment to refunds and index, bound to the note |
| Reuse of a state | Rejected by its nullifier | Rejected, and the two signals reveal `k`, so the note can be slashed |
| Spending check | Balance minus cost stays non-negative | `(i + 1) · C_max ≤ D + R`, as in the paper |
| Order | Sequential | Sequential |
| Close | `mutualClose` with a server clearance signature, or an escape withdrawal with a 24-hour challenge | One path: a withdrawal with a challenge window, no server signature |
| Challenge evidence | A newer signed state | A second signal at the claimed index |
| Policy | Bounded deduction `S_max` from the balance | Withholding the next accumulator, bounded by `C_max` |

The two designs end up close in mechanics: one signed commitment per note and sequential requests. They still differ where the paper sets the rules. RLN stays, so a reused state costs the cheater their stake instead of just failing, and the evidence for a challenge is something the server already stores. The exit has a single path that never needs a server signature. Converging further on the state-anchor model is not a goal.

## Alternatives considered

- **A bigger ticket list.** Each ticket costs an EdDSA verification in every request proof, and the limit only moves.
- **A Poseidon accumulator merged in a separate step.** The client would prove a batch of tickets and get a fresh signed commitment. It works, but adds a round trip whose timing can correlate with requests, and needs a contiguity proof over ticket indices. The Pedersen accumulator updates in the same response.
- **A server-side `getDeposit` lookup** (LJ-02). It only works because of the LJ-03 leak.
- **Revealing every nullifier at exit.** It proves usage exactly, but links all of a note's requests at the end.
- **A mutual close with a server clearance signature**, as in ethereum/zkapi. A faster close when the server cooperates, but a second path to maintain. It can be added later without changing the circuits.
- **Keeping S with a proof.** No statement links a nullifier to a note without breaking unlinkability (see [The policy stake](#the-policy-stake)).

## Exit properties

- **Exit.** `initiateWithdrawal`, then `finalizeWithdrawal` after `W`. It needs the chain, any RPC, `k`, the accumulator and the withdrawal page: no server signature, API call or admin action. The proposed `W` is 3 days.
- **State.** `c` and D are onchain. The accumulator and its opening are held by the user. Losing them costs the refunds, not the deposit: the user exits from genesis with a conservative `n`.
- **Artifacts.** The page needs `withdrawal.wasm` and `withdrawal.zkey`, pinned by hash, and no Merkle path.
- **Admin.** `C_MAX` and `SLASH_BOUNTY` are immutable. Changes to the verifiers, `serverAddress` and the refund key wait behind `ADMIN_DELAY` (7 days), which is longer than `W` plus the time to submit. A rotated refund key stays accepted for withdrawals, so older accumulators still verify. Pausing blocks deposits and requests, never `initiateWithdrawal`, `finalizeWithdrawal` or `slash`.
- **Expiry.** `NOTE_TTL` stays at 365 days, far longer than `W`, and an exit already started can't be claimed.
- **Slashing.** `slash(k)` is open to anyone holding `k`.
- **Rerun.** Unchanged.

The window is a risk for the operator, not the user. If the server is offline for longer than `W`, an understated exit goes through unchallenged. That costs the operator revenue, never another user's deposit.

## Implementation

Three sub-issues of [#134](https://github.com/w3hc/longjing/issues/134), in order, all done:

1. **Circuits** ([#167](https://github.com/w3hc/longjing/issues/167)). The new `request` and `settlement` circuits, the generators derived by hashing to the curve, and the removal of `refund_redemption` and `double_spend_slashing`. A `circuits-v2` release with verification keys checked against the verifiers, and tests with real proofs.
2. **Contract** ([#168](https://github.com/w3hc/longjing/issues/168)). Notes keyed by `c` with the leaf computed onchain, `C_MAX`, the two-step withdrawal, `slash(k)` with its bounty, `operatorBalance`, a root history, removing a leaf, accepted refund keys, and removing `redeemRefund`, S and `slashPolicyStake`. Foundry tests run against the real verifiers.
3. **Backend and client** ([#169](https://github.com/w3hc/longjing/issues/169), landed with #168 in one pull request).
   - The request DTO without identifiers, accumulator signing and the retry cache.
   - The `(N, x, y)` nullifier store.
   - Watching `WithdrawalInitiated` and challenging.
   - `pnpm prove` for requests and withdrawals.
   - `API_REFERENCE.md`, `ZK.md`, `SQLITE3.md` and the README's status.

`pnpm prove withdrawal` also covers [#119](https://github.com/w3hc/longjing/issues/119), the client-side withdrawal prover. [#157](https://github.com/w3hc/longjing/issues/157) builds the standalone page on top of it. [#135](https://github.com/w3hc/longjing/issues/135) runs once the circuits are final.

### Demo goals

| Goal | Change | Flips to verified with |
| --- | --- | --- |
| Solvency is enforced | Check that a request past `D + R` is rejected and that an exit pays `D + R − n · C_max` | Sub-issues 2 and 3 |
| A request can't be linked to the deposit | Check that the public signals and the stored row carry no `c`, leaf, D or index | Sub-issue 3 |
| Two requests can't be linked to each other | Check that two requests' rows and signals share no value | Sub-issue 3 |
| A refund redemption onchain can't be linked to the deposit | Reworded: a request's refund never appears onchain | Sub-issue 2 |
| A refund is `maxCost − actualCost`, signed by the onchain key, redeemable once | Reworded: the accumulator grows by `C_max − C_actual`, signed by the onchain key | Sub-issue 3 |
| A refund can only be redeemed to the recipient in its proof | Reworded: a withdrawal pays only the recipient in its proof | Sub-issue 2 |
| A nullifier is accepted once | Reworded: a retry returns the same accumulator and calls the provider once | Sub-issue 3 |
| A double-spend reveals `k` and anyone can slash | Reworded: anyone holding `k` slashes, and the caller gets the bounty, not the stake | Sub-issue 2 |
| New: an exit that understates usage is slashed during the window | New check | Sub-issues 2 and 3 |
| New: a closed note can't make requests | New check | Sub-issue 3 |

The withdrawal and exit goals stay "not met" until #119 and #157.

## Further reading

- [ZK API Usage Credits: LLMs and Beyond](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104), the paper
- [Longjing v0.4.0 internal security audit](audits/2026-10-internal-audit.md)
- [Rate-Limiting Nullifier specification](https://rfc.vac.dev/spec/32/)
- [ethereum/zkapi protocol](https://github.com/ethereum/zkapi/blob/main/protocol/PROTOCOL.md)
- [EIP-2494: Baby Jubjub](https://eips.ethereum.org/EIPS/eip-2494)
