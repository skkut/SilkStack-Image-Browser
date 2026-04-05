## ComfyUI Parser Architecture

The ComfyUI parser is the most complex metadata parser in the project. It uses a **rule-based, declarative architecture** to handle ComfyUI's graph-based workflow format, recently refactored to separate data extraction from presentation logic.

**Location**: `services/parsers/comfyui/`

**Key Components:**

1. **Graph Construction** (`comfyUIParser.ts`)
   - Merges `workflow` (UI data with widgets_values) and `prompt` (execution data)
   - Handles NaN sanitization and incomplete exports
   - Overlays workflow nodes onto prompt data for complete graph representation

2. **Traversal Engine** (`traversalEngine.ts`)
   - Traverses graph backwards from SINK nodes (like KSampler)
   - Skips muted nodes (mode 2/4)
   - Supports multiple traversal strategies:
     - **Single Path**: For unique parameters (seed)
     - **Multi-Path**: For prompts (explores all paths)
     - **Pass-Through**: For routing nodes
   - **Generic Accumulation**: Uses declarative `accumulate: boolean` flag on param rules instead of hardcoded logic
   - **Structured Output**: `resolveFacts()` returns type-safe `WorkflowFacts` object with prompts, model, loras, sampling, and dimensions

3. **Node Registry** (`nodeRegistry.ts`)
   - Declarative node definitions with roles, inputs, outputs, and parameter mappings
   - **WorkflowFacts Interface**: Structured type for extracted workflow metadata
   - **Accumulate Flag**: Mark parameters that should collect values from all nodes in path (e.g., `lora: { source: 'widget', key: 'lora_name', accumulate: true }`)
   - See `services/parsers/comfyui/DEVELOPMENT.md` for complete reference

4. **Reusable Extractors** (`extractors.ts`)
   - Composable extraction functions for common patterns:
     - `concatTextExtractor`: Concatenate multiple text inputs
     - `extractLorasFromText`: Extract LoRA tags from `<lora:name>` syntax
     - `removeLoraTagsFromText`: Strip LoRA tags from prompts
     - `cleanWildcardText`: Remove unresolved wildcard artifacts
     - `extractLorasFromStack`: Parse LoRA Stack widget arrays
     - `getWildcardOrPopulatedText`: Prioritize populated over template text
   - Reduces code duplication by 80-90% across node definitions

**Adding New ComfyUI Nodes:**

1. Add node definition to `nodeRegistry.ts`:

```typescript
'NodeTypeName': {
  category: 'SAMPLING' | 'LOADING' | 'CONDITIONING' | 'ROUTING',
  roles: ['SOURCE', 'SINK', 'TRANSFORM', 'PASS_THROUGH'],
  inputs: { input_name: { type: 'MODEL' | 'CONDITIONING' | ... } },
  outputs: { output_name: { type: 'MODEL' | 'CONDITIONING' | ... } },
  param_mapping: {
    steps: { source: 'widget', key: 'steps' },              // Extract from widgets_values
    seed: { source: 'trace', input: 'seed' },                // Follow connection
    lora: { source: 'widget', key: 'lora_name', accumulate: true }, // Collect from all nodes
    prompt: {
      source: 'custom_extractor',
      extractor: (node, state, graph, traverse) =>
        extractors.concatTextExtractor(node, state, graph, traverse, ['text1', 'text2'])
    }
  },
  widget_order: ['widget1', 'widget2', ...]  // CRITICAL: Must match PNG export order
}
```

2. **Use Extractors When Possible**: Check `extractors.ts` for reusable functions before writing custom extractors. Common patterns like text concatenation, LoRA extraction, and wildcard cleaning are already implemented.

3. **Accumulate Flag**: For parameters that should collect values from multiple nodes in the graph (like LoRAs), add `accumulate: true` to the param mapping rule. The traversal engine will automatically collect values from all nodes instead of stopping at the first match.

4. **widget_order is CRITICAL**: The array must match the exact sequence in embedded PNG `widgets_values` data. Mismatches cause value swapping bugs (e.g., steps=0, cfg=28 instead of steps=28, cfg=3).

5. Add tests in `__tests__/comfyui/` with real workflow fixtures

6. Verify with actual ComfyUI PNG exports

**Common Issues:**

- **Value Swapping**: Missing `__unknown__` placeholders in `widget_order`
- **Unknown Nodes**: Add logging and fallback behavior in NodeRegistry
- **Missing Prompts**: Check if CLIPTextEncode nodes are properly traced
- **Dimensions**: Always read from image file properties, not workflow settings (images may be upscaled/cropped)

**Testing ComfyUI Parser:**

```bash
# Unit tests for specific nodes
npm test -- comfyui

# Test with real workflows
npm run cli:parse -- path/to/comfyui-image.png
```

For detailed documentation, see `services/parsers/comfyui/DEVELOPMENT.md`.
