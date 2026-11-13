import { createHash } from 'crypto';
import {
  ARTIFACT_HASHES,
  ArtifactMismatch,
  artifactName,
  loadArtifact,
} from './artifacts';

describe('loadArtifact', () => {
  const name = 'request.zkey';
  const bytes = new Uint8Array([1, 2, 3]);
  const original = ARTIFACT_HASHES[name];
  const pins = ARTIFACT_HASHES as Record<string, string>;

  beforeEach(() => {
    pins[name] = createHash('sha256').update(bytes).digest('hex');
  });
  afterEach(() => {
    pins[name] = original;
  });

  it('names the files of circuits/artifacts.json', () => {
    for (const circuit of ['request', 'settlement'] as const) {
      expect(ARTIFACT_HASHES[artifactName(circuit, 'wasm')]).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(ARTIFACT_HASHES[artifactName(circuit, 'zkey')]).toMatch(
        /^[0-9a-f]{64}$/,
      );
    }
  });

  it('returns a copy of bytes that match the pinned hash', async () => {
    const loaded = await loadArtifact(name, bytes);
    expect(loaded).toEqual(bytes);
    expect(loaded).not.toBe(bytes);
  });

  it('refuses bytes that do not match', async () => {
    await expect(
      loadArtifact(name, new Uint8Array([1, 2, 4])),
    ).rejects.toBeInstanceOf(ArtifactMismatch);
  });

  it('fetches a URL and checks what it gets', async () => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([9])));
    try {
      await expect(
        loadArtifact(name, 'https://mirror.example/request.zkey'),
      ).rejects.toThrow("doesn't match circuits/artifacts.json");
      expect(fetch).toHaveBeenCalledWith(
        'https://mirror.example/request.zkey',
        expect.objectContaining({ credentials: 'omit' }),
      );
    } finally {
      fetch.mockRestore();
    }
  });

  it('refuses a file that is not pinned', async () => {
    await expect(loadArtifact('other.zkey', bytes)).rejects.toThrow(
      'not a pinned circuit file',
    );
  });
});
