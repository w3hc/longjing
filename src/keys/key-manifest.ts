/**
 * The EIP-712 key manifest the identity key signs, shared by the server and
 * the clients that verify it.
 */

export const KEY_MANIFEST_DOMAIN = { name: 'Longjing', version: '3' };
export const KEY_MANIFEST_TYPES = {
  KeyManifest: [
    { name: 'appId', type: 'address' },
    { name: 'refundSignerX', type: 'bytes32' },
    { name: 'refundSignerY', type: 'bytes32' },
    { name: 'tlsCertificateHash', type: 'bytes32' },
    { name: 'onionPublicKey', type: 'bytes32' },
    { name: 'txSignerAddress', type: 'address' },
    { name: 'epoch', type: 'uint64' },
  ],
};

export interface KeyManifest {
  appId: string;
  refundSignerX: string;
  refundSignerY: string;
  /** SHA-256 of the served TLS leaf certificate (DER), or zero if none. */
  tlsCertificateHash: string;
  /** ed25519 public key of the onion service. */
  onionPublicKey: string;
  /** Signs every contract transaction in production; needs gas. */
  txSignerAddress: string;
  epoch: number;
}

export interface SignedKeyManifest {
  manifest: KeyManifest;
  signature: string;
}
