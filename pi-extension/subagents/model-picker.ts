import type { Model } from "@mariozechner/pi-ai";
import * as codingAgent from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";

type ScopedModelItem = { model: Model<any>; thinkingLevel?: string };
type ModelSelector = Component & Focusable & {
  dispose?: () => void;
  readonly capturesViewportInput?: boolean;
};

/** The modern selector only needs these public registry operations, not the host's private runtime. */
function createRuntimeAdapter(registry: ExtensionContext["modelRegistry"]) {
  return {
    getAvailableSnapshot: () => registry.getAvailable(),
    getModel: (provider: string, id: string) => registry.find(provider, id),
    getError: () => registry.getError(),
    refresh: (...args: Parameters<typeof registry.refresh>) => registry.refresh(...args),
  };
}

type ModernModelSelectorConstructor = new (
  tui: TUI,
  currentModel: Model<any> | undefined,
  runtime: ReturnType<typeof createRuntimeAdapter>,
  scopedModels: ReadonlyArray<ScopedModelItem>,
  onSelect: (model: Model<any>) => void,
  onCancel: () => void,
) => ModelSelector;

/**
 * Use the host's exact /model renderer, search and key handling without changing
 * the main agent's model or persisted defaults. Mount directly in ctx.ui.custom().
 */
export function createSubagentModelSelector(
  tui: TUI,
  ctx: ExtensionContext,
  currentModel: Model<any> | undefined,
  onSelect: (model: Model<any>) => void,
  onCancel: () => void,
): ModelSelector {
  // scopedModels is public on modern hosts and absent on Mario 0.65. An empty
  // scope means all credentialed models; never derive scope from private state.
  const scopedModels = "scopedModels" in ctx
    ? (ctx.scopedModels as ReadonlyArray<ScopedModelItem>)
    : [];

  if ("ModelRuntime" in codingAgent) {
    // Earendil's public selector constructor changed from SettingsManager +
    // ModelRegistry to ModelRuntime. Keep that cross-version assertion at this
    // boundary: the adapter implements exactly the four operations it consumes.
    // Legacy @mariozechner imports are mapped to the modern host's exports.
    const NativeSelector = codingAgent.ModelSelectorComponent as unknown as ModernModelSelectorConstructor;
    // Deliberately omit the optional save-default callback and default reference.
    return new NativeSelector(
      tui,
      currentModel,
      createRuntimeAdapter(ctx.modelRegistry),
      scopedModels,
      onSelect,
      onCancel,
    );
  }

  // Mario's selector unconditionally saves its selection before onSelect. Give
  // it isolated in-memory settings so those writes cannot reach host settings.
  return new codingAgent.ModelSelectorComponent(
    tui,
    currentModel,
    codingAgent.SettingsManager.inMemory(),
    ctx.modelRegistry,
    scopedModels,
    onSelect,
    onCancel,
  );
}
