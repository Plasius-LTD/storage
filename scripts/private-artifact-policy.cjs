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

const STRICT_CLA_MARKERS = new Set(["cla", "clas"]);
const CONTRIBUTOR_MARKERS = new Set(["contributor", "contributors"]);
const RECORD_CATEGORY_MARKERS = new Set([
  "acceptance",
  "acceptances",
  "signature",
  "signatures",
  "submission",
  "submissions",
]);
const AGREEMENT_MARKERS = new Set(["agreement", "agreements"]);

const NUMERIC_WRAPPER_PREFIXES = Object.freeze([
  "generation",
  "revision",
  "version",
  "v",
]);

// These words may wrap a protected separator-free record/registry alias. Keep
// this vocabulary closed so ordinary words containing a protected substring
// (for example, "unsignedcla" or "personalizationregistry") remain public.
const CONCATENATED_POLICY_WRAPPER_WORDS = Object.freeze([
  "acceptance",
  "acceptances",
  "archive",
  "archives",
  "backup",
  "backups",
  "copy",
  "copies",
  "executed",
  "final",
  "record",
  "records",
  "signature",
  "signatures",
  "signed",
  "storage",
  "submission",
  "submissions",
  "process",
  "template",
  "templates",
  "policy",
  "policies",
  "guide",
  "guides",
  "guidance",
  "documentation",
  "doc",
  "docs",
  "instruction",
  "instructions",
  "example",
  "examples",
  "schema",
  "schemas",
  "validator",
  "validators",
  "format",
  "formats",
  "spec",
  "specs",
  "specification",
  "specifications",
]);

const safeArtifactPolicyErrors = new WeakMap();

const SEMANTIC_FEATURES = Object.freeze({
  PRIVACY: 1 << 0,
  REGISTRY: 1 << 1,
  CLA: 1 << 2,
  CONTRIBUTOR: 1 << 3,
  RECORD_CATEGORY: 1 << 4,
  SIGNED: 1 << 5,
  AGREEMENT: 1 << 6,
});

const PUBLIC_DOCUMENT_QUALIFIERS = Object.freeze({
  prose: new Set([
    "process",
    "template",
    "templates",
    "policy",
    "policies",
    "guide",
    "guides",
    "guidance",
    "documentation",
    "doc",
    "docs",
    "instruction",
    "instructions",
    "example",
    "examples",
  ]),
  schema: new Set([
    "schema",
    "schemas",
    "validator",
    "validators",
    "format",
    "formats",
    "spec",
    "specs",
    "specification",
    "specifications",
  ]),
});

const PUBLIC_QUALIFIER_NONE = 0;
const PUBLIC_QUALIFIER_PROSE = 1;
const PUBLIC_QUALIFIER_SCHEMA = 2;
const SEMANTIC_STATE_QUALIFIER_SHIFT = 8;
const SEMANTIC_STATE_MASK = (1 << SEMANTIC_STATE_QUALIFIER_SHIFT) - 1;

