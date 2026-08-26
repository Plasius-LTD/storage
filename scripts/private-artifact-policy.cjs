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

const CONTRIBUTOR_PRIVATE_RECORD_PATTERN =
  /(?:^|[^a-z0-9])(?:(?:contributors?[^a-z0-9]+(?:acceptances?|signatures?|submissions?))|(?:signed[^a-z0-9]+contributors?[^a-z0-9]+(?:agreements?|clas?))|(?:contributors?[^a-z0-9]+signed[^a-z0-9]+(?:agreements?|clas?))|(?:contributors?[^a-z0-9]+(?:agreements?|clas?)[^a-z0-9]+(?:signed|signatures?)))(?=$|[^a-z0-9])/giu;

const PUBLIC_CONTRIBUTOR_DOCUMENT_QUALIFIER_PATTERNS = Object.freeze([
  /^[^a-z0-9]+(?:process|template|policy|guides?|guidance|documentation|docs?|instructions?|examples?)(?:[^a-z0-9]+v?[0-9]+(?:[^a-z0-9]+[0-9]+)*)?\.(?:md|mdx|rst|adoc|txt|pdf)$/iu,
  /^[^a-z0-9]+(?:schema|validator|formats?|spec(?:ification)?s?)(?:[^a-z0-9]+v?[0-9]+(?:[^a-z0-9]+[0-9]+)*)?\.(?:[cm]?[jt]sx?|d\.[cm]?[jt]s|mdx?|json|ya?ml)$/iu,
]);

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
    id: "contributor-record-storage",
    description:
      "Signed contributor agreements and contributor acceptance, signature, or submission records must remain in approved private systems.",
    matches: (artifactPath) => matchesContributorRecordStorage(artifactPath),
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

  const compatibilityNormalized = artifactPath.normalize("NFKC");
  let normalized = path.posix.normalize(
    path.posix
      .normalize(compatibilityNormalized.replace(/\\/gu, "/"))
      .normalize("NFKC")
      .replace(/\\/gu, "/")
  );
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
 * Classify contributor record categories while retaining explicit public
 * process, template, schema, validator, and policy documents. A matching
 * category used as a directory remains private regardless of its suffix.
 *
 * @param {string} artifactPath
 * @returns {boolean}
 */
function matchesContributorRecordStorage(artifactPath) {
  for (const match of artifactPath.matchAll(CONTRIBUTOR_PRIVATE_RECORD_PATTERN)) {
    const phraseEnd = match.index + match[0].length;
    const nextSeparator = artifactPath.indexOf("/", phraseEnd);
    const componentSuffix = artifactPath.slice(
      phraseEnd,
      nextSeparator === -1 ? artifactPath.length : nextSeparator
    );
    const isPublicDocumentation =
      nextSeparator === -1 &&
      PUBLIC_CONTRIBUTOR_DOCUMENT_QUALIFIER_PATTERNS.some((pattern) =>
        pattern.test(componentSuffix)
      );
    if (!isPublicDocumentation) {
      return true;
    }
  }

  return matchesHierarchicalContributorRecordStorage(artifactPath);
}

/**
 * Detect record-category layouts whose semantic terms are separated by one or
 * more intermediate path components. Public-document exceptions apply only to
 * terminal filenames, so a category expressed across directories fails closed.
 *
 * @param {string} artifactPath
 * @returns {boolean}
 */
function matchesHierarchicalContributorRecordStorage(artifactPath) {
  const words = artifactPath.split("/").flatMap((component, componentIndex) =>
    component
      .toLocaleLowerCase("en-US")
      .split(/[^a-z0-9]+/u)
      .filter(Boolean)
      .map((word) => ({ componentIndex, word }))
  );
  const isContributor = (word) =>
    word === "contributor" || word === "contributors";
  const isRecordCategory = (word) =>
    word === "acceptance" ||
    word === "acceptances" ||
    word === "signature" ||
    word === "signatures" ||
    word === "submission" ||
    word === "submissions";
  const isSigned = (word) => word === "signed";
  const isAgreement = (word) =>
    word === "agreement" ||
    word === "agreements" ||
    word === "cla" ||
    word === "clas";
  const isSignedOrSignature = (word) =>
    isSigned(word) || word === "signature" || word === "signatures";

  return [
    [isContributor, isRecordCategory],
    [isSigned, isContributor, isAgreement],
    [isContributor, isSigned, isAgreement],
    [isContributor, isAgreement, isSignedOrSignature],
  ].some((sequence) => hasCrossComponentSequence(words, sequence));
}

