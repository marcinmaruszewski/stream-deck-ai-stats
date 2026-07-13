import { validatePluginContract } from "./release-contract.mjs";

const result = await validatePluginContract();
console.log(`Validated plugin contract with development manifest ${result.manifestVersion} (${result.entries.length} runtime files).`);
