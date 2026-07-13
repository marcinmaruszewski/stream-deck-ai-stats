import { versionFromReleaseTag } from "./release-contract.mjs";

const tag = process.argv[2];
if (!tag) throw new Error("Usage: node scripts/validate-release-tag.mjs vX.Y.Z");
const version = versionFromReleaseTag(tag);
console.log(`Release tag ${tag} supplies version ${version}.`);