/**
 * Match an ordered semantic sequence in linear time and require it to span at
 * least two path components. Descending stage updates prevent one word from
 * satisfying more than one sequence position.
 *
 * @param {Array<{componentIndex: number, word: string}>} words
 * @param {Array<(word: string) => boolean>} sequence
 * @returns {boolean}
 */
function hasCrossComponentSequence(words, sequence) {
  const earliestStartByStage = Array(sequence.length).fill(undefined);

  for (const { componentIndex, word } of words) {
    for (let stage = sequence.length - 1; stage >= 0; stage -= 1) {
      if (!sequence[stage](word)) {
        continue;
      }

      if (stage === 0) {
        earliestStartByStage[0] ??= componentIndex;
        continue;
      }

      const startComponent = earliestStartByStage[stage - 1];
      if (startComponent === undefined) {
        continue;
      }
      if (stage === sequence.length - 1 && startComponent < componentIndex) {
        return true;
      }
      earliestStartByStage[stage] ??= startComponent;
    }
  }

  return false;
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
  const actualInventory = createExactPathInventory(actualPaths);
  const allowedInventory = createExactPathInventory(allowedPaths);

  for (const [normalizedPath, rawPath] of actualInventory.rawByNormalizedPath) {
    if (
      allowedInventory.rawByNormalizedPath.has(normalizedPath) &&
      allowedInventory.rawByNormalizedPath.get(normalizedPath) !== rawPath
    ) {
      throwRawArtifactIdentityError();
    }
  }

  const actual = new Set(actualInventory.rawByNormalizedPath.keys());
  const allowed = new Set(allowedInventory.rawByNormalizedPath.keys());

  return {
    missingPaths: sortPaths([...allowed].filter((entry) => !actual.has(entry))),
    unexpectedPaths: sortPaths([...actual].filter((entry) => !allowed.has(entry))),
  };
}

/**
 * Retain collision-free, prefix-stripped raw identities beside their canonical
 * policy paths. Rejected raw values are deliberately absent from errors.
 *
 * @param {Iterable<string>} artifactPaths
 * @returns {{rawPaths: Set<string>, rawByNormalizedPath: Map<string, string>}}
 */
function createExactPathInventory(artifactPaths) {
  const rawPaths = new Set();
  const rawByNormalizedPath = new Map();

  for (const entry of artifactPaths) {
    if (typeof entry !== "string") {
      throw new TypeError("Artifact paths must be strings.");
    }

    const rawPath = entry.startsWith("package/")
      ? entry.slice("package/".length)
      : entry;
    if (rawPaths.has(rawPath)) {
      throwRawArtifactIdentityError();
    }
    rawPaths.add(rawPath);

    const normalizedPath = normalizeArtifactPath(entry);
    if (!normalizedPath) {
      continue;
    }
    if (
      rawByNormalizedPath.has(normalizedPath) &&
      rawByNormalizedPath.get(normalizedPath) !== rawPath
    ) {
      throwRawArtifactIdentityError();
    }
    rawByNormalizedPath.set(normalizedPath, rawPath);
  }

  return { rawPaths, rawByNormalizedPath };
}

function throwRawArtifactIdentityError() {
  throw new Error(
    "Packed paths failed raw artifact identity or cardinality checks; values were not logged."
  );
}

/**
 * Summarize violations without exposing a suspected private path value.
 *
 * @param {Iterable<{ruleId: string}>} violations
 * @returns {string}
 */
function summarizePrivateArtifactViolations(violations) {
  const counts = new Map();
  for (const { ruleId } of violations) {
    counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
  }

  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([ruleId, count]) => `${ruleId}: ${count}`)
    .join(", ");
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
  summarizePrivateArtifactViolations,
};
