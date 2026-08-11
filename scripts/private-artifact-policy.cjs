const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".git",
  ".npm-cache",
  ".npm-cache-packcheck",
  ".turbo",
  "coverage",
  "node_modules",
]);

const PRIVACY_MARKERS = new Set([
  "confidential",
  "internal",
  "personal",
  "pii",
  "private",
]);

const REGISTRY_MARKERS = new Set([
  "ledger",
  "register",
  "registry",
  "roster",
]);

const CLA_MARKERS = new Set(["cla", "clas", "contributor", "contributors"]);

const BROAD_PACKAGE_FILE_ENTRIES = new Set([
  "",
  ".",
  "*",
  "**",
  "**/*",
  "legal",
  "legal/*",
  "legal/**",
  "legal/**/*",
]);

const PRIVATE_ARTIFACT_RULES = Object.freeze([
  Object.freeze({
    id: "csv-artifact",
    description:
      "CSV files are not permitted because tabular personal-data exports must remain outside source control and packages.",
    matches: (artifactPath) => artifactPath.toLocaleLowerCase("en-US").endsWith(".csv"),
  }),
  Object.freeze({
    id: "cla-contributor-registry",
    description:
      "Contributor and CLA acceptance registries must remain in approved private systems.",
    matches: (_artifactPath, tokens) =>
      hasMarkerPair(tokens, CLA_MARKERS, REGISTRY_MARKERS),
  }),
  Object.freeze({
    id: "signed-cla-storage",
    description:
      "Signed CLA submissions and signature records must remain in approved private systems.",
    matches: (artifactPath) =>
      /(?:^|\/)(?:signed[ ._-]*clas?|cla[ ._-]*(?:acceptances?|signatures?|submissions?))(?:\/|$)/iu.test(
        artifactPath
      ),
  }),
  Object.freeze({
    id: "private-registry",
    description:
      "Registry paths marked private, confidential, internal, personal, or PII must remain outside public artifacts.",
    matches: (_artifactPath, tokens) =>
      hasMarkerPair(tokens, PRIVACY_MARKERS, REGISTRY_MARKERS),
  }),
]);

/**
 * Normalize a repository or package path without opening the referenced file.
 * npm manifests may prefix paths with `package/`; the policy treats both forms
 * as the same artifact.
 *
 * @param {string} artifactPath
 * @returns {string}
 */
function normalizeArtifactPath(artifactPath) {
  if (typeof artifactPath !== "string") {
    throw new TypeError("Artifact paths must be strings.");
  }

  let normalized = path.posix.normalize(artifactPath.replace(/\\/gu, "/"));
  if (normalized === ".") {
    return "";
  }

  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith("package/")) {
    normalized = normalized.slice("package/".length);
  }

  return normalized;
}

/**
 * Find private-artifact policy violations using path metadata only.
 *
 * @param {Iterable<string>} artifactPaths
 * @returns {Array<{artifactPath: string, ruleId: string, description: string}>}
 */
function findPrivateArtifactViolations(artifactPaths) {
  const violations = new Map();

  for (const candidate of artifactPaths) {
    const artifactPath = normalizeArtifactPath(candidate);
    if (!artifactPath) {
      continue;
    }

    const tokens = artifactPath
      .toLocaleLowerCase("en-US")
      .split(/[^a-z0-9]+/u)
      .filter(Boolean);

    for (const rule of PRIVATE_ARTIFACT_RULES) {
      if (!rule.matches(artifactPath, tokens)) {
        continue;
      }

      const key = `${artifactPath.toLocaleLowerCase("en-US")}\0${rule.id}`;
      violations.set(key, {
        artifactPath,
        ruleId: rule.id,
        description: rule.description,
      });
      break;
    }
  }

  return [...violations.values()].sort(compareViolations);
}

/**
 * Enumerate working-tree paths without reading file contents or following
 * symbolic links. Dependency and tool metadata directories are excluded.
 *
 * @param {string} rootDirectory
 * @returns {string[]}
 */
function collectWorkingTreeArtifactPaths(rootDirectory = process.cwd()) {
  const root = path.resolve(rootDirectory);
  const artifactPaths = [];

  function visit(directory, relativeDirectory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_DIRECTORY_NAMES.has(entry.name.toLocaleLowerCase("en-US"))) {
        continue;
      }

      const relativePath = normalizeArtifactPath(
        path.posix.join(relativeDirectory, entry.name)
      );
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }

      artifactPaths.push(relativePath);
    }
  }

  visit(root, "");
  return sortPaths(artifactPaths);
}

