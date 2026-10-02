import { mock } from "bun:test";

// The SDK barrel loads the entire CLI/provider graph (and can stall Bun during
// module initialization). Keep these tests focused on our extension. Import the
// real editor and configuration implementations without initializing the CLI;
// only unrelated Markdown-help UI exports are stubbed.
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { CustomEditor } = await import(new URL("./modes/interactive/components/custom-editor.js", sdk).href);
const { getAgentDir } = await import(new URL("./config.js", sdk).href);
const unusedHelpUI = () => { throw new Error("Markdown help UI is not part of this test harness"); };
mock.module("@earendil-works/pi-coding-agent", () => ({
  CustomEditor,
  getAgentDir,
  DynamicBorder: class { constructor() { unusedHelpUI(); } },
  getMarkdownTheme: unusedHelpUI,
}));
