# Longjing - Smart Contracts

Solidity smart contracts for privacy-preserving API credits system using Zero-Knowledge proofs and Rate-Limit Nullifiers (RLN).

## Overview

The LongjingCredits contract implements:
- **Notes** keyed by commitment, with the leaf `Poseidon(c, D)` computed onchain from the deposit
- **Merkle tree** anonymity set using Poseidon hashing, with the last 30 roots
- **Settlement**: a ZK withdrawal of `D + R − n · C_MAX` after a 3-day challenge window
- **Slashing** by revealed secret key, for a fixed bounty
- **Timelocked admin**: verifier, server address and refund key changes wait 7 days

## Contracts

### LongjingCredits.sol
Main contract implementing the RLN-based usage-credits protocol.

**Key Functions:**
- `deposit(bytes32 commitment)` - Open a note worth `msg.value`, between `C_MAX` and 2^128 wei
- `initiateWithdrawal(bytes32 commitment, address recipient, EdDSAPublicKey refundKey, uint256[8] proof, uint256 nullifier, uint256 signalY, uint256 payout)` - Start an exit with a settlement proof
- `finalizeWithdrawal(bytes32 commitment)` - Pay an exit after the challenge window; anyone can call it
- `slash(uint256 secretKey)` - Slash the note of a revealed key, for `SLASH_BOUNTY`
- `claimExpired(bytes32 commitment)` / `withdrawOperatorBalance()` - The operator's revenue
- `isKnownRoot(bytes32 root)`, `getNote`, `getLeaves`, `getMerkleProof` - Reads for clients and the server

The settlement proof's public signals are `[nullifier, signalY, payout, commitment, deposit, C_MAX, refundKeyX, refundKeyY, recipient, x]`, in the order snarkjs emits them; the contract fills in everything but the outputs. `pnpm check:verifiers` checks that `SettlementVerifier.sol` embeds the circuit's current verification key.

### Supporting Contracts

#### PoseidonHasher.sol
Wrapper library for Poseidon hash functions (uses poseidon-solidity). Provides convenience functions for hashing 1-5 field elements.

#### Verifier Contracts
- `SettlementVerifier.sol` - Groth16 verifier for withdrawal proofs, with a `verifySettlementProof` wrapper

**Critical:** All contracts use Poseidon hashing to maintain compatibility with the ZK circuits. Using Keccak256 would break proof verification.

## Building

