import { cp, mkdir, rm, writeFile } from "node:fs/promises";

const bundle = new URL("../com.marcinmaruszewski.ai-usage.sdPlugin/bin/", import.meta.url);
await rm(bundle, { recursive: true, force: true });
await mkdir(bundle, { recursive: true });
await cp(new URL("../src/", import.meta.url), new URL("./", bundle), { recursive: true });
await writeFile(new URL("./plugin.js", bundle), 'import { startStreamDeckPlugin } from "./stream-deck/runtime.js";\nstartStreamDeckPlugin();\n');
