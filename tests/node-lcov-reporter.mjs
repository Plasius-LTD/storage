import path from "node:path";

function safeFunctionName(name, line, index) {
  const label = name || "anonymous";
  return `${label.replace(/[\r\n,]/gu, "_")}@${line}:${index}`;
}

function formatFileCoverage(file, workingDirectory) {
  const sourcePath = path
    .relative(workingDirectory, file.path)
    .replaceAll(path.sep, "/");
  const records = ["TN:node-private-artifact-policy", `SF:${sourcePath}`];

  file.functions.forEach((entry, index) => {
    const name = safeFunctionName(entry.name, entry.line, index);
    records.push(`FN:${entry.line},${name}`);
    records.push(`FNDA:${entry.count},${name}`);
  });
  records.push(`FNF:${file.totalFunctionCount}`);
  records.push(`FNH:${file.coveredFunctionCount}`);

  file.branches.forEach((entry, index) => {
    records.push(`BRDA:${entry.line},0,${index},${entry.count}`);
  });
  records.push(`BRF:${file.totalBranchCount}`);
  records.push(`BRH:${file.coveredBranchCount}`);

  file.lines.forEach((entry) => {
    records.push(`DA:${entry.line},${entry.count}`);
  });
  records.push(`LF:${file.totalLineCount}`);
  records.push(`LH:${file.coveredLineCount}`);
  records.push("end_of_record");

  return records.join("\n");
}

export default async function* report(source) {
  for await (const event of source) {
    if (event.type !== "test:coverage") {
      continue;
    }

    const { files, workingDirectory } = event.data.summary;
    yield `${files
      .map((file) => formatFileCoverage(file, workingDirectory))
      .join("\n")}\n`;
  }
}
