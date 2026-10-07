# Credit settlement and request unlinkability

Design for issue 134, which binds the deposit amount to the note, settles withdrawals net of spending and removes every identifier that links a request to its deposit, compared against the original RLN proposal and ethereum/zkapi.

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
