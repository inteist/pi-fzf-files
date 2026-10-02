import { getKeybindings, type EditorComponent } from "@earendil-works/pi-tui";

import type { FzfFileAutocompleteProvider } from "./provider.js";

// Compatibility boundary for Pi 0.79.x's Editor/CustomEditor. Pi exposes cursor
// access but not public completion-invalidation/cancellation APIs. Keep these
// internal calls here, capability-check them, and exercise them against Editor in
// tests. Never synthesize Tab: it can automatically accept a single result.
interface RefreshableEditor extends EditorComponent {
  getLines(): string[];
  getCursor(): { line: number; col: number };
  requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void;
  cancelAutocomplete(): void;
}

/** Decorate, rather than replace, an existing custom editor's input behavior. */
export function attachFzfEditor(
  editor: EditorComponent,
  getProvider: () => FzfFileAutocompleteProvider | undefined,
): (() => void) | undefined {
  const candidate = editor as unknown as Partial<RefreshableEditor>;
  if (typeof candidate.getLines !== "function" || typeof candidate.getCursor !== "function" ||
    typeof candidate.requestAutocomplete !== "function" || typeof candidate.cancelAutocomplete !== "function") return undefined;
  const target = candidate as RefreshableEditor;
  let active = true;

  const observe = (provider: FzfFileAutocompleteProvider) => {
    const { line, col } = target.getCursor();
    return provider.observeEditor(target.getLines(), line, col);
  };

  const handleInput = target.handleInput;
  const wrappedInput = (data: string) => {
    const provider = active ? getProvider() : undefined;
    if (!provider) return handleInput.call(target, data);
    const wasAtQuery = observe(provider);
    const before = target.getText();
    const completionVersion = provider.completionVersion;
    handleInput.call(target, data);
    // Do not reopen the menu after accepting a completion, or mutate a provider
    // retired by a command/shortcut during input handling.
    if (!active || getProvider() !== provider || provider.completionVersion !== completionVersion) return;
    if (wasAtQuery && getKeybindings().matches(data, "tui.select.cancel")) {
      // Pi otherwise handles Escape only after a popup exists, not while the
      // first result is pending. Preserve the editor's own Escape handler above.
      target.cancelAutocomplete();
      provider.reset();
      return;
    }
    const inAtQuery = observe(provider);
    if (inAtQuery && target.getText() !== before) {
      target.requestAutocomplete({ force: false, explicitTab: false });
    }
  };
  target.handleInput = wrappedInput;

  const setText = target.setText;
  const wrappedSetText = (text: string) => {
    if (active) getProvider()?.reset();
    setText.call(target, text);
  };
  target.setText = wrappedSetText;

  return () => {
    active = false;
    // Preserve wrappers installed by another extension after ours.
    if (target.handleInput === wrappedInput) target.handleInput = handleInput;
    if (target.setText === wrappedSetText) target.setText = setText;
  };
}