Built with [Foundry](https://book.getfoundry.sh/).

### Prerequisites

```bash
# Install Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Install dependencies (poseidon-solidity)
cd .. && pnpm install
```

### Compile

```bash
forge build
```

### Test

```bash
# Run all tests
forge test

# Run with verbosity
forge test -vvv

# Run specific test
forge test --match-test test_Deposit_Success

# Gas report
forge test --gas-report
```

**Test Coverage:**
```bash
# Run coverage report
forge coverage
```

**Test Results:** the suite deposits, exits, slashes and rotates keys against the real `SettlementVerifier`, on proofs from `test/fixtures/settlement.json`. Regenerate them with `scripts/testing/generate-settlement-fixtures.ts` after changing the settlement circuit or its keys.

## Hash Function Compatibility ⚠️

**CRITICAL:** This contract uses **Poseidon** hashing, not Keccak256.

| Operation | Hash Function | Reason |
|-----------|---------------|--------|
| Note commitments and leaves | Poseidon | Must match ZK circuit |
| Merkle tree | Poseidon | Must match ZK circuit |
| Withdrawal signal `x` | Poseidon | Must match the settlement proof |
| Double-spend detection | Poseidon | Must match ZK circuit |

The circuit uses `circomlib/Poseidon`, and the contract uses `poseidon-solidity`. These are cryptographically identical.

**See:** [CHANGELOG_HASH_FIX.md](../docs/notes/CHANGELOG_HASH_FIX.md) for details on hash function compatibility.

## Deployment

### Local (Anvil)

```bash
# Terminal 1: Start local node
anvil

# Terminal 2: Deploy contract with Anvil account #0 and the dev refund-signer key
NODE_ENV=development forge script script/DeployLongjingCredits.s.sol:DeployLongjingCredits --rpc-url http://127.0.0.1:8545 --broadcast
```

`NODE_ENV=development` (or `test`) deploys to chain 31337 only.

### Testnet and mainnet

```bash
# Set environment variables, all required
export NODE_ENV=production
export PRIVATE_KEY=0x...
export SERVER_ADDRESS=0x...
# The enclave's refund signer, refundSigner.x / .y from GET /attestation/manifest
export SERVER_PUBKEY_X=0x...
export SERVER_PUBKEY_Y=0x...
export RPC_URL=https://sepolia.infura.io/v3/...

# Deploy
forge script script/DeployLongjingCredits.s.sol:DeployLongjingCredits \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify
```

### Required Constructor Parameters

```solidity
constructor(
    address _serverAddress,      // Operator: claims expired notes and operator revenue
    bytes32 _serverPubKeyX,      // Refund key, X coordinate
    bytes32 _serverPubKeyY,      // Refund key, Y coordinate
    uint256 _cMax,               // C_MAX, the most one request costs and the smallest deposit (e.g. 0.001 ether)
    uint256 _slashBounty         // SLASH_BOUNTY, what a slasher gets (e.g. 0.0001 ether)
)
```

## Dependencies

### npm Packages (via remappings)
- **poseidon-solidity** - Production-ready Poseidon hash implementation matching circomlib

### Foundry Libraries
- **forge-std** - Foundry testing utilities
- **openzeppelin-contracts** - ReentrancyGuard, Pausable, Ownable

### Remappings

See [remappings.txt](./remappings.txt):
```
poseidon-solidity/=../node_modules/poseidon-solidity/
@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/
forge-std/=lib/forge-std/src/
```

## Gas Optimization

Current gas costs (approximate):
Measured with `forge test -vvvv`:
- Deposit: ~1.2M gas (20 Poseidon hashes plus node storage)
- Initiate withdrawal: ~0.9M gas (proof verification and leaf removal)
- Finalize withdrawal: ~65k gas
- Slash: ~0.7M gas (leaf removal)

**Future optimizations:**
- Cheaper Poseidon for the tree
- Storage packing

## Security

### Audits
⚠️ **Not yet audited** - Do not use in production without professional audit.

### Known Limitations
1. **Merkle tree storage cost** - Stores all nodes on-chain for correct proof generation (gas intensive for large trees)
2. **Admin privileges** - the contract owner can change the settlement verifier, the server address and the refund key, only after a 7-day `ADMIN_DELAY`, longer than an exit takes. `C_MAX` and `SLASH_BOUNTY` are immutable

### Security Model
- **One stake** - the whole deposit D; each note pays out at most D in total
- **Challenge window** - an exit that understates usage is slashed before it pays out
- **Bounty, not stake** - a slasher gets `SLASH_BOUNTY`, so self-slashing recovers no spending
- **Pause** - blocks deposits and expiry claims, never an exit or a slash

## Development Commands

```bash
# Build contracts
forge build

# Run tests
forge test

# Run tests with gas report
forge test --gas-report

# Format code
forge fmt

# Generate documentation
forge doc

# Coverage report
forge coverage

# Deploy to local testnet
NODE_ENV=development forge script script/DeployLongjingCredits.s.sol:DeployLongjingCredits --rpc-url http://localhost:8545 --broadcast

# Interact with contract
cast call <CONTRACT_ADDRESS> "merkleRoot()" --rpc-url http://localhost:8545
```

## Architecture

```
contracts/
├── src/
│   ├── LongjingCredits.sol                    # Main contract
│   ├── PoseidonHasher.sol                  # Poseidon hash wrapper
│   └── SettlementVerifier.sol              # Settlement proof verifier (auto-generated)
├── test/
│   ├── LongjingCredits.t.sol                  # Foundry tests, on the real verifier
│   └── fixtures/settlement.json            # Real settlement proofs for the tests
├── script/
│   └── DeployLongjingCredits.s.sol           # Deployment script
├── lib/                                    # Foundry dependencies
├── remappings.txt                          # Import path mappings
└── foundry.toml                            # Foundry configuration
```

## Related Documentation

- [Smart Contract Overview](../docs/OVERVIEW.md#smart-contracts)
- [ZK Proof System](../docs/ZK.md)
- [Implementation Plan](../docs/notes/IMPLEMENTATION_PLAN.md)
- [Hash Function Fix Changelog](../docs/notes/CHANGELOG_HASH_FIX.md)
- [Testing Guide](../docs/TESTING_GUIDE.md)

## Foundry Resources

- [Foundry Book](https://book.getfoundry.sh/) - Complete Foundry documentation
- [Forge CLI Reference](https://book.getfoundry.sh/reference/forge/)
- [Cast CLI Reference](https://book.getfoundry.sh/reference/cast/)
- [Anvil Documentation](https://book.getfoundry.sh/reference/anvil/)

## Code Quality

### Solidity Version
All contracts use `pragma solidity 0.8.35;` for consistency and to avoid compiler warnings.

### NatSpec Documentation
All contracts include comprehensive NatSpec comments:
- `@title` - Contract/library title
- `@author` - Author attribution
- `@notice` - User-facing function description
- `@dev` - Developer notes and implementation details
- `@param` - Parameter descriptions
- `@return` - Return value descriptions

### Linting
Foundry linting is disabled during build (`lint_on_build = false`) to suppress warnings from auto-generated verifier contracts. Named imports are used throughout for clarity:
```solidity
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
```

### Static Analysis
CI runs [Slither](https://github.com/crytic/slither) 0.11.6 on `src/` with [slither.config.json](./slither.config.json), which gates findings of Low severity and above. It fails on any finding missing from [slither.baseline.json](./slither.baseline.json). To run it locally:
```bash
pip install slither-analyzer==0.11.6
pnpm check:slither
```
Fix a new finding if it's real. If it's a false positive or intended, add the entry the check prints to the baseline, with a `reason` saying why. Entries are keyed on the flagged function or variable, so a renamed or deleted one leaves a stale entry, which also fails the check.

## Contributing

When modifying contracts:
1. **Maintain Poseidon hash compatibility** - Never replace with Keccak256
2. **Run all tests** - `forge test`
3. **Run Slither** - `pnpm check:slither`
4. **Check coverage** - `forge coverage` (aim for >85% on core contracts)
5. **Check gas usage** - `forge test --gas-report`
6. **Format code** - `forge fmt`
7. **Update tests** - Add tests for new functionality
8. **Update NatSpec** - Keep documentation comprehensive and educational
9. **Document changes** - Update this README and related docs

## License

MIT
