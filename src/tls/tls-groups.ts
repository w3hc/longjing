// SPDX-License-Identifier: LGPL-3.0
// Copyright (C) 2026 Julien Béranger and the W3HC

/**
 * TLS 1.3 key exchange groups: hybrid ML-KEM first, X25519 as the classical
 * fallback, never OpenSSL's DEFAULT list (CVE-2026-2673).
 *
 * The server ranks "/"-separated tuples in its own order but follows the
 * client's order within a tuple, so each group sits in its own tuple: a
 * client offering both hybrid groups gets SecP384r1MLKEM1024 whatever its
 * order. See SSL_CTX_set1_groups_list(3).
 */
export const TLS_SERVER_GROUPS = 'SecP384r1MLKEM1024/X25519MLKEM768/X25519';

/**
 * What the reference client offers. A client ignores tuples and sends a key
 * share for the leftmost group only.
 */
export const TLS_CLIENT_GROUPS = 'SecP384r1MLKEM1024:X25519MLKEM768:X25519';
