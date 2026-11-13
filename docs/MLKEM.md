# ML-KEM and application-layer encryption

Longjing has no application-layer encryption. Clients don't encrypt requests to a key held by the server, and the server holds no long-lived decryption key. The only public-key encryption in the request path is TLS, terminated inside the enclave, and that is where ML-KEM is used.

## Where ML-KEM is used

In the TLS 1.3 key exchange only. The enclave offers the hybrid groups `SecP384r1MLKEM1024` and `X25519MLKEM768`, then plain `X25519` ([`src/tls/tls-groups.ts`](../src/tls/tls-groups.ts)). A hybrid group combines a classical exchange with ML-KEM ([FIPS 203](https://csrc.nist.gov/pubs/fips/203/final)), so a recording of today's traffic needs both broken. The keys are ephemeral, one pair per connection: a key recovered later decrypts nothing already recorded. See [ZK.md](ZK.md#cryptographic-assumptions) for the assumptions and [ATTESTATION.md](ATTESTATION.md) for how a client checks that TLS terminates in the enclave.

## Why there is no application-layer encryption

Up to v0.5.0, the enclave derived an ML-KEM-1024 key, served it in `GET /attestation` and bound it in `report_data`, with an encryption service and a `/secret/*` design built around it. Nothing on the server decrypted to it, so it protected nothing. It was removed in [#185](https://github.com/w3hc/longjing/issues/185), because:

- **Public-key encryption can't be built from hashes alone.** It rests on a structured assumption: discrete log on a curve, or lattices for ML-KEM. Structure is what cryptanalysis exploits, and AI-accelerated mathematics may find better attacks sooner than expected. The safest amount of it is the least the service needs.
- **A long-lived key has no forward secrecy.** Whoever recovers it reads everything ever encrypted to it. TLS keys are ephemeral, so the same break exposes one connection at most.
- **TLS already covers the path.** With TLS terminating inside the attested enclave, the operator and the network see neither direction. A second layer under it only adds a key to protect.
- **The removed code was unsound.** It wrapped the AES key by XOR with the raw ML-KEM shared secret, with no key derivation and no binding of the ciphertext to its recipient, and on lattices alone, with no classical half.

## If it comes back

A relay outside the enclave, such as a server-side route in a web app, terminates the client's TLS and reads the request. Forwarding a request the relay can't read needs a key held by the enclave. That is tracked in [#184](https://github.com/w3hc/longjing/issues/184): HPKE with a hybrid KEM at larger parameters, derived with `GetKey` and bound in `report_data`. Clients that reach the enclave directly don't need it, nor do clients that use its [`.onion` address](./ONION_SERVICE.md).
