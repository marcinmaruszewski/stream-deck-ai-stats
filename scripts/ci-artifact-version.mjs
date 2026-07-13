import { ciArtifactVersion } from "./release-contract.mjs";

console.log(ciArtifactVersion({
  refType: process.env.GITHUB_REF_TYPE,
  refName: process.env.GITHUB_REF_NAME,
  runNumber: process.env.GITHUB_RUN_NUMBER,
}));
