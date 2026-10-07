# ZK Circuits for API Credits

Circom implementations of the request and withdrawal proofs, with Rate-Limit Nullifiers (RLN) and a server-signed refund accumulator.

## Circuits

The circuits of [docs/SETTLEMENT.md](../docs/SETTLEMENT.md): the server verifies `request` for every API request, and `LongjingCredits` verifies `settlement` for every withdrawal. Double-spend slashing needs no circuit: the two signals reveal `k`, and `slash(k)` checks `Poseidon(k)` onchain.

Both open the note's refund accumulator `A = R·G + m·J + c·K + s·H`, a Pedersen commitment on Baby Jubjub ([templates/accumulator.circom](templates/accumulator.circom)). It is either the genesis accumulator `c·K`, or one the server signed with EdDSA-Poseidon over `Poseidon(A.x, A.y)`. The generators are hashed to the curve from the seeds `longjing/accumulator/{G,J,K,H}` by [src/longjing/accumulator.ts](../src/longjing/accumulator.ts), and a test checks the constants against it.

### Request Circuit ([request.circom](request.circom))

**Proves**:
- `Poseidon(Poseidon(k), D)` is a leaf under the public root, so D is what was deposited
- The accumulator opens to `(R, i, Poseidon(k), s)` and is genesis or signed
- `A_pub = A + s'·H`, a fresh point the server can't match to the accumulator it signed
- Solvency: `(i + 1) · C_MAX ≤ D + R`, with `i < 2^32` and D, R, `C_MAX < 2^128`
- The RLN signal at index `i`

**Parameters**:
- Merkle tree depth: 20, constraints: ~37K
- Public inputs: `merkleRoot`, `maxCost`, `signalX`, `serverPublicKeyX`, `serverPublicKeyY`
- Outputs: `nullifier`, `signalY`, `accumulatorX`, `accumulatorY`
- No commitment, leaf, deposit, index or refund sum is public

### Settlement Circuit ([settlement.circom](settlement.circom))

**Proves**:
- `Poseidon(k)` equals the public commitment `c`
- The accumulator opens to `(R, m, c, s)` and is genesis or signed
- The claimed index count `n` is at least `m`, with `n < 2^32`
- The payout `P = D + R − n · C_MAX` is not negative
- The RLN signal at index `n`, which the server can challenge if `n` was used

**Parameters**:
- Constraints: ~22K, no Merkle path
- Public inputs: `commitment`, `deposit`, `maxCost`, `serverPublicKeyX`, `serverPublicKeyY`, `recipient` (bound by an explicit constraint), `signalX`
- Outputs: `nullifier`, `signalY`, `payout`
- Verifier: [SettlementVerifier.sol](../contracts/src/SettlementVerifier.sol)

Shared templates: [accumulator.circom](templates/accumulator.circom) (generators, Pedersen commitment, signature check, re-randomization), [merkle_tree.circom](templates/merkle_tree.circom) and [rln.circom](templates/rln.circom).

## Artifacts

`build/` is not tracked in Git. `pnpm circuits:fetch` downloads the witness generators, proving keys and verification keys pinned in [artifacts.json](artifacts.json). [docs/ZK.md](../docs/ZK.md#circuit-artifacts) explains how to regenerate them, and [scripts/setup/compile-production-circuits.sh](../scripts/setup/compile-production-circuits.sh) compiles `settlement` and exports `SettlementVerifier.sol`.

## Inputs

[scripts/client/note.ts](../scripts/client/note.ts) builds both circuits' inputs from a note file and the contract, and is the reference for their format. Every value is a decimal string. Amounts must fit in 128 bits and indices in 32, or witness generation fails, which keeps both sides of the solvency check below 2^161 and the payout from wrapping around the field.

## Testing

```bash
pnpm test:proof   # compiles both circuits, checks witnesses, and proves against the pinned keys
```

[request-circuit.spec.ts](../src/longjing/request-circuit.spec.ts) and [settlement-circuit.spec.ts](../src/longjing/settlement-circuit.spec.ts) compile the circuits with circom, so they are skipped without it. [accumulator-proof.spec.ts](../src/longjing/accumulator-proof.spec.ts) proves and verifies with the released keys.

## Static Analysis

CI runs [circomspect](https://github.com/trailofbits/circomspect) 0.9.0 on every tracked circuit and fails on any warning missing from [circomspect.baseline.json](circomspect.baseline.json). To run it locally:

```bash
cargo install circomspect --version 0.9.0 --locked
pnpm check:circomspect
```

Fix a new warning if it's real. If it's a false positive or intended, add the entry the check prints to the baseline, with a `reason` saying why. Entries are keyed on the flagged line's text, so an edit to that line makes its entry stale, and a stale entry also fails the check.

## Security Considerations

1. **Trusted Setup**: the keys come from a single-party phase 2, enough for testnets only ([#135](https://github.com/w3hc/longjing/issues/135))
2. **Circuit Auditing**: the circuits haven't been audited since the settlement redesign
3. **Nullifier Uniqueness**: a note's indices are sequential, so each nullifier is used once
4. **Signal Extraction**: two signals at one index reveal the secret key through RLN math

## References

- [Circom Documentation](https://docs.circom.io/)
- [snarkjs Documentation](https://github.com/iden3/snarkjs)
- [Rate-Limit Nullifiers](https://rate-limiting-nullifier.github.io/rln-docs/)
- [ZK API Credits Proposal](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104)
