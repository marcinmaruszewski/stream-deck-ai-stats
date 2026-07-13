import { readReleaseMetadata, assertReleaseTag } from "./release-contract.mjs";

const tag = process.argv[2];
if (!tag) throw new Error("Usage: node scripts/validate-release-tag.mjs vX.Y.Z");
const { packageMetadata } = await readReleaseMetadata();
assertReleaseTag(tag, packageMetadata.version);
console.log(`Release tag ${tag} matches package.json.`);
