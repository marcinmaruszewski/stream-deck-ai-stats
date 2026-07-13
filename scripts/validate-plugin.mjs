import { validatePluginContract } from "./release-contract.mjs";

const result = await validatePluginContract();
console.log(`Validated plugin contract for v${result.packageVersion} (${result.entries.length} runtime files).`);