/**
 * Enumerate paths in the proposed Git index without reading blob contents.
 * A tracked-but-deleted working-tree path remains visible until its deletion is
 * staged, so the gate validates the state that would be committed.
 *
 * @param {string} rootDirectory
 * @returns {string[]}
 */
function collectGitIndexArtifactPaths(rootDirectory = process.cwd()) {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "-z", "--"],
    {
      cwd: path.resolve(rootDirectory),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  return sortPaths(
    output
      .split("\0")
      .map(normalizeArtifactPath)
      .filter(Boolean)
  );
}

/**
 * Return the union of working-tree and proposed-index paths. Neither source
 * reads file contents.
 *
 * @param {string} rootDirectory
 * @returns {string[]}
 */
function collectRepositoryArtifactPaths(rootDirectory = process.cwd()) {
  return sortPaths(
    new Set([
      ...collectWorkingTreeArtifactPaths(rootDirectory),
      ...collectGitIndexArtifactPaths(rootDirectory),
    ])
  );
}

/**
 * Validate the package `files` field as an explicit allowlist.
 *
 * @param {unknown} files
 * @returns {Array<{entry: string, ruleId: string, description: string}>}
 */
function findPackageFilesPolicyViolations(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return [
      {
        entry: "files",
        ruleId: "explicit-files-required",
        description: "package.json must define a non-empty files allowlist.",
      },
    ];
  }

  const violations = [];
  for (const candidate of files) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      violations.push({
        entry: String(candidate),
        ruleId: "invalid-files-entry",
        description: "Package files entries must be non-empty strings.",
      });
      continue;
    }

    const normalized = normalizePackageFilesEntry(candidate);
    if (BROAD_PACKAGE_FILE_ENTRIES.has(normalized.toLocaleLowerCase("en-US"))) {
      violations.push({
        entry: candidate,
        ruleId: "broad-files-entry",
        description:
          "Package files entries must not publish the repository root, wildcards, or the complete legal directory.",
      });
    }
  }

  return violations;
}

/**
 * Compare a path manifest with its exact allowlist.
 *
 * @param {Iterable<string>} actualPaths
 * @param {Iterable<string>} allowedPaths
 * @returns {{missingPaths: string[], unexpectedPaths: string[]}}
 */
function compareExactPathAllowlist(actualPaths, allowedPaths) {
  const actual = new Set(
    [...actualPaths].map(normalizeArtifactPath).filter(Boolean)
  );
  const allowed = new Set(
    [...allowedPaths].map(normalizeArtifactPath).filter(Boolean)
  );

  return {
    missingPaths: sortPaths([...allowed].filter((entry) => !actual.has(entry))),
    unexpectedPaths: sortPaths([...actual].filter((entry) => !allowed.has(entry))),
  };
}

function normalizePackageFilesEntry(entry) {
  const normalized = path.posix.normalize(entry.trim().replace(/\\/gu, "/"));
  const withoutPrefix = normalized.startsWith("./")
    ? normalized.slice(2)
    : normalized;
  return withoutPrefix.length > 1
    ? withoutPrefix.replace(/\/+$/u, "")
    : withoutPrefix;
}

function hasMarkerPair(tokens, leftMarkers, rightMarkers) {
  const hasSeparatedPair =
    tokens.some((token) => leftMarkers.has(token)) &&
    tokens.some((token) => rightMarkers.has(token));
  if (hasSeparatedPair) {
    return true;
  }

  for (const token of tokens) {
    for (const left of leftMarkers) {
      for (const right of rightMarkers) {
        if (token === `${left}${right}` || token === `${right}${left}`) {
          return true;
        }
      }
    }
  }

  return false;
}

function compareViolations(left, right) {
  const pathOrder = comparePaths(left.artifactPath, right.artifactPath);
  return pathOrder || left.ruleId.localeCompare(right.ruleId, "en-US");
}

function comparePaths(left, right) {
  const leftPath = left.toLocaleLowerCase("en-US");
  const rightPath = right.toLocaleLowerCase("en-US");
  if (leftPath < rightPath) return -1;
  if (leftPath > rightPath) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortPaths(artifactPaths) {
  return [...artifactPaths].sort(comparePaths);
}

module.exports = {
  BROAD_PACKAGE_FILE_ENTRIES,
  collectGitIndexArtifactPaths,
  collectRepositoryArtifactPaths,
  collectWorkingTreeArtifactPaths,
  compareExactPathAllowlist,
  findPackageFilesPolicyViolations,
  findPrivateArtifactViolations,
  normalizeArtifactPath,
  PRIVATE_ARTIFACT_RULES,
};
