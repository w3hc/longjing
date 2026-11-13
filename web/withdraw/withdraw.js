'use strict';

/*
 * The withdrawal page: proves a note's exit with the browser client
 * (window.Longjing) and sends initiateWithdrawal, then finalizeWithdrawal
 * after the challenge window. The only network requests go to the RPC (or
 * through the browser wallet), and to the mirror if the user loads the
 * circuit files from one. Nothing is stored: the contract holds the exit.
 */
(() => {
  const L = window.Longjing;
  const { ethers } = L;

  const ABI = [
    ...L.NOTE_ABI,
    'function exits(bytes32) view returns (uint256 nullifier, uint256 signalX, uint256 signalY, uint256 payout, address recipient, uint256 exitAt)',
    'error ZeroAddress()',
    'error NoteNotActive()',
    'error NoteNotExiting()',
    'error UnknownRefundKey()',
    'error PayoutExceedsDeposit()',
    'error InvalidProof()',
    'error ChallengeWindowOpen()',
  ];
  const errors = new ethers.Interface(ABI);
  const STATUS = [
    'unknown',
    'active',
    'exiting',
    'closed',
    'slashed',
    'expired',
  ];
  const KINDS = ['wasm', 'zkey'];
  // Pinned names, and the flat names the release and its mirrors use
  const PINNED = {
    wasm: L.artifactName('settlement', 'wasm'),
    zkey: L.artifactName('settlement', 'zkey'),
  };
  const PUBLISHED = { wasm: 'settlement.wasm', zkey: 'settlement.zkey' };

  const $ = (id) => document.getElementById(id);
  const files = { wasm: null, zkey: null };
  const rpcProviders = new Map();
  let walletProvider = null;
  let onchain = null;

  function show(id, text, ok) {
    const out = $(id);
    out.textContent = text;
    out.className = ok === undefined ? '' : ok ? 'ok' : 'bad';
  }

  function message(error) {
    const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data;
    if (typeof data === 'string' && data.length >= 10) {
      try {
        return `The contract refused it: ${errors.parseError(data).name}`;
      } catch {
        // not one of the contract's errors
      }
    }
    if (error?.revert?.name) {
      return `The contract refused it: ${error.revert.name}`;
    }
    return error?.shortMessage ?? error?.message ?? String(error);
  }

  /** Runs a button's action, with the button disabled while it runs */
  function onClick(id, out, run) {
    $(id).addEventListener('click', async () => {
      $(id).disabled = true;
      try {
        await run();
      } catch (error) {
        show(out, message(error), false);
      } finally {
        if (id !== 'finalize') $(id).disabled = false;
      }
    });
  }

  const eth = (wei) => `${ethers.formatEther(wei)} ETH`;

  function address(value, what) {
    try {
      return ethers.getAddress(value.trim());
    } catch {
      throw new Error(`${what} is not a valid address`);
    }
  }

  function parseNote() {
    let note;
    try {
      note = JSON.parse($('note').value);
    } catch {
      throw new Error('The note is not valid JSON');
    }
    const opening = note?.opening;
    const isNote =
      typeof note?.secretKey === 'string' &&
      ['refunds', 'index', 'blinding'].every(
        (field) => typeof opening?.[field] === 'string',
      );
    if (!isNote) {
      throw new Error(
        'This is not a note file: it has no secretKey or opening',
      );
    }
    return { signature: null, signedBy: null, pending: null, ...note };
  }

  /** Fills the contract and RPC fields from the note when they are empty */
  function prefill() {
    try {
      const note = JSON.parse($('note').value);
      if (!$('contract').value && typeof note.contract === 'string') {
        $('contract').value = note.contract;
      }
      if (!$('rpc').value && typeof note.rpcUrl === 'string') {
        $('rpc').value = note.rpcUrl;
      }
    } catch {
      // not JSON yet
    }
  }

  /** One provider per RPC URL, on the chain the RPC reports */
  async function rpcProvider(url) {
    if (!rpcProviders.has(url)) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_chainId',
          params: [],
        }),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }).catch(() => {
        throw new Error(
          `Couldn't reach ${url}: is it up, and does it allow CORS?`,
        );
      });
      const { result } = await response.json().catch(() => ({}));
      if (typeof result !== 'string') {
        throw new Error(`${url} didn't answer eth_chainId`);
      }
      const provider = new ethers.JsonRpcProvider(url, Number(result), {
        staticNetwork: true,
        pollingInterval: 1000,
        cacheTimeout: -1,
      });
      rpcProviders.set(url, provider);
    }
    return rpcProviders.get(url);
  }

  async function connect() {
    const contract = address($('contract').value, 'The contract address');
    if ($('mode-wallet').checked) {
      if (!window.ethereum) {
        throw new Error(
          'No browser wallet found: install one, or use an RPC URL and a signer key',
        );
      }
      walletProvider ??= new ethers.BrowserProvider(window.ethereum);
      const provider = walletProvider;
      return { contract, provider, signer: () => provider.getSigner() };
    }
    const url = $('rpc').value.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      throw new Error('The RPC URL must start with http:// or https://');
    }
    const provider = await rpcProvider(url);
    const signer = () => {
      const key = $('signer').value.trim();
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
        throw new Error('The signer key must be 32 bytes in hex');
      }
      return new ethers.Wallet(key, provider);
    };
    return { contract, provider, signer: async () => signer() };
  }

  async function send(connection, tx, out, what) {
    const signer = await connection.signer();
    show(out, `Sending ${what}…`);
    const sent = await signer.sendTransaction(tx);
    show(out, `Waiting for ${what} in ${sent.hash}…`);
    const receipt = await sent.wait();
    if (receipt?.status !== 1) throw new Error(`${what} failed: ${sent.hash}`);
    return sent.hash;
  }

  async function readNote() {
    const note = parseNote();
    const { contract, provider } = await connect();
    const credits = new ethers.Contract(contract, ABI, provider);
    const commitment = await L.commitmentOf(note);
    const [found, cMax, network] = await Promise.all([
      credits.getNote(commitment),
      credits.C_MAX(),
      provider.getNetwork(),
    ]);
    const status = STATUS[Number(found.status)] ?? 'unknown';
    $('commitment').value = commitment;
    if (Number(found.status) === 0) {
      onchain = null;
      throw new Error(
        `No note ${commitment} in ${contract} on chain ${network.chainId}: check the contract address and the RPC`,
      );
    }
    const used = BigInt(note.opening.index) + (note.pending ? 1n : 0n);
    onchain = { amount: found.amount, cMax, refunds: note.opening.refunds };
    $('claimed').min = note.opening.index;
    $('claimed').value = used.toString();
    show(
      'note-status',
      [
        `Commitment ${commitment}`,
        `Chain ${network.chainId}, status ${status}`,
        `Deposit D = ${eth(found.amount)}, refunds R = ${eth(note.opening.refunds)}`,
        `C_MAX = ${eth(cMax)}`,
        `Requests made: ${note.opening.index}${note.pending ? ', and one whose response was lost' : ''}`,
      ].join('\n'),
      status === 'active',
    );
    updatePayout();
  }

  function claimed() {
    const value = $('claimed').value.trim();
    if (!/^\d+$/.test(value)) throw new Error('n must be a whole number');
    return BigInt(value);
  }

  function updatePayout() {
    if (!onchain) return;
    try {
      const n = claimed();
      const payout =
        onchain.amount + BigInt(onchain.refunds) - n * onchain.cMax;
      if (payout < 0n) {
        show(
          'payout',
          'n · C_MAX is more than D + R: nothing to withdraw',
          false,
        );
      } else {
        show('payout', `Payout D + R − n · C_MAX = ${eth(payout)}`);
      }
    } catch (error) {
      show('payout', message(error), false);
    }
  }

  async function useFile(kind, source) {
    files[kind] = null;
    show(`${kind}-status`, 'Checking…');
    try {
      files[kind] = await L.loadArtifact(PINNED[kind], source);
      show(`${kind}-status`, 'Matches the pinned sha256', true);
    } catch (error) {
      show(
        `${kind}-status`,
        error instanceof TypeError
          ? `Couldn't fetch it: does the mirror allow CORS? (${error.message})`
          : message(error),
        false,
      );
    }
  }

  async function initiate() {
    const note = parseNote();
    const connection = await connect();
    const recipient = address($('recipient').value, 'The recipient');
    const n = claimed();
    if (!files.wasm || !files.zkey) {
      throw new Error('Load settlement.wasm and settlement.zkey first');
    }
    const notNeeded = () => {
      throw new Error('An exit needs no request circuit');
    };
    const client = L.createClient({
      artifacts: {
        settlement: { wasm: files.wasm, zkey: files.zkey },
        request: { wasm: notNeeded, zkey: notNeeded },
      },
      provider: () => connection.provider,
    });
    const target = { ...note, contract: connection.contract };
    show('initiate-status', 'Proving the withdrawal, which takes a minute…');
    const args = await client.proveWithdrawal(target, recipient, n);
    const hash = await send(
      connection,
      L.initiateWithdrawalTx(target, args),
      'initiate-status',
      'initiateWithdrawal',
    );
    $('commitment').value = args.commitment;
    show(
      'initiate-status',
      `Initiated in ${hash}: ${eth(args.payout)} to ${args.recipient} once the challenge window ends. To finalize later, keep the commitment ${args.commitment}.`,
      true,
    );
    await checkExit();
  }

  async function checkExit() {
    $('finalize').disabled = true;
    const commitment = $('commitment').value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(commitment)) {
      throw new Error('The commitment is 32 bytes in hex, 0x…');
    }
    const { contract, provider } = await connect();
    const credits = new ethers.Contract(contract, ABI, provider);
    const [note, exit, block] = await Promise.all([
      credits.getNote(commitment),
      credits.exits(commitment),
      provider.getBlock('latest'),
    ]);
    const status = STATUS[Number(note.status)] ?? 'unknown';
    if (status === 'closed') {
      show(
        'exit-status',
        `The exit is final: ${eth(exit.payout)} paid to ${exit.recipient}`,
        true,
      );
      return;
    }
    if (status !== 'exiting') {
      show('exit-status', `No exit to finalize: the note is ${status}`, false);
      return;
    }
    const ends = new Date(Number(exit.exitAt) * 1000).toISOString();
    const open = BigInt(block.timestamp) < exit.exitAt;
    show(
      'exit-status',
      [
        `Pays ${eth(exit.payout)} to ${exit.recipient}`,
        open
          ? `The challenge window ends at ${ends}, chain time: finalize after that`
          : `The challenge window ended at ${ends}: ready to finalize`,
      ].join('\n'),
      !open,
    );
    $('finalize').disabled = open;
  }

  async function finalize() {
    const commitment = $('commitment').value.trim();
    const connection = await connect();
    const hash = await send(
      connection,
      L.finalizeWithdrawalTx({ contract: connection.contract }, commitment),
      'finalize-status',
      'finalizeWithdrawal',
    );
    show('finalize-status', `Finalized in ${hash}`, true);
    await checkExit();
  }

  $('release').textContent = L.ARTIFACT_RELEASE.split('/').pop();
  for (const kind of KINDS) {
    const term = document.createElement('dt');
    term.textContent = `sha256 of ${PUBLISHED[kind]}`;
    const value = document.createElement('dd');
    value.textContent = L.ARTIFACT_HASHES[PINNED[kind]];
    $('pins').append(term, value);
    $(`${kind}-file`).addEventListener('change', (event) => {
      const [file] = event.target.files;
      if (file) {
        void useFile(
          kind,
          async () => new Uint8Array(await file.arrayBuffer()),
        );
      }
    });
  }

  for (const id of ['mode-rpc', 'mode-wallet']) {
    $(id).addEventListener('change', () => {
      $('rpc-fields').hidden = $('mode-wallet').checked;
    });
  }
  $('note-file').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    $('note').value = await file.text();
    prefill();
  });
  $('note').addEventListener('input', prefill);
  $('claimed').addEventListener('input', updatePayout);

  onClick('read-note', 'note-status', readNote);
  onClick('load-mirror', 'wasm-status', async () => {
    const base = $('mirror').value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/\S+$/i.test(base)) {
      throw new Error('The mirror URL must start with http:// or https://');
    }
    await Promise.all(
      KINDS.map((kind) => useFile(kind, `${base}/${PUBLISHED[kind]}`)),
    );
  });
  onClick('initiate', 'initiate-status', initiate);
  onClick('check-exit', 'exit-status', checkExit);
  onClick('finalize', 'finalize-status', finalize);
})();
