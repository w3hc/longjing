# SQLite3 Database Implementation

## Overview

The nullifier store uses **better-sqlite3** for persistent storage of cryptographic data required for the zero-knowledge proof protocol. This document explains the implementation, privacy considerations, and design decisions.

## Database Architecture

### Location

- **Production**: `./data/nullifiers.db` (configurable via `DATA_DIR` environment variable)
- **Testing**: `:memory:` (in-memory database for isolation and speed)

### Tables

#### `nullifiers`

The only table: one row per spent nullifier, holding its RLN signal and nothing else ([SETTLEMENT.md](./SETTLEMENT.md#what-the-server-stores)).

```sql
CREATE TABLE nullifiers (
  nullifier TEXT PRIMARY KEY,
  x TEXT NOT NULL,
  y TEXT NOT NULL
);
```

**Columns** (decimal strings):
- `nullifier`: `N = Poseidon(Poseidon(k, i))`, fresh for every index
- `x`, `y`: the RLN signal. A second signal under the same `N` with a different `x` reveals `k`

**Why we store this:**
- A replay or a second request at a used index is refused
- A double-spend, during a request or an exit, reveals the secret key, and the note is slashed
- An exit's nullifier is stored too, so its index can't be used afterwards

Signed responses are kept in memory for 10 minutes, keyed by `N`, so a client that lost one can retry without being charged again. They never reach the database.

## Privacy Design

### What We DON'T Store

❌ **Payloads, payload hashes and responses**: `x = Poseidon(SHA-256(payload) mod p, ρ)` is bound to a nonce the server forgets, so a stored `x` can't confirm a guessed prompt
❌ **Commitments, leaves, deposit amounts and ticket indices**: the request never contains them
❌ **Timestamps**: nothing needs them, and they help timing correlation

### What We DO Store

✅ **Nullifiers** - Needed to prevent replays
✅ **RLN signals** - Needed for double-spend detection

### Privacy Guarantees

1. **No Content Storage**: requests and responses never touch the database
2. **No Linkage**: with full database access, nobody can tell which deposit made a request, or which requests share a user. Nullifiers are fresh per index, and `(x, y)` is one point on a line only the user knows

### What Server Maintainers CAN See

⚠️ **Usage Metrics**:
- Total number of API requests
- Double-spend attempts

⚠️ **Potential Timing Correlation**:
- The database holds no timestamps, but the operator's network sees when requests arrive. If only one user deposits at 10:00 AM and a request appears at 10:05 AM, timing suggests correlation
- Mitigation: Users should deposit in advance or during high-activity periods ([#99](https://github.com/w3hc/longjing/issues/99))

## Implementation

### Service: `NullifierStoreService`

**File**: [src/longjing/nullifier-store.service.ts](../src/longjing/nullifier-store.service.ts)

```typescript
// Atomically record (N, x, y); returns the stored signal if N was already spent
checkAndSet(nullifier: string, signal: { x: string; y: string }): StoredSignal | null

get(nullifier: string): StoredSignal | null
exists(nullifier: string): boolean
count(): number

// The 10-minute retry cache, in memory
rememberResponse<T>(nullifier: string, signal: StoredSignal, response: T): void
recallResponse<T>(nullifier: string, signal: StoredSignal): T | null

// Per-nullifier rate limiting, in memory
checkRateLimit(nullifier: string): boolean
```

## Database Migration

Earlier versions stored a timestamp, the payload hash, the ticket index and the identity commitment with every signal, and kept a `redeemed_refunds` table. On startup, the service rebuilds an old `nullifiers` table with only `(nullifier, x, y)`, drops `redeemed_refunds` and the timestamp index in one transaction, then runs `VACUUM` so the freed pages don't keep the dropped values. A database already in the new shape is left alone.

## Configuration

### Environment Variables

```bash
# Set custom database location
export DATA_DIR=/path/to/data

# Use in-memory database (testing)
export DATA_DIR=:memory:
```

### Testing Configuration

Tests automatically use in-memory databases:

```typescript
// Unit tests (src/longjing/longjing.service.spec.ts)
beforeEach(async () => {
  process.env.DATA_DIR = ':memory:';
  // ...
});

// E2E tests (test/*.e2e-spec.ts)
beforeAll(async () => {
  process.env.DATA_DIR = ':memory:';
  // ...
});
```

## Security Considerations

### ✅ Protected Against

1. **Database File Theft**: Attacker gains nothing - no sensitive data stored
2. **Server Admin Snooping**: Cannot see user requests or identify users
3. **Replay Attacks**: Nullifiers prevent reusing the same proof
4. **Double-Spending**: Signal comparison enables secret key extraction

### ⚠️ Limitations

1. **Timing Analysis**: Correlation between deposits and usage patterns
2. **Usage Metadata**: Request counts are visible; arrival times are visible on the network, not in the database
3. **Not Encrypted**: Database is plaintext (but contains no sensitive data)

### Why No Encryption?

We chose **not** to encrypt the database because:

1. **No Sensitive Data**: Only cryptographic values are stored
2. **Encryption Illusion**: Server admin with root access can always get the encryption key
3. **Simpler & Faster**: No key management overhead
4. **True Privacy**: Don't store what you don't need (zero-knowledge approach)

If identifiers or payloads were stored, encryption would be mandatory. The database holds only `(N, x, y)`, so encryption provides no additional privacy benefit.

### Private Key Management

The EdDSA private key used for signing refund accumulators is **never stored on disk**. Instead, it's managed through `SecretsService`:

**🏠 Local Development**:
```bash
export OPERATOR_PRIVATE_KEY=0x1234...
# Or let it auto-generate a deterministic dev key
```

**☁️ Basic Ubuntu VPS** (no TEE):
```bash
NODE_ENV=production
OPERATOR_PRIVATE_KEY=0x5678...  # In .env or systemd service
```

**🔐 Phala TEE** (production):
```bash
NODE_ENV=production
OPERATOR_PRIVATE_KEY=0xabcd...  # Encrypted by Phala Cloud
```

**🔒 Cloud with KMS** (AWS/GCP/Azure):
```bash
NODE_ENV=production
KMS_URL=https://kms.example.com/secrets
# Key fetched from KMS using TEE attestation
```

The private key exists **only in memory** and is loaded via `SecretsService` which handles all deployment scenarios. See `src/config/secrets.service.ts` for implementation details.

## Double-Spend Detection

### How It Works

1. **First Request**: Store nullifier + signal (x, y)
2. **Duplicate Nullifier**: Check if signal matches
   - Same signal → Replay attack (reject)
   - Different signal → Double-spend (extract secret key, slash user)

### Secret Key Extraction

Given two signals for the same nullifier:
- Signal 1: `y₁ = secretKey + a * x₁`
- Signal 2: `y₂ = secretKey + a * x₂`

The secret key can be extracted:
```
secretKey = (y₂ - y₁) / (x₂ - x₁) - a
```

This is why we **must** store both x and y coordinates.

## Performance

### Indexing

- **Primary Key**: `nullifier` column (O(log n) lookups)
- **Prepared Statements**: All queries use prepared statements for safety and speed

### Benchmarks

Typical performance on SQLite:
- Insert: ~0.01ms per nullifier
- Lookup: ~0.01ms per nullifier
- No performance degradation up to millions of records

## Backup & Recovery

### Backup Strategy

```bash
# Manual backup
cp data/nullifiers.db data/nullifiers.db.backup

# Automated backup (recommended)
sqlite3 data/nullifiers.db ".backup data/nullifiers.db.$(date +%Y%m%d)"
```

### Recovery

```bash
# Restore from backup
cp data/nullifiers.db.backup data/nullifiers.db
```

### Data Loss Impact

If the database is lost:
- ✅ System continues to function
- ❌ Nullifier history is lost: a request at a used index is no longer refused, and an understated exit can't be challenged
- ⚠️ Mitigation: Regular backups; exit nullifiers come back from `WithdrawalInitiated` events

## Future Improvements

### Potential Enhancements

1. **Nullifier Expiration**: Drop the nullifiers of closed notes, which can no longer be challenged
3. **Distributed Storage**: Replicate to multiple nodes
4. **Read Replicas**: Scale read operations
5. **Compression**: Compress old data

### Not Planned

- ❌ **Encryption**: No benefit without sensitive data
- ❌ **Payload Storage**: Privacy is more important
- ❌ **User Tracking**: Goes against zero-knowledge principles

## Comparison: Other Approaches

| Approach | Privacy | Persistence | Complexity | Performance |
|----------|---------|-------------|------------|-------------|
| **In-Memory** | ⚠️ Lost on restart | ❌ No | ✅ Simple | ✅ Fast |
| **Redis** | ⚠️ Lost on restart | ⚠️ Optional | ⚠️ Medium | ✅ Very Fast |
| **PostgreSQL** | ✅ Persistent | ✅ Yes | ⚠️ Medium | ✅ Fast |
| **SQLite (ours)** | ✅ Persistent | ✅ Yes | ✅ Simple | ✅ Fast |

**Why SQLite?**
- ✅ No separate server needed
- ✅ Zero configuration
- ✅ File-based (easy backups)
- ✅ Fast enough for our use case
- ✅ ACID transactions
- ✅ Battle-tested and reliable

## Monitoring

### Health Checks

```typescript
// Check database connectivity
const count = nullifierStore.count();
if (count >= 0) {
  // Database is healthy
}
```

### Metrics to Track

- Nullifier count growth rate
- Double-spend attempt frequency
- Database file size
- Query latency (if performance issues arise)

## References

- [better-sqlite3 Documentation](https://github.com/WiseLibs/better-sqlite3)
- [RLN (Rate Limiting Nullifier)](https://rate-limiting-nullifier.github.io/rln-docs/)
- [Zero-Knowledge Proofs](https://en.wikipedia.org/wiki/Zero-knowledge_proof)
- [SQLite Documentation](https://www.sqlite.org/docs.html)

## Summary

The SQLite implementation provides:

✅ **Privacy**: No user content stored
✅ **Persistence**: Survives server restarts
✅ **Security**: Prevents double-spending and replay attacks
✅ **Simplicity**: No external dependencies
✅ **Performance**: Fast enough for production use
✅ **Reliability**: Battle-tested database engine

The key insight is that **true privacy comes from not storing sensitive data**, not from encrypting it. The store keeps only `(N, x, y)`: enough to stop replays and catch double-spends, and nothing that identifies a user or a request.
