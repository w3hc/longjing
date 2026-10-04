/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/require-await */

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * Sparse Merkle Tree implementation for identity commitments
 * Uses Poseidon hash and supports efficient proof generation
 * Tree depth: 20 (supports 2^20 = ~1M users)
 */
@Injectable()
export class MerkleTreeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MerkleTreeService.name);
  private poseidon: any;
  private initPromise: Promise<void> | null = null;

  // Tree configuration
  private readonly TREE_DEPTH = 20;
  private readonly ZERO_VALUE = BigInt(0);

  // Persistence configuration
  private readonly persistPath =
    process.env.MERKLE_TREE_PERSIST_PATH || './data/merkle-tree.json';
  private readonly persistIntervalMs = 5 * 60 * 1000; // 5 minutes
  private persistInterval: NodeJS.Timeout | null = null;

  // Tree storage: level -> index -> hash
  private tree: Map<number, Map<number, bigint>> = new Map();
  private zeroHashes: bigint[] = [];
  private leafCount = 0;

  /**
   * Initialize Poseidon hash and zero hashes
   */
  private async initialize() {
    if (this.poseidon) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        const circomlibjs = require('circomlibjs');
        this.poseidon = await circomlibjs.buildPoseidon();
        this.logger.log('Poseidon hash initialized for Merkle tree');

        // Precompute zero hashes for each level
        await this.computeZeroHashes();

        // Initialize tree structure
        for (let i = 0; i <= this.TREE_DEPTH; i++) {
          this.tree.set(i, new Map());
        }

        this.logger.log(
          `Merkle tree initialized (depth: ${this.TREE_DEPTH}, capacity: ${Math.pow(2, this.TREE_DEPTH)})`,
        );
      } catch (error) {
        this.logger.error('Failed to initialize Merkle tree', error);
        throw error;
      }
    })();

    return this.initPromise;
  }

  /**
   * Compute zero hashes for each level of the tree
   * zeroHashes[0] = ZERO_VALUE
   * zeroHashes[i] = Hash(zeroHashes[i-1], zeroHashes[i-1])
   */
  private async computeZeroHashes() {
    const F = this.poseidon.F;
    this.zeroHashes = [this.ZERO_VALUE];

    for (let i = 1; i <= this.TREE_DEPTH; i++) {
      const prev = this.zeroHashes[i - 1];
      const hash = F.toObject(this.poseidon([prev, prev]));
      this.zeroHashes.push(hash);
    }

    this.logger.debug(`Zero hashes computed: ${this.zeroHashes.length} levels`);
  }

  /**
   * Hash two elements using Poseidon
   */
  private hash(left: bigint, right: bigint): bigint {
    const F = this.poseidon.F;
    return F.toObject(this.poseidon([left, right]));
  }

  /**
   * Get hash at specific position in tree
   */
  private getNode(level: number, index: number): bigint {
    const levelMap = this.tree.get(level);
    if (!levelMap) {
      return this.zeroHashes[level];
    }

    const node = levelMap.get(index);
    return node !== undefined ? node : this.zeroHashes[level];
  }

  /**
   * Set hash at specific position in tree
   */
  private setNode(level: number, index: number, value: bigint): void {
    let levelMap = this.tree.get(level);
    if (!levelMap) {
      levelMap = new Map();
      this.tree.set(level, levelMap);
    }
    levelMap.set(index, value);
  }

  /**
   * Insert identity commitment as a leaf
   * Returns the index of the inserted leaf
   */
  async insert(idCommitment: bigint): Promise<number> {
    await this.initialize();

    const index = this.leafCount;
    this.leafCount++;

    // Insert leaf at level 0
    this.setNode(0, index, idCommitment);

    // Update parent hashes up to root
    let currentIndex = index;
    for (let level = 0; level < this.TREE_DEPTH; level++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;

      const left = isLeft
        ? this.getNode(level, currentIndex)
        : this.getNode(level, siblingIndex);
      const right = isLeft
        ? this.getNode(level, siblingIndex)
        : this.getNode(level, currentIndex);

      const parentHash = this.hash(left, right);
      const parentIndex = Math.floor(currentIndex / 2);

      this.setNode(level + 1, parentIndex, parentHash);
      currentIndex = parentIndex;
    }

    this.logger.debug(
      `Inserted identity commitment at index ${index}, new leaf count: ${this.leafCount}`,
    );

    return index;
  }

  /**
   * Insert multiple identity commitments in batch
   */
  async insertBatch(idCommitments: bigint[]): Promise<number[]> {
    await this.initialize();

    const indices: number[] = [];
    for (const commitment of idCommitments) {
      const index = await this.insert(commitment);
      indices.push(index);
    }

    this.logger.log(
      `Batch inserted ${idCommitments.length} commitments, total leaves: ${this.leafCount}`,
    );

    return indices;
  }

  /**
   * Get Merkle root
   */
  async getRoot(): Promise<bigint> {
    await this.initialize();

    // Root is at level TREE_DEPTH, index 0
    return this.getNode(this.TREE_DEPTH, 0);
  }

  /**
   * Generate Merkle proof for a leaf at given index
   * Returns path elements and path indices for circuit verification
   */
  async generateProof(leafIndex: number): Promise<{
    pathElements: bigint[];
    pathIndices: number[];
    leaf: bigint;
    root: bigint;
  }> {
    await this.initialize();

    if (leafIndex >= this.leafCount) {
      throw new Error(
        `Leaf index ${leafIndex} out of bounds (tree size: ${this.leafCount})`,
      );
    }

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    const leaf = this.getNode(0, leafIndex);

    let currentIndex = leafIndex;
    for (let level = 0; level < this.TREE_DEPTH; level++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;
      const sibling = this.getNode(level, siblingIndex);

      pathElements.push(sibling);
      pathIndices.push(isLeft ? 0 : 1);

      currentIndex = Math.floor(currentIndex / 2);
    }

    const root = await this.getRoot();

    return {
      pathElements,
      pathIndices,
      leaf,
      root,
    };
  }

  /**
   * Verify a Merkle proof
   */
  async verifyProof(
    leaf: bigint,
    pathElements: bigint[],
    pathIndices: number[],
    root: bigint,
  ): Promise<boolean> {
    await this.initialize();

    if (pathElements.length !== this.TREE_DEPTH) {
      this.logger.error(
        `Invalid proof length: expected ${this.TREE_DEPTH}, got ${pathElements.length}`,
      );
      return false;
    }

    let currentHash = leaf;
    for (let i = 0; i < this.TREE_DEPTH; i++) {
      const sibling = pathElements[i];
      const isLeft = pathIndices[i] === 0;

      currentHash = isLeft
        ? this.hash(currentHash, sibling)
        : this.hash(sibling, currentHash);
    }

    return currentHash === root;
  }

  /**
   * Find leaf index by identity commitment
   * Returns -1 if not found
   */
  async findLeafIndex(idCommitment: bigint): Promise<number> {
    await this.initialize();

    const level0 = this.tree.get(0);
    if (!level0) {
      return -1;
    }

    for (let i = 0; i < this.leafCount; i++) {
      const leaf = level0.get(i);
      if (leaf === idCommitment) {
        return i;
      }
    }

    return -1;
  }

  /**
   * Check if identity commitment exists in tree
   */
  async isMember(idCommitment: bigint): Promise<boolean> {
    const index = await this.findLeafIndex(idCommitment);
    return index !== -1;
  }

  /**
   * Get tree statistics
   */
  async getStats(): Promise<{
    depth: number;
    leafCount: number;
    capacity: number;
    root: string;
  }> {
    await this.initialize();

    const root = await this.getRoot();

    return {
      depth: this.TREE_DEPTH,
      leafCount: this.leafCount,
      capacity: Math.pow(2, this.TREE_DEPTH),
      root: '0x' + root.toString(16).padStart(64, '0'),
    };
  }

  /**
   * Export tree state (for persistence)
   */
  async exportState(): Promise<{
    depth: number;
    leafCount: number;
    nodes: { level: number; index: number; value: string }[];
  }> {
    await this.initialize();

    const nodes: { level: number; index: number; value: string }[] = [];

    for (const [level, levelMap] of this.tree.entries()) {
      for (const [index, value] of levelMap.entries()) {
        nodes.push({
          level,
          index,
          value: '0x' + value.toString(16).padStart(64, '0'),
        });
      }
    }

    return {
      depth: this.TREE_DEPTH,
      leafCount: this.leafCount,
      nodes,
    };
  }

  /**
   * Import tree state (from persistence)
   */
  async importState(state: {
    depth: number;
    leafCount: number;
    nodes: { level: number; index: number; value: string }[];
  }): Promise<void> {
    await this.initialize();

    if (state.depth !== this.TREE_DEPTH) {
      throw new Error(
        `Tree depth mismatch: expected ${this.TREE_DEPTH}, got ${state.depth}`,
      );
    }

    this.leafCount = state.leafCount;

    // Clear current tree
    for (let i = 0; i <= this.TREE_DEPTH; i++) {
      this.tree.set(i, new Map());
    }

    // Import nodes
    for (const node of state.nodes) {
      const value = BigInt(node.value);
      this.setNode(node.level, node.index, value);
    }

    this.logger.log(
      `Imported tree state: ${state.leafCount} leaves, ${state.nodes.length} nodes`,
    );
  }

  /**
   * Clear the tree (for testing)
   */
  async clear(): Promise<void> {
    await this.initialize();

    this.leafCount = 0;
    for (let i = 0; i <= this.TREE_DEPTH; i++) {
      this.tree.set(i, new Map());
    }

    this.logger.debug('Tree cleared');
  }

  /**
   * Load tree state from disk
   */
  private async loadFromDisk(): Promise<boolean> {
    if (!existsSync(this.persistPath)) {
      this.logger.debug(`No persisted tree found at ${this.persistPath}`);
      return false;
    }

    try {
      const data = readFileSync(this.persistPath, 'utf-8');
      const state = JSON.parse(data);
      await this.importState(state);
      this.logger.log(
        `Loaded Merkle tree from disk: ${this.leafCount} leaves from ${this.persistPath}`,
      );
      return true;
    } catch (error) {
      this.logger.error(`Failed to load tree from ${this.persistPath}:`, error);
      return false;
    }
  }

  /**
   * Persist tree state to disk
   */
  private async persistToDisk(): Promise<void> {
    try {
      const state = await this.exportState();
      const dir = dirname(this.persistPath);

      // Ensure directory exists
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(this.persistPath, JSON.stringify(state, null, 2));
      this.logger.debug(
        `Persisted Merkle tree to disk: ${this.leafCount} leaves`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to persist tree to ${this.persistPath}:`,
        error,
      );
    }
  }

  /**
   * Module initialization hook
   * Loads persisted tree and sets up periodic persistence
   */
  async onModuleInit() {
    await this.initialize();

    // Try to load from disk
    const loaded = await this.loadFromDisk();
    if (!loaded) {
      this.logger.log('Starting with empty Merkle tree');
    }

    // Setup periodic persistence
    this.persistInterval = setInterval(() => {
      void this.persistToDisk();
    }, this.persistIntervalMs);

    this.logger.log(
      `Periodic persistence enabled (interval: ${this.persistIntervalMs / 1000}s)`,
    );
  }

  /**
   * Cleanup on module destroy
   */
  async onModuleDestroy() {
    if (this.persistInterval) {
      clearInterval(this.persistInterval);
      this.persistInterval = null;
    }

    // Final persist before shutdown
    await this.persistToDisk();
    this.logger.log('Merkle tree persisted before shutdown');
  }
}
