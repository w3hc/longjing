import { Test, TestingModule } from '@nestjs/testing';
import { MerkleTreeService } from './merkle-tree.service';

describe('MerkleTreeService', () => {
  let service: MerkleTreeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MerkleTreeService],
    })
      .setLogger({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        verbose: jest.fn(),
        fatal: jest.fn(),
      })
      .compile();

    service = module.get<MerkleTreeService>(MerkleTreeService);
  });

  afterEach(async () => {
    // Clear tree between tests
    await service.clear();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('initialization', () => {
    it('should initialize with empty tree', async () => {
      const stats = await service.getStats();
      expect(stats.depth).toBe(20);
      expect(stats.leafCount).toBe(0);
      expect(stats.capacity).toBe(Math.pow(2, 20));
      expect(stats.root).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it('should have consistent zero root for empty tree', async () => {
      const root1 = await service.getRoot();
      await service.clear();
      const root2 = await service.getRoot();
      expect(root1).toBe(root2);
    });
  });

  describe('insert', () => {
    it('should insert a single identity commitment', async () => {
      const commitment = BigInt(12345);
      const index = await service.insert(commitment);

      expect(index).toBe(0);

      const stats = await service.getStats();
      expect(stats.leafCount).toBe(1);
    }, 10000);

    it('should insert multiple commitments and increment indices', async () => {
      const commitment1 = BigInt(111);
      const commitment2 = BigInt(222);
      const commitment3 = BigInt(333);

      const index1 = await service.insert(commitment1);
      const index2 = await service.insert(commitment2);
      const index3 = await service.insert(commitment3);

      expect(index1).toBe(0);
      expect(index2).toBe(1);
      expect(index3).toBe(2);

      const stats = await service.getStats();
      expect(stats.leafCount).toBe(3);
    });

    it('should update root after insertion', async () => {
      const rootBefore = await service.getRoot();
      await service.insert(BigInt(999));
      const rootAfter = await service.getRoot();

      expect(rootAfter).not.toBe(rootBefore);
    });

    it('should produce different roots for different insertions', async () => {
      const commitment1 = BigInt(111);
      const commitment2 = BigInt(222);

      await service.insert(commitment1);
      const root1 = await service.getRoot();

      await service.clear();

      await service.insert(commitment2);
      const root2 = await service.getRoot();

      expect(root1).not.toBe(root2);
    });

    it('should produce same root for same insertions in same order', async () => {
      await service.insert(BigInt(111));
      await service.insert(BigInt(222));
      const root1 = await service.getRoot();

      await service.clear();

      await service.insert(BigInt(111));
      await service.insert(BigInt(222));
      const root2 = await service.getRoot();

      expect(root1).toBe(root2);
    });
  });

  describe('insertBatch', () => {
    it('should insert multiple commitments at once', async () => {
      const commitments = [BigInt(111), BigInt(222), BigInt(333), BigInt(444)];
      const indices = await service.insertBatch(commitments);

      expect(indices).toEqual([0, 1, 2, 3]);

      const stats = await service.getStats();
      expect(stats.leafCount).toBe(4);
    });

    it('should produce same root as sequential inserts', async () => {
      const commitments = [BigInt(111), BigInt(222), BigInt(333)];

      await service.insertBatch(commitments);
      const root1 = await service.getRoot();

      await service.clear();

      for (const c of commitments) {
        await service.insert(c);
      }
      const root2 = await service.getRoot();

      expect(root1).toBe(root2);
    });
  });

  describe('generateProof', () => {
    it('should generate valid proof for single leaf', async () => {
      const commitment = BigInt(12345);
      const index = await service.insert(commitment);

      const proof = await service.generateProof(index);

      expect(proof.leaf).toBe(commitment);
      expect(proof.pathElements).toHaveLength(20);
      expect(proof.pathIndices).toHaveLength(20);
      expect(proof.pathIndices[0]).toBe(0); // First element is left
    });

    it('should generate valid proof for multiple leaves', async () => {
      const commitments = [BigInt(111), BigInt(222), BigInt(333), BigInt(444)];
      await service.insertBatch(commitments);

      for (let i = 0; i < commitments.length; i++) {
        const proof = await service.generateProof(i);
        expect(proof.leaf).toBe(commitments[i]);
        expect(proof.pathElements).toHaveLength(20);
        expect(proof.pathIndices).toHaveLength(20);
      }
    });

    it('should generate different proofs for different indices', async () => {
      await service.insertBatch([BigInt(111), BigInt(222)]);

      const proof0 = await service.generateProof(0);
      const proof1 = await service.generateProof(1);

      expect(proof0.pathElements).not.toEqual(proof1.pathElements);
      expect(proof0.pathIndices).not.toEqual(proof1.pathIndices);
    });

    it('should include correct path indices', async () => {
      await service.insertBatch([BigInt(111), BigInt(222)]);

      const proof0 = await service.generateProof(0);
      const proof1 = await service.generateProof(1);

      // Index 0 is left child, so first path index should be 0
      expect(proof0.pathIndices[0]).toBe(0);

      // Index 1 is right child, so first path index should be 1
      expect(proof1.pathIndices[0]).toBe(1);
    });

    it('should throw error for out of bounds index', async () => {
      await service.insert(BigInt(111));

      await expect(service.generateProof(1)).rejects.toThrow(
        'Leaf index 1 out of bounds (tree size: 1)',
      );
    });

    it('should generate proof for index 0 when tree has one element', async () => {
      await service.insert(BigInt(111));

      const proof = await service.generateProof(0);
      expect(proof.leaf).toBe(BigInt(111));
      expect(proof.pathElements).toHaveLength(20);
    });
  });

  describe('verifyProof', () => {
    it('should verify valid proof', async () => {
      const commitment = BigInt(12345);
      const index = await service.insert(commitment);

      const proof = await service.generateProof(index);

      const isValid = await service.verifyProof(
        proof.leaf,
        proof.pathElements,
        proof.pathIndices,
        proof.root,
      );

      expect(isValid).toBe(true);
    });

    it('should verify proofs for all leaves in tree', async () => {
      const commitments = [
        BigInt(111),
        BigInt(222),
        BigInt(333),
        BigInt(444),
        BigInt(555),
      ];
      await service.insertBatch(commitments);

      const root = await service.getRoot();

      for (let i = 0; i < commitments.length; i++) {
        const proof = await service.generateProof(i);
        const isValid = await service.verifyProof(
          proof.leaf,
          proof.pathElements,
          proof.pathIndices,
          root,
        );
        expect(isValid).toBe(true);
      }
    });

    it('should reject proof with wrong leaf', async () => {
      const commitment = BigInt(12345);
      const index = await service.insert(commitment);

      const proof = await service.generateProof(index);

      const isValid = await service.verifyProof(
        BigInt(99999), // Wrong leaf
        proof.pathElements,
        proof.pathIndices,
        proof.root,
      );

      expect(isValid).toBe(false);
    });

    it('should reject proof with wrong root', async () => {
      const commitment = BigInt(12345);
      const index = await service.insert(commitment);

      const proof = await service.generateProof(index);

      const isValid = await service.verifyProof(
        proof.leaf,
        proof.pathElements,
        proof.pathIndices,
        BigInt(99999), // Wrong root
      );

      expect(isValid).toBe(false);
    });

    it('should reject proof with tampered path elements', async () => {
      const commitment = BigInt(12345);
      const index = await service.insert(commitment);

      const proof = await service.generateProof(index);

      // Tamper with path elements
      proof.pathElements[0] = BigInt(99999);

      const isValid = await service.verifyProof(
        proof.leaf,
        proof.pathElements,
        proof.pathIndices,
        proof.root,
      );

      expect(isValid).toBe(false);
    });

    it('should reject proof with wrong path indices', async () => {
      await service.insertBatch([BigInt(111), BigInt(222)]);

      const proof0 = await service.generateProof(0);
      const proof1 = await service.generateProof(1);

      // Use path elements from proof0 with path indices from proof1
      const isValid = await service.verifyProof(
        proof0.leaf,
        proof0.pathElements,
        proof1.pathIndices, // Wrong indices
        proof0.root,
      );

      expect(isValid).toBe(false);
    });

    it('should reject proof with invalid length', async () => {
      const commitment = BigInt(12345);
      const index = await service.insert(commitment);

      const proof = await service.generateProof(index);

      // Remove last element
      const shortPathElements = proof.pathElements.slice(0, -1);
      const shortPathIndices = proof.pathIndices.slice(0, -1);

      const isValid = await service.verifyProof(
        proof.leaf,
        shortPathElements,
        shortPathIndices,
        proof.root,
      );

      expect(isValid).toBe(false);
    });
  });

  describe('findLeafIndex', () => {
    it('should find leaf by commitment', async () => {
      const commitment = BigInt(12345);
      await service.insert(commitment);

      const index = await service.findLeafIndex(commitment);
      expect(index).toBe(0);
    });

    it('should find correct index for multiple leaves', async () => {
      const commitments = [BigInt(111), BigInt(222), BigInt(333)];
      await service.insertBatch(commitments);

      for (let i = 0; i < commitments.length; i++) {
        const index = await service.findLeafIndex(commitments[i]);
        expect(index).toBe(i);
      }
    });

    it('should return -1 for non-existent commitment', async () => {
      await service.insert(BigInt(111));

      const index = await service.findLeafIndex(BigInt(999));
      expect(index).toBe(-1);
    });

    it('should return -1 for empty tree', async () => {
      const index = await service.findLeafIndex(BigInt(111));
      expect(index).toBe(-1);
    });
  });

  describe('isMember', () => {
    it('should return true for existing commitment', async () => {
      const commitment = BigInt(12345);
      await service.insert(commitment);

      const exists = await service.isMember(commitment);
      expect(exists).toBe(true);
    });

    it('should return false for non-existent commitment', async () => {
      await service.insert(BigInt(111));

      const exists = await service.isMember(BigInt(999));
      expect(exists).toBe(false);
    });

    it('should work for multiple commitments', async () => {
      const commitments = [BigInt(111), BigInt(222), BigInt(333)];
      await service.insertBatch(commitments);

      for (const c of commitments) {
        const exists = await service.isMember(c);
        expect(exists).toBe(true);
      }

      const nonMember = await service.isMember(BigInt(999));
      expect(nonMember).toBe(false);
    });
  });

  describe('exportState and importState', () => {
    it('should export and import tree state', async () => {
      const commitments = [BigInt(111), BigInt(222), BigInt(333)];
      await service.insertBatch(commitments);

      const rootBefore = await service.getRoot();
      const state = await service.exportState();

      await service.clear();
      await service.importState(state);

      const rootAfter = await service.getRoot();
      const stats = await service.getStats();

      expect(rootAfter).toBe(rootBefore);
      expect(stats.leafCount).toBe(commitments.length);
    });

    it('should preserve all leaf values', async () => {
      const commitments = [
        BigInt(111),
        BigInt(222),
        BigInt(333),
        BigInt(444),
        BigInt(555),
      ];
      await service.insertBatch(commitments);

      const state = await service.exportState();
      await service.clear();
      await service.importState(state);

      for (const c of commitments) {
        const exists = await service.isMember(c);
        expect(exists).toBe(true);
      }
    });

    it('should preserve proof generation after import', async () => {
      const commitments = [BigInt(111), BigInt(222), BigInt(333)];
      await service.insertBatch(commitments);

      const proofBefore = await service.generateProof(1);
      const state = await service.exportState();

      await service.clear();
      await service.importState(state);

      const proofAfter = await service.generateProof(1);

      expect(proofAfter.leaf).toBe(proofBefore.leaf);
      expect(proofAfter.pathElements).toEqual(proofBefore.pathElements);
      expect(proofAfter.pathIndices).toEqual(proofBefore.pathIndices);
      expect(proofAfter.root).toBe(proofBefore.root);
    });

    it('should export with correct format', async () => {
      await service.insert(BigInt(12345));
      const state = await service.exportState();

      expect(state.depth).toBe(20);
      expect(state.leafCount).toBe(1);
      expect(Array.isArray(state.nodes)).toBe(true);
      expect(state.nodes.length).toBeGreaterThan(0);

      for (const node of state.nodes) {
        expect(typeof node.level).toBe('number');
        expect(typeof node.index).toBe('number');
        expect(typeof node.value).toBe('string');
        expect(node.value).toMatch(/^0x[0-9a-f]+$/i);
      }
    });

    it('should reject import with mismatched depth', async () => {
      const invalidState = {
        depth: 15, // Wrong depth
        leafCount: 1,
        nodes: [],
      };

      await expect(service.importState(invalidState)).rejects.toThrow(
        'Tree depth mismatch',
      );
    });
  });

  describe('clear', () => {
    it('should reset tree to empty state', async () => {
      await service.insertBatch([BigInt(111), BigInt(222), BigInt(333)]);

      await service.clear();

      const stats = await service.getStats();
      expect(stats.leafCount).toBe(0);
    });

    it('should reset root to zero root', async () => {
      const zeroRoot = await service.getRoot();

      await service.insertBatch([BigInt(111), BigInt(222)]);
      await service.clear();

      const rootAfterClear = await service.getRoot();
      expect(rootAfterClear).toBe(zeroRoot);
    });

    it('should allow new insertions after clear', async () => {
      await service.insertBatch([BigInt(111), BigInt(222)]);
      await service.clear();

      const index = await service.insert(BigInt(333));
      expect(index).toBe(0);

      const stats = await service.getStats();
      expect(stats.leafCount).toBe(1);
    });
  });

  describe('stress test', () => {
    it('should handle many insertions efficiently', async () => {
      const count = 100;
      const commitments = Array.from({ length: count }, (_, i) =>
        BigInt(1000 + i),
      );

      const indices = await service.insertBatch(commitments);

      expect(indices).toHaveLength(count);
      expect(indices[0]).toBe(0);
      expect(indices[count - 1]).toBe(count - 1);

      const stats = await service.getStats();
      expect(stats.leafCount).toBe(count);
    }, 30000); // 30 second timeout

    it('should verify all proofs for many leaves', async () => {
      const count = 50;
      const commitments = Array.from({ length: count }, (_, i) =>
        BigInt(2000 + i),
      );

      await service.insertBatch(commitments);
      const root = await service.getRoot();

      for (let i = 0; i < count; i++) {
        const proof = await service.generateProof(i);
        const isValid = await service.verifyProof(
          proof.leaf,
          proof.pathElements,
          proof.pathIndices,
          root,
        );
        expect(isValid).toBe(true);
      }
    }, 60000); // 60 second timeout
  });
});
