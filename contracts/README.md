# Longjing - Smart Contracts

Solidity smart contracts for privacy-preserving API credits system using Zero-Knowledge proofs and Rate-Limit Nullifiers (RLN).

## Overview

The LongjingCredits contract implements:
- **Anonymous deposits** with identity commitments (Poseidon hash)
- **Dual staking** mechanism (RLN + Policy stakes)
- **Merkle tree** anonymity set using Poseidon hashing
- **Double-spend slashing** via RLN secret key extraction
- **Policy violation slashing** for ToS enforcement
- **Refund ticket redemption** with EdDSA signatures

## Contracts

### LongjingCredits.sol
Main contract implementing the RLN-based usage-credits protocol.

**Key Functions:**
- `deposit(bytes32 idCommitment)` - Deposit ETH with anonymous identity
- `withdraw(bytes32 idCommitment, address payable recipient, uint256[8] proof, uint256[6] publicSignals)` - Withdraw funds with ZK proof
- `slashDoubleSpend(bytes32 secretKey, bytes32 nullifier, bytes32 idCommitment, uint256[8] proof, uint256[4] publicSignals)` - Slash double-spenders and reward reporters
- `slashPolicyViolation(bytes32 nullifier, bytes32 idCommitment, uint256[8] proof, uint256[5] publicSignals)` - Slash ToS violators (server only)
- `redeemRefund(bytes32 idCommitment, bytes32 nullifier, uint256 refundValue, address payable recipient, uint256[8] proof, uint256[7] publicSignals)` - Redeem server-signed refund tickets

### Supporting Contracts

#### PoseidonHasher.sol
Wrapper library for Poseidon hash functions (uses poseidon-solidity). Provides convenience functions for hashing 1-5 field elements.

#### BabyJubJub.sol
Baby Jubjub elliptic curve operations for EdDSA signature verification. Implements point addition, scalar multiplication, and curve validation.

#### Verifier Contracts
- `WithdrawalVerifier.sol` - Groth16 verifier for withdrawal proofs
- `RefundRedemptionVerifier.sol` - Groth16 verifier for refund redemption proofs
- `DoubleSpendSlashingVerifier.sol` - Groth16 verifier for double-spend slashing proofs
- `PolicyViolationVerifier.sol` - Groth16 verifier for policy violation proofs

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

**Test Results:**
```
✅ All 24 tests passing
✅ 85.47% statement coverage on LongjingCredits.sol
✅ 86.96% function coverage on LongjingCredits.sol
✅ 50.00% branch coverage on LongjingCredits.sol
✅ Identity commitments use Poseidon hash
✅ Merkle tree uses Poseidon hash with full node storage
✅ Merkle proof generation verified for >2 leaves
✅ Refund redemption with EdDSA signature verification
✅ Double-spend slashing with secret key extraction
✅ Policy violation slashing (server-only)
```

## Hash Function Compatibility ⚠️

**CRITICAL:** This contract uses **Poseidon** hashing, not Keccak256.

| Operation | Hash Function | Reason |
|-----------|---------------|--------|
| Identity commitments | Poseidon | Must match ZK circuit |
| Merkle tree | Poseidon | Must match ZK circuit |
| Refund signatures | Poseidon | Must match ZK circuit |
| Double-spend detection | Poseidon | Must match ZK circuit |

The circuit uses `circomlib/Poseidon`, and the contract uses `poseidon-solidity`. These are cryptographically identical.

**See:** [CHANGELOG_HASH_FIX.md](../docs/notes/CHANGELOG_HASH_FIX.md) for details on hash function compatibility.

## Deployment

### Local (Anvil)

```bash
# Terminal 1: Start local node
anvil

# Terminal 2: Deploy contract with Anvil account #0 and the dev refund-signer key
PROFILE=local forge script script/DeployLongjingCredits.s.sol:DeployLongjingCredits --rpc-url http://127.0.0.1:8545 --broadcast
```

`PROFILE=local` deploys to chain 31337 only.

### Testnet and mainnet

```bash
# Set environment variables, all required
export PROFILE=prod
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
    address _serverAddress,      // Server address for policy slashing
    uint256 _minRlnStake,        // Minimum RLN stake (e.g., 0.005 ether)
    uint256 _minPolicyStake,     // Minimum policy stake (e.g., 0.005 ether)
    bytes32 _serverPubKeyX,      // Server EdDSA public key X coordinate
    bytes32 _serverPubKeyY       // Server EdDSA public key Y coordinate
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
- Deposit: ~220k gas
- Withdraw: ~225k gas
- Redeem refund: ~150k gas
- Slash double-spend: ~265k gas

**Future optimizations:**
- Incremental Merkle tree for cheaper deposits
- Batch refund redemption
- Storage packing

## Security

### Audits
⚠️ **Not yet audited** - Do not use in production without professional audit.

### Known Limitations
1. **Merkle tree storage cost** - Stores all nodes on-chain for correct proof generation (gas intensive for large trees)
2. **Admin privileges** - Contract owner can change minimum stakes instantly, and verifier contracts and the server address through `proposeChange` / `executeChange` after a 7-day `ADMIN_DELAY`

### Security Model
- **RLN stake** - Claimable by anyone proving double-spend
- **Policy stake** - Burned (sent to address(0)) for ToS violations
- **Refund nullifiers** - Prevents double-redemption
- **Secret key extraction** - Enables slashing of double-spenders

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
PROFILE=local forge script script/DeployLongjingCredits.s.sol:DeployLongjingCredits --rpc-url http://localhost:8545 --broadcast

# Interact with contract
cast call <CONTRACT_ADDRESS> "merkleRoot()" --rpc-url http://localhost:8545
```

## Architecture

```
contracts/
├── src/
│   ├── LongjingCredits.sol                    # Main contract
│   ├── PoseidonHasher.sol                  # Poseidon hash wrapper
│   ├── BabyJubJub.sol                      # EdDSA curve operations
│   ├── WithdrawalVerifier.sol              # Withdrawal proof verifier (auto-generated)
│   ├── RefundRedemptionVerifier.sol        # Refund proof verifier (auto-generated)
│   ├── DoubleSpendSlashingVerifier.sol     # Slashing proof verifier (auto-generated)
│   └── PolicyViolationVerifier.sol         # Policy proof verifier (auto-generated)
├── test/
│   ├── LongjingCredits.t.sol                  # Foundry tests (24 tests)
│   ├── MockWithdrawalVerifier.sol          # Mock verifier for testing
│   ├── MockRefundVerifier.sol              # Mock verifier for testing
│   ├── MockSlashingVerifier.sol            # Mock verifier for testing
│   └── MockPolicyVerifier.sol              # Mock verifier for testing
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

## Contributing

When modifying contracts:
1. **Maintain Poseidon hash compatibility** - Never replace with Keccak256
2. **Run all tests** - `forge test`
3. **Check coverage** - `forge coverage` (aim for >85% on core contracts)
4. **Check gas usage** - `forge test --gas-report`
5. **Format code** - `forge fmt`
6. **Update tests** - Add tests for new functionality
7. **Update NatSpec** - Keep documentation comprehensive and educational
8. **Document changes** - Update this README and related docs

## License

MIT
