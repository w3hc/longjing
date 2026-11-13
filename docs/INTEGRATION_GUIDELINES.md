# Integration Guidelines

How to call Longjing from an app, an agent or a browser without giving up what the protocol protects. Tracks [#99](https://github.com/w3hc/longjing/issues/99).

The proofs make a request carry nothing that links it to a deposit or to another request ([ZK.md](./ZK.md#privacy-guarantees)). What a client adds around the request can undo that: its IP address, a reused connection or circuit, a cookie, a header. This guide covers network identity and attestation. It doesn't cover request timing and size, which still correlate requests until padding lands ([#189](https://github.com/w3hc/longjing/issues/189)).

## Table of Contents

- [Rules](#rules)
- [Verify the attestation before sending anything](#verify-the-attestation-before-sending-anything)
- [Daemons and agents: a circuit per request](#daemons-and-agents-a-circuit-per-request)
- [Tor Browser](#tor-browser)
- [Verifying in the browser](#verifying-in-the-browser)
- [CORS](#cors)
- [Relays](#relays)

## Rules

1. Reach the gateway at its `.onion` address ([ONION_SERVICE.md](./ONION_SERVICE.md)), not through a Tor exit node or the clearnet: an onion service needs no exit node and no DNS.
2. Verify the attestation with a fresh nonce before the first request, and send nothing if it fails.
3. Pin the TLS certificate the attestation binds, and the `.onion` address it binds.
4. Use a new connection and a new Tor circuit for every request. Never reuse a keep-alive connection across requests: the gateway sees which requests share it.
5. Send no cookies, no `Authorization` header and nothing that identifies the user or the app instance. The API needs none.
6. When Tor is configured and unavailable, fail closed: never fall back to a direct connection.
7. The secret key and the accumulator opening stay on the user's device. Nothing that needs them runs on a server.

## Verify the attestation before sending anything

The reference client does this in [`openGateway`](../src/client/gateway.ts), which `pnpm prove send`, `pnpm demo` and the browser client use. It is the only way the client gets a function that sends requests:

1. Draw 32 random bytes and fetch `GET /attestation?nonce=<64 hex chars>`.
2. Fetch `GET /attestation/manifest` over a session with the same certificate.
3. Check the attestation ([`checkAttestation`](../src/client/gateway.ts), on top of [`verifyKeyBinding`](../src/attestation/key-binding.ts)):
   - the platform is `phala`, a dstack TDX quote, and the event log replays to the quote's RTMR0–3;
   - `report_data`, both in the response and inside the quote, commits to the returned keys and to your nonce, so it is fresh ([ATTESTATION.md](./ATTESTATION.md#report_data));
   - the certificate of the TLS session that returned the attestation is `keys.tlsCertificate`, so TLS terminates in the enclave;
   - `onionAddress` is the address of `keys.onionPublicKey`, and a `.onion` host you connected to is that address;
   - the key manifest signs the same keys with the identity key.
4. On any failure, throw and send nothing. Otherwise send each request over a new TLS session whose certificate is checked against the bound one before anything is written.

The client doesn't verify the quote signature or compare the measurements and compose hash with a published release. Do that once per release with `pnpm verify:attestation` and the platform's verification service ([ATTESTATION.md](./ATTESTATION.md#verification)), and keep what you checked: the onion address and the certificate are stable across restarts of the same build.

Every HTTPS client offers the hybrid post-quantum groups (`TLS_CLIENT_GROUPS` in [`tls-groups.ts`](../src/tls/tls-groups.ts)). Inside the onion, onion service handshakes are classical, so TLS is the only post-quantum layer.

## Daemons and agents: a circuit per request

Run a local `tor` and send each request through its SOCKS port with a random username and password. `IsolateSOCKSAuth`, on by default for every `SocksPort`, puts streams with different credentials on different circuits, so each request gets its own circuit without restarting tor, and parallel requests work ([tor manual](https://2019.www.torproject.org/docs/tor-manual.html.en)).

```text
# torrc
SocksPort 127.0.0.1:9050 IsolateSOCKSAuth
```

```bash
pnpm prove request note.json "Hello"
pnpm prove send note.json https://<address>.onion --socks 127.0.0.1:9050
```

[`nodeTransport`](../scripts/client/transport.ts) does it: for every request it opens a new SOCKS5 connection with 16 random bytes as username and password, asks tor to connect to the `.onion` host by name, so no local DNS lookup happens, then runs TLS over it. Tor Browser keeps one circuit per site for about ten minutes, so a client that needs a circuit per request can't rely on it.

### Failing closed

If the SOCKS port doesn't answer, `nodeTransport` throws `Tor is configured but its SOCKS port ... is unreachable: nothing was sent`. It never retries without Tor. An integration should do the same: treat a missing or broken Tor as an error the user sees, not a reason to send in the clear, and don't offer a setting that silently disables Tor.

## Tor Browser

A page opened in Tor Browser can call the `.onion` API directly: Tor Browser routes it through Tor, and the gateway sees no IP address.

- Open `https://<address>.onion`. The certificate is issued by the app's dstack KMS CA, not a public CA, and doesn't name the `.onion` address, so Tor Browser shows a certificate warning. Check the address first, against an attestation you verified (for instance with `pnpm verify:attestation https://<address>.onion/attestation --socks 127.0.0.1:9150`), then accept the exception for that address only.
- On the `.onion` path, the address authenticates the far end: only the holder of the onion service key can serve it, and that key is derived in the enclave and bound in `report_data`. tor runs in the enclave, so the onion connection ends there too.
- Tor Browser reuses a circuit per site for about ten minutes. Use "New Tor circuit for this site" between requests, or accept that requests sent in that window share a circuit.
- A page served from another origin, such as your app's own `.onion`, needs that origin in the gateway's [`CORS_ORIGINS`](#cors).

## Verifying in the browser

The [browser client](./API_REFERENCE.md#browser-client) runs the same checks as `openGateway`, through `fetchTransport`, with one difference: JavaScript can't see the TLS certificate of its session, so it can't pin it.

- It draws the nonce with `crypto.getRandomValues`, and sends it as `GET /attestation?nonce=<hex>`.
- It rebuilds `report_data` over the length-prefixed terms ([ATTESTATION.md](./ATTESTATION.md#report_data)), with the same code as the server and the Node client (SHA-256 and SHA3-256 from `@noble/hashes`), and checks it equals `reportData` and bytes 568–632 of the quote.
- It recomputes the `.onion` address from `keys.onionPublicKey`, and checks it equals `onionAddress` and the host it calls.
- Since the certificate can't be pinned, the onion address is what binds the session to the enclave: outside development, `openGateway` refuses a `fetchTransport` whose host isn't a `.onion` address. Over the clearnet, a browser has nothing to pin, and a client that needs the certificate check should run outside the browser.
- It sends nothing when a check fails. Verify again on every page load.

Keep the transport the only environment-specific part: [`gateway.ts`](../src/client/gateway.ts) takes any transport.

## CORS

Production allows browser calls only from the exact origins listed in `CORS_ORIGINS`, comma-separated, such as `https://app.longjing.dev,http://<app>.onion`. Empty, the default, allows none. Wildcards and the `null` origin are refused at startup. Credentials are never allowed, since the API uses no cookies. Development allows any origin when `CORS_ORIGINS` is empty.

CORS only decides which pages may read responses in a browser. It isn't access control: anyone can call the API from outside a browser.

## Relays

Don't put a server between the user and the gateway. A relay, such as an app's backend calling the API for its users, sees the prompt and the user's network identity, and can link the requests it forwards. A request sealed so that a relay can't read it is tracked in [#184](https://github.com/w3hc/longjing/issues/184). Until then, call the gateway from the user's device.
