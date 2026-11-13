# Onion Service

The gateway runs a [v3 onion service](https://spec.torproject.org/rend-spec/) inside the enclave, so clients can reach the API without a Tor exit node or DNS. Its key is derived in the enclave and its public key is bound into the attestation, so a client checks that the `.onion` address it connects to is the enclave's before it sends anything. Tracks [#99](https://github.com/w3hc/longjing/issues/99).

The onion service hides the client's network identity from the operator and from the network. It doesn't hide request timing or size, see [#189](https://github.com/w3hc/longjing/issues/189).

## Table of Contents

- [How it runs](#how-it-runs)
- [The key](#the-key)
- [The address](#the-address)
- [TLS inside the onion](#tls-inside-the-onion)
- [Production and development](#production-and-development)
- [Reproducible image](#reproducible-image)

## How it runs

tor is installed in the gateway's image and started by the gateway itself ([`tor-process.ts`](../src/tor/tor-process.ts), [`onion.service.ts`](../src/tor/onion.service.ts)), so the image digest pinned in the attested `docker-compose.yml` covers it. At boot, after the keys are derived:

1. The gateway spawns tor with every option on its command line and no torrc: no SOCKS port, a control socket in a fresh `0700` temporary directory, cookie authentication, `SafeLogging 1`, warnings only, to stderr.
2. It authenticates with the cookie and sends `TAKEOWNERSHIP`, so tor exits when the gateway does.
3. It adds the onion service with `ADD_ONION ED25519-V3:<key> Port=443,127.0.0.1:3000` and checks that tor's `ServiceID` is the address it computed from the derived key.

The service lives as long as the control connection. If tor exits in production, the gateway exits too, and the container restarts. The gateway never logs onion circuits or anything about clients: an onion service doesn't see client addresses, and tor's own log stays at warnings with `SafeLogging`.

## The key

The key is derived from the dstack KMS like the other keys, with `GetKey("longjing/onion-service/v1", "ed25519")`, see [KEY_DERIVATION.md](./KEY_DERIVATION.md#onion-service-key). Every instance of the app gets the same key, so the address survives restarts and redeploys of the same app.

The key goes to tor only through the control socket, as the 64-byte expanded secret key `ADD_ONION` takes ([control-spec](https://spec.torproject.org/control-spec/commands.html#add_onion)). Nothing writes it to disk: there is no `HiddenServiceDir`, and tor's data directory, which holds only its network state, is a temporary directory deleted when tor exits.

## The address

```text
address = base32(public_key || SHA3-256(".onion checksum" || public_key || 0x03)[:2] || 0x03) + ".onion"
```

as Tor's [rend-spec](https://spec.torproject.org/rend-spec/encoding-onion-addresses.html) defines, implemented in [`onion-key.ts`](../src/tor/onion-key.ts) and tested against tor's own vector.

To read it:

- `GET /attestation` returns it as `onionAddress`, and its public key as `keys.onionPublicKey`, which `report_data` binds ([ATTESTATION.md](./ATTESTATION.md#report_data)).
- `GET /attestation/manifest` returns it under `onionService`, and the signed manifest carries `onionPublicKey`.
- The gateway logs `Onion service: <address>` at boot.

A client recomputes the address from `keys.onionPublicKey`, and refuses a `.onion` host that isn't it.

## TLS inside the onion

The onion's port 443 forwards to the gateway's HTTPS listener, so TLS still terminates in the enclave, behind the onion. Onion service handshakes are classical, so the hybrid ML-KEM key exchange of the in-enclave TLS ([TEE_SETUP.md](./TEE_SETUP.md)) is the only post-quantum layer inside the onion. There is no plain HTTP port on the onion for that reason.

The certificate comes from dstack's `GetTlsKey`, signed by the app's KMS CA, not a public CA, and it doesn't name the `.onion` address. Clients pin it through the attestation, which binds `SHA-256(certificate)`, not through WebPKI. A browser can't see the certificate from JavaScript, so Tor Browser shows a certificate warning for `https://<address>.onion`; see [INTEGRATION_GUIDELINES.md](./INTEGRATION_GUIDELINES.md#tor-browser) for what a browser client checks instead.

## Production and development

- With `NODE_ENV=production`, the onion service always runs, and the gateway refuses to start if tor doesn't start or adds another address. `ONION_SERVICE` is refused. `docker-compose.yml` needs no setting for it.
- With `NODE_ENV=development` or `test`, it runs only with `ONION_SERVICE=true`, which also needs derived keys (the [dstack simulator](./KEY_DERIVATION.md#development)) and `tor` on the `PATH`. A failure is logged and the gateway starts without it. `pnpm demo` doesn't use Tor.

Under `ALLOW_KEYS_OUTSIDE_ENCLAVE=true`, when `GetKey` fails, there is no key and no onion service.

## Reproducible image

tor comes from Alpine's package repository, pinned with its dependencies in the [`Dockerfile`](../Dockerfile). A rebuild installs the same files, or fails once Alpine replaces one of those versions: bumping them is then a deliberate change, checked by the reproducible-build job. `--no-scripts` skips the `tor` user the package would add, since tor runs as `node`, and `--no-logfile` keeps the build time out of the image.
