#!/usr/bin/env node
const path = require("node:path");

const {
  collectRepositoryArtifactPaths,
  findPrivateArtifactViolations,
  formatSafeArtifactPolicyError,
  summarizePrivateArtifactViolations,
} = require("./private-artifact-policy.cjs");

function main(argv = process.argv.slice(2)) {
  if (argv.length > 1) {
    console.error("Usage: verify-private-artifacts.cjs [repository-root]");
    return 2;
  }

  const root = path.resolve(argv[0] || process.cwd());
  const artifactPaths = collectRepositoryArtifactPaths(root);
  const violations = findPrivateArtifactViolations(artifactPaths);

  if (violations.length > 0) {
    console.error(
      "Private artifact policy failed. Prohibited paths were found; file contents were not inspected:"
    );
    console.error(`- ${summarizePrivateArtifactViolations(violations)}`);
    return 1;
  }

  console.log(
    `Private artifact policy passed (${artifactPaths.length} paths inspected; contents not read).`
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(
      `Private artifact policy failed (${formatSafeArtifactPolicyError(
        error,
        "private-artifact-check-failed"
      )}).`
    );
    process.exitCode = 1;
  }
}

module.exports = { main };
