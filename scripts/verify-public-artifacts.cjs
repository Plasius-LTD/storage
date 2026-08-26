#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  collectRepositoryArtifactPaths,
  createSafeArtifactPolicyError,
  findPrivateArtifactViolations,
  formatSafeArtifactPolicyError,
  summarizePrivateArtifactViolations,
} = require("./private-artifact-policy.cjs");

const PROHIBITED = "legal/cla-registry.csv";

function normalizeArtifactPath(value) {
  const normalized = path.posix
    .normalize(String(value).replaceAll("\\", "/"))
    .replace(/^(?:\.\/)+/u, "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  return normalized.startsWith("package/")
    ? normalized.slice("package/".length)
    : normalized;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw createSafeArtifactPolicyError("subprocess-failed");
  }
  return result.stdout;
}

function collectSourceMatches(root) {
  const legalRoot = path.join(root, "legal");
  const matches = new Set();
  try {
    const legalStats = fs.lstatSync(legalRoot);
    if (legalStats.isSymbolicLink()) {
      throw new Error("The legal path is a symlink; refusing to follow it.");
    }
    if (!legalStats.isDirectory()) {
      throw new Error("The legal path is not a directory.");
    }
    for (const entry of fs.readdirSync(legalRoot, { withFileTypes: true })) {
      const candidate = `legal/${entry.name}`;
      if (normalizeArtifactPath(candidate) === PROHIBITED) {
        matches.add(candidate);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const indexOutput = run("git", [
    "-C",
    root,
    "ls-files",
    "-z",
    "--",
    ":(icase)legal/cla-registry.csv",
  ]);
  for (const candidate of indexOutput.split("\0").filter(Boolean)) {
    if (normalizeArtifactPath(candidate) === PROHIBITED) {
      matches.add(candidate);
    }
  }
  return [...matches].sort();
}

function parseArguments(argv) {
  const result = { packageDirectories: [], sourceOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--source-only") {
      result.sourceOnly = true;
      continue;
    }
    if (argv[index] === "--package-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--package-dir requires a value.");
      }
      result.packageDirectories.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (result.sourceOnly && result.packageDirectories.length > 0) {
    throw new Error("--source-only cannot be combined with --package-dir.");
  }
  if (!result.sourceOnly && result.packageDirectories.length === 0) {
    result.packageDirectories.push(".");
  }
  return result;
}

function validatePackageDirectory(root, packageDirectory) {
  const absolute = path.resolve(root, packageDirectory);
  const relative = path.relative(root, absolute);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    (relative === "" && packageDirectory !== ".")
  ) {
    throw new Error(`Package directory escapes repository root: ${packageDirectory}`);
  }
  const packageJson = path.join(absolute, "package.json");
  const packageStats = fs.lstatSync(packageJson);
  if (packageStats.isSymbolicLink() || !packageStats.isFile()) {
    throw new Error(`Package manifest is not a regular file: ${packageDirectory}`);
  }
  return absolute;
}

function validatePackage(root, packageDirectory) {
  const absolute = validatePackageDirectory(root, packageDirectory);
  const output = run(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts", absolute],
    { cwd: root }
  );
  let document;
  try {
    document = JSON.parse(output);
  } catch (error) {
    throw new Error("npm pack did not return valid JSON.", { cause: error });
  }
  if (!Array.isArray(document) || document.length !== 1) {
    throw new Error("npm pack returned an unexpected result shape.");
  }
  const files = document[0]?.files;
  if (!Array.isArray(files)) {
    throw new Error("npm pack result did not include a file inventory.");
  }
  const artifactPaths = files
    .map((entry) => entry?.path)
    .filter((entry) => typeof entry === "string");
  const violations = findPrivateArtifactViolations(artifactPaths);
  if (violations.length > 0) {
    throw createSafeArtifactPolicyError(
      "private-artifact-policy-rejected",
      summarizePrivateArtifactViolations(violations)
    );
  }
}

function main() {
  const root = process.cwd();
  const options = parseArguments(process.argv.slice(2));

  enforcePrivateArtifactPolicy(root);

  // Source metadata is checked first. npm pack is never invoked while the
  // prohibited path is present, so this process never asks npm to read it.
  const sourceMatches = collectSourceMatches(root);
  if (sourceMatches.length > 0) {
    throw createSafeArtifactPolicyError(
      "legacy-private-artifact-rejected",
      `legacy-private-artifact: ${sourceMatches.length}`
    );
  }

  if (!options.sourceOnly) {
    for (const packageDirectory of options.packageDirectories) {
      validatePackage(root, packageDirectory);
    }
  }

  const suffix = options.sourceOnly
    ? "source metadata checked"
    : `${options.packageDirectories.length} npm package inventory check(s) passed`;
  console.log(`Public artifact integrity passed (${suffix}; contents of the prohibited path were not read).`);
}

function enforcePrivateArtifactPolicy(root) {
  const violations = findPrivateArtifactViolations(
    collectRepositoryArtifactPaths(root)
  );
  if (violations.length > 0) {
    throw createSafeArtifactPolicyError(
      "private-artifact-policy-rejected",
      summarizePrivateArtifactViolations(violations)
    );
  }
}

try {
  main();
} catch (error) {
  console.error(
    `Public artifact integrity failed (${formatSafeArtifactPolicyError(
      error,
      "public-artifact-check-failed"
    )}).`
  );
  process.exitCode = 1;
}