const SEMANTIC_POLICY_WORDS = createSemanticPolicyWords();
const SEMANTIC_POLICY_WORDS_BY_INITIAL = groupSemanticWordsByInitial(
  SEMANTIC_POLICY_WORDS
);

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
    matches: (_artifactPath, semanticPath) =>
      matchesSemanticFamily(
        semanticPath,
        (mask) =>
          hasSemanticFeature(mask, SEMANTIC_FEATURES.REGISTRY) &&
          (hasSemanticFeature(mask, SEMANTIC_FEATURES.CLA) ||
            hasSemanticFeature(mask, SEMANTIC_FEATURES.CONTRIBUTOR))
      ),
  }),
  Object.freeze({
    id: "contributor-record-storage",
    description:
      "Signed contributor agreements and contributor acceptance, signature, or submission records must remain in approved private systems.",
    matches: (_artifactPath, semanticPath) =>
      matchesSemanticFamily(
        semanticPath,
        matchesContributorRecordMask,
        SEMANTIC_FEATURES.CONTRIBUTOR |
          SEMANTIC_FEATURES.RECORD_CATEGORY |
          SEMANTIC_FEATURES.SIGNED |
          SEMANTIC_FEATURES.AGREEMENT
      ),
  }),
  Object.freeze({
    id: "signed-cla-storage",
    description:
      "Signed CLA submissions and signature records must remain in approved private systems.",
    matches: (_artifactPath, semanticPath) =>
      matchesSemanticFamily(
        semanticPath,
        matchesSignedClaRecordMask,
        SEMANTIC_FEATURES.CLA |
          SEMANTIC_FEATURES.SIGNED |
          SEMANTIC_FEATURES.RECORD_CATEGORY
      ),
  }),
  Object.freeze({
    id: "private-registry",
    description:
      "Registry paths marked private, confidential, internal, personal, or PII must remain outside public artifacts.",
    matches: (_artifactPath, semanticPath) =>
      matchesSemanticFamily(
        semanticPath,
        (mask) =>
          hasSemanticFeature(mask, SEMANTIC_FEATURES.PRIVACY) &&
          hasSemanticFeature(mask, SEMANTIC_FEATURES.REGISTRY)
      ),
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
 * Canonicalize Windows-ignored trailing dots and spaces only for policy
 * classification. The raw normalized identity remains unchanged for package
 * allowlists, collision checks, and violation accounting.
 *
 * @param {string} artifactPath
 * @returns {string}
 */
function canonicalizeArtifactPathForClassification(artifactPath) {
  const windowsCanonicalPath = artifactPath
    .split("/")
    .map((component) =>
      component === "." || component === ".."
        ? component
        : component.replace(/[ .]+$/gu, "")
    )
    .join("/");
  const structurallyCanonicalPath = path.posix.normalize(windowsCanonicalPath);
  return structurallyCanonicalPath === "." ? "" : structurallyCanonicalPath;
}

/**
 * Build one closed vocabulary for every protected marker and permitted wrapper.
 * A token must be fully segmentable through this vocabulary (or explicit camel
 * boundaries) before any embedded marker contributes to classification.
 *
 * @returns {Map<string, {featureMask: number, qualifier: number}>}
 */
function createSemanticPolicyWords() {
  const words = new Map(
    CONCATENATED_POLICY_WRAPPER_WORDS.map((word) => [
      word,
      { featureMask: 0, qualifier: PUBLIC_QUALIFIER_NONE },
    ])
  );

  const addWords = (values, featureMask, qualifier = PUBLIC_QUALIFIER_NONE) => {
    for (const word of values) {
      const existing = words.get(word) ?? {
        featureMask: 0,
        qualifier: PUBLIC_QUALIFIER_NONE,
      };
      words.set(word, {
        featureMask: existing.featureMask | featureMask,
        qualifier: qualifier || existing.qualifier,
      });
    }
  };

  addWords(PRIVACY_MARKERS, SEMANTIC_FEATURES.PRIVACY);
  addWords(REGISTRY_MARKERS, SEMANTIC_FEATURES.REGISTRY);
  addWords(STRICT_CLA_MARKERS, SEMANTIC_FEATURES.CLA | SEMANTIC_FEATURES.AGREEMENT);
  addWords(CONTRIBUTOR_MARKERS, SEMANTIC_FEATURES.CONTRIBUTOR);
  addWords(RECORD_CATEGORY_MARKERS, SEMANTIC_FEATURES.RECORD_CATEGORY);
  addWords(AGREEMENT_MARKERS, SEMANTIC_FEATURES.AGREEMENT);
  addWords(["signed"], SEMANTIC_FEATURES.SIGNED);
  addWords(
    PUBLIC_DOCUMENT_QUALIFIERS.prose,
    0,
    PUBLIC_QUALIFIER_PROSE
  );
  addWords(
    PUBLIC_DOCUMENT_QUALIFIERS.schema,
    0,
    PUBLIC_QUALIFIER_SCHEMA
  );

  return words;
}

/**
 * @param {Map<string, {featureMask: number, qualifier: number}>} words
 * @returns {Map<string, Array<[string, {featureMask: number, qualifier: number}]>>}
 */
function groupSemanticWordsByInitial(words) {
  const grouped = new Map();
  for (const entry of words) {
    const initial = entry[0][0];
    const entries = grouped.get(initial) ?? [];
    entries.push(entry);
    grouped.set(initial, entries);
  }
  return grouped;
}

/**
 * Analyze every component once so all policy rules share identical marker,
 * wrapper, casing, separator, and concatenation semantics.
 *
 * @param {string} artifactPath
 * @returns {{mask: number, nonTerminalMask: number, publicDocument: {mask: number, qualifier: number} | undefined}}
 */
function analyzeSemanticPath(artifactPath) {
  const components = artifactPath.split("/");
  const terminalIndex = components.length - 1;
  let mask = 0;
  let nonTerminalMask = 0;

  for (let index = 0; index < components.length; index += 1) {
    const componentMask = analyzeSemanticComponent(components[index]).mask;
    mask |= componentMask;
    if (index !== terminalIndex) {
      nonTerminalMask |= componentMask;
    }
  }

  return {
    mask,
    nonTerminalMask,
    publicDocument: analyzePublicDocumentComponent(components[terminalIndex]),
  };
}

/**
 * @param {string} component
 * @returns {{mask: number, trailingQualifiers: Set<number>, publicSuffixSafe: boolean}}
 */
function analyzeSemanticComponent(component) {
  const segments = component.split(/[^a-z0-9]+/iu).filter(Boolean);
  let mask = 0;
  let trailingQualifiers = new Set([PUBLIC_QUALIFIER_NONE]);
  let protectedSeen = false;
  let publicSuffixSafe = true;

  for (const segment of segments) {
    const analysis = analyzeSemanticSegment(segment);
    if (
      analysis.unknownAfterProtected ||
      (protectedSeen && !analysis.recognized)
    ) {
      publicSuffixSafe = false;
    }
    mask |= analysis.mask;
    if (analysis.mask !== 0) {
      protectedSeen = true;
    }
    if (!analysis.recognized) {
      trailingQualifiers = new Set([PUBLIC_QUALIFIER_NONE]);
    } else if (!analysis.numericOnly) {
      trailingQualifiers = analysis.trailingQualifiers;
    }
  }

  return { mask, trailingQualifiers, publicSuffixSafe };
}

/**
 * Prefer complete case-folded segmentation so casing cannot alter the policy.
 * If an otherwise opaque value has explicit camel boundaries, analyze those
 * words independently while retaining unknown-word protection.
 *
 * @param {string} segment
 * @returns {{mask: number, trailingQualifiers: Set<number>, recognized: boolean, numericOnly: boolean, unknownAfterProtected: boolean}}
 */
function analyzeSemanticSegment(segment) {
  const loweredSegment = segment.toLocaleLowerCase("en-US");
  const states = segmentSemanticValue(loweredSegment);
  if (states !== undefined) {
    return {
      ...summarizeSemanticStates(
        states,
        isNumericWrapper(loweredSegment)
      ),
      unknownAfterProtected: false,
    };
  }

  const camelWords = segment
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(" ");
  if (camelWords.length === 1) {
    return {
      mask: 0,
      trailingQualifiers: new Set([PUBLIC_QUALIFIER_NONE]),
      recognized: false,
      numericOnly: false,
      unknownAfterProtected: false,
    };
  }

  let mask = 0;
  let trailingQualifiers = new Set([PUBLIC_QUALIFIER_NONE]);
  let recognized = false;
  let numericOnly = true;
  let protectedSeen = false;
  let unknownAfterProtected = false;
  for (const camelWord of camelWords) {
    const loweredWord = camelWord.toLocaleLowerCase("en-US");
    const wordStates = segmentSemanticValue(loweredWord);
    if (wordStates === undefined) {
      trailingQualifiers = new Set([PUBLIC_QUALIFIER_NONE]);
      numericOnly = false;
      unknownAfterProtected ||= protectedSeen;
      continue;
    }
    const wordAnalysis = summarizeSemanticStates(
      wordStates,
      isNumericWrapper(loweredWord)
    );
    recognized = true;
    mask |= wordAnalysis.mask;
    if (wordAnalysis.mask !== 0) {
      protectedSeen = true;
    }
    if (!wordAnalysis.numericOnly) {
      trailingQualifiers = wordAnalysis.trailingQualifiers;
      numericOnly = false;
    }
  }

  return {
    mask,
    trailingQualifiers,
    recognized,
    numericOnly,
    unknownAfterProtected,
  };
}

/**
 * Segment one complete alphanumeric value through the global semantic
 * vocabulary. State retains both accumulated protected features and whether
 * the final non-version word is a public-document qualifier.
 *
 * @param {string} value
 * @returns {Set<number> | undefined}
 */
function segmentSemanticValue(value) {
  const statesByOffset = new Map([[0, new Set([0])]]);
  let lastReachableOffset = 0;

  for (
    let index = 0;
    index <= lastReachableOffset && index < value.length;
    index += 1
  ) {
    const states = statesByOffset.get(index);
    if (states === undefined) {
      continue;
    }

    const words = SEMANTIC_POLICY_WORDS_BY_INITIAL.get(value[index]) ?? [];
    for (const [word, metadata] of words) {
      if (!value.startsWith(word, index)) {
        continue;
      }
      const nextOffset = index + word.length;
      const nextStates = statesByOffset.get(nextOffset) ?? new Set();
      for (const state of states) {
        const featureMask =
          (state & SEMANTIC_STATE_MASK) | metadata.featureMask;
        nextStates.add(
          featureMask |
            (metadata.qualifier << SEMANTIC_STATE_QUALIFIER_SHIFT)
        );
      }
      statesByOffset.set(nextOffset, nextStates);
      lastReachableOffset = Math.max(lastReachableOffset, nextOffset);
    }

    const numericEnd = consumeNumericWrapper(value, index);
    if (numericEnd !== undefined) {
      const nextStates = statesByOffset.get(numericEnd) ?? new Set();
      for (const state of states) {
        nextStates.add(state);
      }
      statesByOffset.set(numericEnd, nextStates);
      lastReachableOffset = Math.max(lastReachableOffset, numericEnd);
    }
  }

  return statesByOffset.get(value.length);
}

/**
 * @param {Set<number>} states
 * @param {boolean} numericOnly
 * @returns {{mask: number, trailingQualifiers: Set<number>, recognized: true, numericOnly: boolean}}
 */
function summarizeSemanticStates(states, numericOnly) {
  let mask = 0;
  const trailingQualifiers = new Set();
  for (const state of states) {
    mask |= state & SEMANTIC_STATE_MASK;
    trailingQualifiers.add(state >> SEMANTIC_STATE_QUALIFIER_SHIFT);
  }
  return { mask, trailingQualifiers, recognized: true, numericOnly };
}

/**
 * Recognize only terminal public documentation with an allowlisted qualifier,
 * extension, and optional compact or separated numeric/version suffix.
 *
 * @param {string} component
 * @returns {{mask: number, qualifier: number} | undefined}
 */
function analyzePublicDocumentComponent(component) {
  const extensionMatch = component
    .toLocaleLowerCase("en-US")
    .match(/\.(d\.[cm]?[jt]s|[cm]?[jt]sx?|mdx?|json|ya?ml|rst|adoc|txt|pdf)$/u);
  if (!extensionMatch) {
    return undefined;
  }

  const extension = extensionMatch[1];
  const basename = component.slice(0, -extensionMatch[0].length);
  const analysis = analyzeSemanticComponent(basename);
  if (!analysis.publicSuffixSafe) {
    return undefined;
  }
  const allowedQualifiers = new Set();
  if (/^(?:mdx?|rst|adoc|txt|pdf)$/u.test(extension)) {
    allowedQualifiers.add(PUBLIC_QUALIFIER_PROSE);
  }
  if (/^(?:d\.[cm]?[jt]s|[cm]?[jt]sx?|mdx?|json|ya?ml)$/u.test(extension)) {
    allowedQualifiers.add(PUBLIC_QUALIFIER_SCHEMA);
  }

  const qualifier = [...analysis.trailingQualifiers].find((candidate) =>
    allowedQualifiers.has(candidate)
  );
  return qualifier === undefined
    ? undefined
    : { mask: analysis.mask, qualifier };
}

/**
 * @param {{mask: number, nonTerminalMask: number, publicDocument: {mask: number, qualifier: number} | undefined}} semanticPath
 * @param {(mask: number) => boolean} predicate
 * @param {number} [publicRelevantMask]
 * @returns {boolean}
 */
function matchesSemanticFamily(
  semanticPath,
  predicate,
  publicRelevantMask = 0
) {
  if (!predicate(semanticPath.mask)) {
    return false;
  }
  if (
    publicRelevantMask === 0 ||
    semanticPath.publicDocument === undefined ||
    !predicate(semanticPath.publicDocument.mask)
  ) {
    return true;
  }

  return (semanticPath.nonTerminalMask & publicRelevantMask) !== 0;
}

function matchesContributorRecordMask(mask) {
  return (
    hasSemanticFeature(mask, SEMANTIC_FEATURES.CONTRIBUTOR) &&
    (hasSemanticFeature(mask, SEMANTIC_FEATURES.RECORD_CATEGORY) ||
      (hasSemanticFeature(mask, SEMANTIC_FEATURES.SIGNED) &&
        hasSemanticFeature(mask, SEMANTIC_FEATURES.AGREEMENT)))
  );
}

function matchesSignedClaRecordMask(mask) {
  return (
    hasSemanticFeature(mask, SEMANTIC_FEATURES.CLA) &&
    (hasSemanticFeature(mask, SEMANTIC_FEATURES.SIGNED) ||
      hasSemanticFeature(mask, SEMANTIC_FEATURES.RECORD_CATEGORY))
  );
}

function hasSemanticFeature(mask, feature) {
  return (mask & feature) === feature;
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
    const classificationPath = canonicalizeArtifactPathForClassification(
      artifactPath
    );
    if (!classificationPath) {
      continue;
    }

    const semanticPath = analyzeSemanticPath(classificationPath);

    for (const rule of PRIVATE_ARTIFACT_RULES) {
      if (!rule.matches(classificationPath, semanticPath)) {
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
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      throw createSafeArtifactPolicyError("working-tree-enumeration-failed");
    }
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
  let output;
  try {
    output = execFileSync(
      "git",
      ["ls-files", "--cached", "-z", "--"],
      {
        cwd: path.resolve(rootDirectory),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
  } catch {
    throw createSafeArtifactPolicyError("git-index-enumeration-failed");
  }

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

/**
 * Create a policy exception whose externally renderable metadata contains only
 * an allowlisted code and optional rule counts. The original exception, path,
 * message, and stack are deliberately not retained.
 *
 * @param {string} code
 * @param {string} [safeCounts]
 * @returns {Error}
 */
function createSafeArtifactPolicyError(code, safeCounts = "") {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(code)) {
    throw new TypeError("Safe artifact policy error codes must be kebab-case.");
  }
  if (
    safeCounts &&
    !/^[a-z0-9]+(?:-[a-z0-9]+)*: [1-9][0-9]*(?:, [a-z0-9]+(?:-[a-z0-9]+)*: [1-9][0-9]*)*$/u.test(
      safeCounts
    )
  ) {
    throw new TypeError("Safe artifact policy counts have an invalid shape.");
  }

  const error = new Error("Artifact policy operation failed safely.");
  safeArtifactPolicyErrors.set(error, Object.freeze({ code, safeCounts }));
  return error;
}

/**
 * Render only metadata produced by createSafeArtifactPolicyError. Unknown
 * exceptions collapse to the caller-provided safe fallback code.
 *
 * @param {unknown} error
 * @param {string} fallbackCode
 * @returns {string}
 */
function formatSafeArtifactPolicyError(error, fallbackCode) {
  const metadata =
    error instanceof Error ? safeArtifactPolicyErrors.get(error) : undefined;
  const code = metadata?.code ?? fallbackCode;
  return metadata?.safeCounts
    ? `code=${code}; counts=${metadata.safeCounts}`
    : `code=${code}`;
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

/**
 * Consume a complete decimal run, optionally prefixed by a closed numeric
 * wrapper vocabulary. Wrapper state is preserved so a numeric suffix cannot
 * hide protected terms or revoke a preceding public-document qualifier.
 *
 * @param {string} value
 * @param {number} start
 * @returns {number | undefined}
 */
function consumeNumericWrapper(value, start) {
  let index = start;
  for (const prefix of NUMERIC_WRAPPER_PREFIXES) {
    const prefixEnd = start + prefix.length;
    if (
      value.startsWith(prefix, start) &&
      /[0-9]/u.test(value[prefixEnd] ?? "")
    ) {
      index = prefixEnd;
      break;
    }
  }
  if (!/[0-9]/u.test(value[index] ?? "")) {
    return undefined;
  }
  while (/[0-9]/u.test(value[index] ?? "")) {
    index += 1;
  }
  return index;
}

function isNumericWrapper(value) {
  return consumeNumericWrapper(value, 0) === value.length;
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
  createSafeArtifactPolicyError,
  findPackageFilesPolicyViolations,
  findPrivateArtifactViolations,
  formatSafeArtifactPolicyError,
  normalizeArtifactPath,
  PRIVATE_ARTIFACT_RULES,
  summarizePrivateArtifactViolations,
};
