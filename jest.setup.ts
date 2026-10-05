// Global Jest setup to suppress expected circomlibjs teardown errors

// PROFILE is required at startup; specs that test prod set it themselves
process.env.PROFILE ??= 'local';

const originalStderrWrite = process.stderr.write.bind(process.stderr);

// Filter stderr output to suppress known circomlibjs teardown errors
(process.stderr.write as any) = (
  chunk: string | Uint8Array,
  encoding?: any,
  callback?: any,
) => {
  const output = chunk.toString();

  // Suppress expected circomlibjs teardown errors that don't affect test results
  if (
    output.includes("'instanceof' is not callable") ||
    output.includes(
      'You are trying to `import` a file after the Jest environment has been torn down',
    ) ||
    output.includes('at Blake') ||
    output.includes('at Eddsa') ||
    output.includes('at RefundSignerService.initialize') ||
    output.includes('DEP0182') ||
    output.includes('trace-deprecation')
  ) {
    return true;
  }

  return originalStderrWrite(chunk, encoding, callback);
};
