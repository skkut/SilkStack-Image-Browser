import { resolve, resolveAll, resolveFacts } from './comfyui/traversalEngine';
import { ParserNode, NodeRegistry, WorkflowFacts } from './comfyui/nodeRegistry';

// Lazy-loaded zlib for Node.js environment
let zlibPromise: Promise<any> | null = null;

async function getZlib(): Promise<any> {
  if (typeof window !== 'undefined') {
    return null; // Browser environment
  }

  if (!zlibPromise) {
    zlibPromise = import('zlib').catch(() => {
      console.warn('[ComfyUI Parser] zlib not available, compression support disabled');
      return null;
    });
  }

  return zlibPromise;
}

type Graph = Record<string, ParserNode>;

interface ParseResult {
  data: any;
  detectionMethod: 'json' | 'base64' | 'compressed' | 'regex' | 'unknown';
  warnings: string[];
}

/**
 * Tenta parsear payload do ComfyUI com múltiplas estratégias de descompressão e fallback
 */
async function tryParseComfyPayload(raw: string): Promise<ParseResult | null> {
  const warnings: string[] = [];
  
  // 1. Try direct JSON
  try {
    const parsed = JSON.parse(raw);
    return { data: parsed, detectionMethod: 'json', warnings };
  } catch (e) {
    warnings.push('Direct JSON parse failed');
  }
  
  // 2. Base64 decode
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return { data: parsed, detectionMethod: 'base64', warnings };
  } catch (e) {
    warnings.push('Base64 decode failed');
  }
  
  // 3. zlib/gzip decompression (Node.js only)
  const zlib = await getZlib();
  if (zlib && typeof Buffer !== 'undefined') {
    try {
      // Detect zlib magic bytes (\x78\x9c)
      const buffer = Buffer.from(raw, 'base64');
      if (buffer[0] === 0x78 && buffer[1] === 0x9c) {
        const inflated = zlib.inflateSync(buffer);
        const parsed = JSON.parse(inflated.toString('utf8'));
        return { data: parsed, detectionMethod: 'compressed', warnings };
      }
    } catch (e) {
      warnings.push('zlib decompression failed');
    }
  }
  
  // 4. Regex fallback - find large JSON blocks
  try {
    const match = raw.match(/\{[\s\S]{200,}\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      warnings.push('Used regex fallback to find JSON block');
      return { data: parsed, detectionMethod: 'regex', warnings };
    }
  } catch (e) {
    warnings.push('Regex JSON fallback failed');
  }
  
  return null;
}

/**
 * Detecção agressiva de payload ComfyUI em chunks PNG
 */
function detectComfyPayload(chunks: string[]): { payload: string; method: string } | null {
  const combinedText = chunks.join('\n').toLowerCase();
  
  // Procura por strings indicativas do ComfyUI
  const comfyIndicators = ['comfyui', 'workflow', 'nodes', 'comfy', 'class_type'];
  const hasComfyIndicator = comfyIndicators.some(indicator => combinedText.includes(indicator));
  
  if (hasComfyIndicator) {
    return { payload: chunks.join('\n'), method: 'keyword' };
  }
  
  // Regex para detectar blocos JSON grandes (>200 caracteres)
  const largeJsonMatch = chunks.join('\n').match(/\{[\s\S]{200,}\}/);
  if (largeJsonMatch) {
    return { payload: largeJsonMatch[0], method: 'regex_large_json' };
  }
  
  return null;
}

/**
 * Fallback regex inteligente para extrair parâmetros de strings de texto
 */
function extractParamsWithRegex(text: string): Partial<Record<string, any>> {
  const params: any = { raw_parsed_with_regex: true };
  
  // Prompt block
  const promptMatch = text.match(/Prompt[:\n]\s*(\S.+?)(?:\n(?:Negative prompt|Steps|Sampler|Seed)|$)/i);
  if (promptMatch) params.prompt = promptMatch[1].trim();
  
  // Negative prompt
  const negativeMatch = text.match(/Negative prompt[:\n]\s*(\S.+?)(?:\n(?:Steps|Sampler|Seed)|$)/i);
  if (negativeMatch) params.negativePrompt = negativeMatch[1].trim();
  
  // Steps
  const stepsMatch = text.match(/Steps[:=]\s*(\d{1,4})/i);
  if (stepsMatch) params.steps = parseInt(stepsMatch[1], 10);
  
  // CFG
  const cfgMatch = text.match(/(?:CFG|cfg_scale|guidance_scale)[:=]\s*([0-9]*\.?[0-9]+)/i);
  if (cfgMatch) params.cfg = parseFloat(cfgMatch[1]);
  
  // Sampler
  const samplerMatch = text.match(/Sampler[:=]\s*([A-Za-z0-9\-_+]+)/i);
  if (samplerMatch) params.sampler_name = samplerMatch[1];
  
  // Seed
  const seedMatch = text.match(/Seed[:=]\s*(\d+)/i);
  if (seedMatch) params.seed = parseInt(seedMatch[1], 10);
  
  // Model
  const modelMatch = text.match(/Model[:=]\s*(\S.+?)(?:\n|,|$)/i);
  if (modelMatch) params.model = modelMatch[1].trim();
  
  return params;
}

/**
 * Advanced Seed Extraction with multiple formats:
 * - Numeric: "seed": 12345
 * - Hex: "seed": "0xabc123"
 * - Derived: "derived_seed": {...} → approximateSeed flag
 */
function extractAdvancedSeed(node: ParserNode | null, graph: Graph): { seed: number | null; approximateSeed?: boolean } {
  // Handle null node
  if (!node) {
    return { seed: null };
  }

  // A linked seed input is authoritative. When ComfyUI converts a sampler's
  // seed widget into an input, widgets_values keeps a stale copy while the
  // link executes — so resolve through the link (usually to a SeedNode)
  // instead of letting the widget scan below return the stale value.
  const seedLink = node.inputs?.seed;
  if (Array.isArray(seedLink) && seedLink.length === 2) {
    const linkedSeed = resolve({ startNode: node, param: 'seed', graph });
    if (typeof linkedSeed === 'number' && !isNaN(linkedSeed)) {
      return { seed: linkedSeed };
    }
    if (typeof linkedSeed === 'string' && linkedSeed.startsWith('0x')) {
      const hexLinked = parseInt(linkedSeed, 16);
      if (!isNaN(hexLinked)) return { seed: hexLinked };
    }
  }

  // Try numeric seed first (standard path)
  if (typeof node.inputs?.seed === 'number') {
    return { seed: node.inputs.seed };
  }
  
  // Try hex format as string in inputs: "seed": "0xabc123"
  if (typeof node.inputs?.seed === 'string' && node.inputs.seed.startsWith('0x')) {
    const hexSeed = parseInt(node.inputs.seed, 16);
    if (!isNaN(hexSeed)) {
      return { seed: hexSeed };
    }
  }
  
  // Try widgets_values for numeric seed
  if (Array.isArray(node.widgets_values)) {
    for (const value of node.widgets_values) {
      if (typeof value === 'number' && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
        return { seed: value };
      }
      // Try hex in widgets_values
      if (typeof value === 'string' && value.startsWith('0x')) {
        const hexSeed = parseInt(value, 16);
        if (!isNaN(hexSeed)) {
          return { seed: hexSeed };
        }
      }
    }
  }
  
  // Try derived_seed (randomized seed based on other inputs)
  if (node.inputs?.derived_seed || node.inputs?.random_seed) {
    // Use timestamp-based approximation
    const approximateSeed = Math.floor(Date.now() / 1000) % 2147483647;
    return { seed: approximateSeed, approximateSeed: true };
  }
  
  return { seed: null };
}

/**
 * Advanced Model Detection with hash mapping:
 * - Extracts model name from CheckpointLoader, LoraLoader nodes
 * - Maps model hashes to "unknown (hash: xxxx)" format
 */
function extractAdvancedModel(node: ParserNode | null, graph: Graph): string | null {
  if (!node) return null;



  // FIRST: Traverse to source nodes (CheckpointLoader) via model connections
  // This ensures we follow the chain: LoraLoader -> LoraLoader -> CheckpointLoader
  if (node.inputs?.model && Array.isArray(node.inputs.model)) {
    const [sourceId] = node.inputs.model;
    const sourceNode = graph[sourceId];
    if (sourceNode) {
      const sourceModel = extractAdvancedModel(sourceNode, graph);
      if (sourceModel) {
        return sourceModel;
      }
    }
  }

  // SECOND: Try direct input values (for nodes that have model_name/ckpt_name in inputs)
  if (typeof node.inputs?.model_name === 'string') {
    return node.inputs.model_name;
  }

  if (typeof node.inputs?.ckpt_name === 'string') {
    return node.inputs.ckpt_name;
  }

  if (typeof node.inputs?.unet_name === 'string') {
    return node.inputs.unet_name;
  }

  // THIRD: Try widgets_values for model name (only for CheckpointLoader-type nodes)
  // Check if this is a checkpoint loader node to avoid picking up LoRA names
  const isCheckpointLoader = node.class_type?.toLowerCase().includes('checkpoint') ||
                             node.class_type?.toLowerCase().includes('unet') ||
                             node.class_type === 'CheckpointLoaderSimple';

  if (isCheckpointLoader && Array.isArray(node.widgets_values)) {
    for (const value of node.widgets_values) {
      if (typeof value === 'string' && (value.endsWith('.safetensors') || value.endsWith('.ckpt') || value.endsWith('.pt'))) {
        return value;
      }
    }
  }

  // LAST: Try model hash fallback
  const hashMatch = JSON.stringify(node).match(/"(?:model_hash|hash)"\s*:\s*"([0-9a-fA-F]{8,})"/);
  if (hashMatch) {
    return `unknown (hash: ${hashMatch[1].substring(0, 8)})`;
  }

  return null;
}

/**
 * Extract ControlNet, LoRA, and VAE with weights and parameters
 */
function extractAdvancedModifiers(graph: Graph): {
  controlnets: Array<{ name: string; weight?: number; module?: string; applied_to?: string }>;
  loras: Array<{ name: string; weight?: number }>;
  vaes: Array<{ name: string }>;
} {
  const controlnets: any[] = [];
  const loras: any[] = [];
  const vaes: any[] = [];
  
  for (const nodeId in graph) {
    const node = graph[nodeId];
    if (!node.class_type) continue; // Skip nodes without class_type
    if (node.mode === 2 || node.mode === 4) continue; // muted/bypassed nodes never ran
    const classType = node.class_type.toLowerCase();

    // ControlNet detection (only from loaders, not apply nodes)
    if (classType.includes('controlnet') && classType.includes('loader')) {
      const name = node.inputs?.control_net_name || node.inputs?.model || node.widgets_values?.[0] || 'unknown';
      
      // Try to find corresponding apply node for weight
      let weight = 1.0;
      const module = node.inputs?.preprocessor || node.inputs?.module;
      let applied_to = undefined;
      
      // Search for ControlNetApply nodes that reference this loader
      for (const applyNodeId in graph) {
        const applyNode = graph[applyNodeId];
        if (!applyNode.class_type) continue; // Skip nodes without class_type
        if (applyNode.class_type.toLowerCase().includes('controlnetapply')) {
          // Check if this apply node uses our loader
          if (applyNode.inputs?.control_net && Array.isArray(applyNode.inputs.control_net)) {
            const [refId] = applyNode.inputs.control_net;
            if (refId === nodeId) {
              weight = applyNode.inputs?.strength || applyNode.inputs?.weight || applyNode.widgets_values?.[0] || 1.0;
              applied_to = applyNode.inputs?.image ? 'image' : applyNode.inputs?.latent ? 'latent' : undefined;
              break;
            }
          }
        }
      }
      
      controlnets.push({ name, weight, module, applied_to });
    }
    
    // LoRA detection
    if (classType === 'power lora loader (rgthree)') {
      // Power Lora Loader stores LoRAs as structured objects in widgets_values
      // Each enabled LoRA has { on: true, lora: "path.safetensors", strength: 0.8 }
      if (Array.isArray(node.widgets_values)) {
        for (const entry of node.widgets_values) {
          if (entry && typeof entry === 'object' && entry.on === true && entry.lora) {
            let loraPath = String(entry.lora);
            loraPath = loraPath.replace(/^(?:flux|Flux|FLUX)[\/\-\s]+/i, '');
            loraPath = loraPath.replace(/\.safetensors$/i, '').trim();
            if (loraPath) {
              loras.push({ name: loraPath, weight: entry.strength ?? 1.0 });
            }
          }
        }
      }
      // API-format prompts keep the LoRA list in inputs (lora_1..lora_N)
      // instead of widgets_values — each entry is { on, lora, strength }.
      if (node.inputs) {
        for (const [key, value] of Object.entries(node.inputs)) {
          if (/^lora_\d+$/i.test(key) && value && typeof value === 'object' && (value as any).on === true && (value as any).lora) {
            let loraPath = String((value as any).lora);
            loraPath = loraPath.replace(/^(?:flux|Flux|FLUX)[\/\-\s]+/i, '');
            loraPath = loraPath.replace(/\.safetensors$/i, '').trim();
            if (loraPath) {
              loras.push({ name: loraPath, weight: (value as any).strength ?? 1.0 });
            }
          }
        }
      }
    } else if (classType.includes('lora') && classType !== 'power lora loader (rgthree)') {
      // Standard LoRA loaders (LoraLoader, LoraLoaderModelOnly, etc.)
      let name = node.inputs?.lora_name || node.widgets_values?.[0] || 'unknown';
      if (name !== 'unknown') {
        name = String(name).replace(/^(?:flux|Flux|FLUX)[\/\-\s]+/i, '');
        name = name.replace(/\.safetensors$/i, '').trim();
      }
      const weight = node.inputs?.strength_model || node.inputs?.weight || node.widgets_values?.[1] || 1.0;
      
      loras.push({ name, weight });
    }

    
    // VAE detection
    if (classType.includes('vae') && classType.includes('loader')) {
      const name = node.inputs?.vae_name || node.widgets_values?.[0] || 'unknown';
      vaes.push({ name });
    }
  }
  
  return { controlnets, loras, vaes };
}

/**
 * Extract edit history from SaveImage and LoadImage nodes
 */
function extractEditHistory(graph: Graph): Array<{ action: string; timestamp?: number; index?: number }> {
  const history: any[] = [];
  
  for (const nodeId in graph) {
    const node = graph[nodeId];
    if (!node.class_type) continue; // Skip nodes without class_type

    if (node.class_type === 'SaveImage') {
      const timestamp = node.inputs?.timestamp || Date.now();
      history.push({ action: 'save', timestamp: Number(timestamp) });
    }
    
    if (node.class_type === 'LoadImage') {
      const filename = node.inputs?.image || node.widgets_values?.[0];
      const index = history.length;
      history.push({ action: 'load', filename, index });
    }
  }
  
  return history.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

/**
 * Detect ComfyUI version from metadata
 */
function extractComfyVersion(workflow: any, prompt: any): string | null {
  // Check workflow metadata
  if (workflow?.version) {
    return String(workflow.version);
  }
  
  if (workflow?.meta?.comfyui_version) {
    return String(workflow.meta.comfyui_version);
  }
  
  // Try regex on combined text
  const text = JSON.stringify(workflow || {}) + JSON.stringify(prompt || {});
  const versionMatch = text.match(/"version"\s*:\s*"?([0-9]+\.[0-9]+\.[0-9]+)"?/);
  if (versionMatch) {
    return versionMatch[1];
  }
  
  return null;
}

/**
 * Constrói um mapa de nós simplificado a partir dos dados do workflow e do prompt.
 */
/**
 * Constrói um mapa de nós simplificado a partir dos dados do workflow e do prompt.
 * Suporta subgrafos (workflows aninhados) via expansão recursiva e resolução de proxies.
 */
function createNodeMap(workflow: any, prompt: any): Graph {
    const graph: Graph = {};
    const outputProxies = new Map<string, [string, number]>();       // "instanceId:slot" -> [internalNodeId, internalSlot]
    const inputProxies = new Map<string, [string, any][]>();        // "instanceId:slot" -> Array of [internalNodeId, internalSlotOrName]
                                                                   // Array supports fan-out: one subgraph input → many internal nodes

    const subgraphs = new Map<string, any>(
        (workflow?.definitions?.subgraphs || []).map((s: any) => [s.id, s])
    );

    /**
     * Resolves an input name for a node by slot index.
     * Tries the NodeRegistry first, then falls back to the node's own JSON
     * input definitions — needed for custom nodes whose real input list is
     * longer than what the registry declares (e.g. TextGenerate).
     */
    const resolveInputNameBySlot = (node: any, slot: number): string | undefined => {
        const nodeDef = NodeRegistry[node?.class_type];
        if (nodeDef) {
            const name = Object.keys(nodeDef.inputs)[slot];
            if (name) return name;
        }
        return node?._json_inputs?.[slot]?.name;
    };

    // 1. Função recursiva para construir o grafo e mapas de proxies
    const processNodes = (nodeList: any[], prefix = "") => {
        if (!nodeList) return;

        for (const wNode of nodeList) {
            const instanceId = prefix ? `${prefix}${wNode.id}` : wNode.id.toString();
            const subgraphDef = subgraphs.get(wNode.type);

            if (subgraphDef) {
                const subPrefix = `${instanceId}:`;
                
                // Processa nós internos recursivamente
                processNodes(subgraphDef.nodes, subPrefix);

                // Mapeia widgets de proxy para os nós internos
                if (subgraphDef.properties?.proxyWidgets && wNode.widgets_values) {
                    subgraphDef.properties.proxyWidgets.forEach((proxy: [string, string], index: number) => {
                        const [internalId, widgetName] = proxy;
                        const targetId = `${subPrefix}${internalId}`;
                        const targetNode = graph[targetId];
                        
                        if (targetNode && wNode.widgets_values[index] !== undefined) {
                            const nodeDef = NodeRegistry[targetNode.class_type];
                            if (nodeDef?.widget_order) {
                                const wIdx = nodeDef.widget_order.indexOf(widgetName);
                                if (wIdx !== -1) {
                                    if (!targetNode.widgets_values) targetNode.widgets_values = [];
                                    targetNode.widgets_values[wIdx] = wNode.widgets_values[index];
                                }
                            } else {
                                // Fallback: se não temos ordem, tentamos injetar no objeto de widgets se o motor suportar
                                (targetNode as any)._proxied_widgets = (targetNode as any)._proxied_widgets || {};
                                (targetNode as any)._proxied_widgets[widgetName] = wNode.widgets_values[index];
                            }
                        }
                    });
                }

                // Build a mapping from subgraph input index → parent widgets_values index.
                // Only used when the subgraph lacks explicit proxyWidgets metadata.
                // Subgraph inputs of connection-only types (VAE, CLIP, MODEL, UPSCALE_MODEL)
                // and inputs with no internal links are skipped — they don't consume a
                // widget value slot.  The remaining "widget-type" inputs map to
                // widgets_values in the order they appear in the subgraph definition.
                const hasProxyWidgets = !!subgraphDef.properties?.proxyWidgets;
                const widgetIndexMap = new Map<number, number>();
                if (!hasProxyWidgets && wNode.widgets_values && wNode.widgets_values.length > 0 && subgraphDef.inputs) {
                    const CONNECTION_TYPES = new Set(['VAE', 'CLIP', 'MODEL', 'UPSCALE_MODEL']);
                    let widgetIdx = 0;
                    for (let i = 0; i < subgraphDef.inputs.length; i++) {
                        const sgInput = subgraphDef.inputs[i];
                        const isConnectionType = CONNECTION_TYPES.has(sgInput.type);
                        const hasLinks = sgInput.linkIds && sgInput.linkIds.length > 0;
                        if (!isConnectionType && hasLinks && widgetIdx < wNode.widgets_values.length) {
                            widgetIndexMap.set(i, widgetIdx);
                            widgetIdx++;
                        }
                    }
                }

                // Mapeia links internos para identificar proxies de I/O
                if (subgraphDef.links) {
                    for (const linkData of subgraphDef.links) {
                        const l = Array.isArray(linkData) ? {
                            origin_id: linkData[1],
                            origin_slot: linkData[2],
                            target_id: linkData[3],
                            target_slot: linkData[4],
                            input_name: linkData[6]
                        } : linkData;

                        const originId = l.origin_id.toString();
                        const targetId = l.target_id.toString();

                        if (l.target_id === -20) {
                            // Slot de saída do subgrafo -> Origem interna
                            outputProxies.set(`${instanceId}:${l.target_slot}`, [`${subPrefix}${originId}`, l.origin_slot]);
                        } else if (l.origin_id === -10) {
                            // Slot de entrada do subgrafo -> Destino interno
                            let targetParam = l.input_name;
                            if (!targetParam && typeof l.target_slot === 'number') {
                                targetParam = resolveInputNameBySlot(graph[`${subPrefix}${targetId}`], l.target_slot);
                            }

                            // Resolve the internal input name that this subgraph input feeds
                            const finalInputName = targetParam || l.target_slot;

                            // Check whether this subgraph input is overridden by an
                            // external link on the parent node (matched by name).
                            const sgInputDef = subgraphDef.inputs?.[l.origin_slot];
                            const parentInputs: any[] = wNode.inputs || [];
                            const matchingParentInput = sgInputDef?.name
                                ? parentInputs.find((pi: any) => pi.name === sgInputDef.name)
                                : undefined;
                            const isExternallyLinked = matchingParentInput?.link != null;

                            // If the parent provides a widget value for this subgraph
                            // input AND no external link overrides it, inject the
                            // widget value directly into the internal target node.
                            const mappedWidgetIdx = widgetIndexMap.get(l.origin_slot);
                            if (mappedWidgetIdx !== undefined
                                && !isExternallyLinked
                                && wNode.widgets_values?.[mappedWidgetIdx] !== undefined
                                && finalInputName !== undefined) {
                                const fullTargetId = `${subPrefix}${targetId}`;
                                const targetGraphNode = graph[fullTargetId];
                                if (targetGraphNode) {
                                    targetGraphNode.inputs[finalInputName] = wNode.widgets_values[mappedWidgetIdx];
                                    // Mirror the proxyWidgets behavior: also overwrite the
                                    // internal node's widget slot so widget-index-based
                                    // extraction (e.g. UNETLoader's unet_name) sees the
                                    // instance value instead of the subgraph template default.
                                    const targetNodeDef = NodeRegistry[targetGraphNode.class_type];
                                    if (targetNodeDef?.widget_order) {
                                        const wIdx = targetNodeDef.widget_order.indexOf(finalInputName);
                                        if (wIdx !== -1) {
                                            if (!targetGraphNode.widgets_values) targetGraphNode.widgets_values = [];
                                            targetGraphNode.widgets_values[wIdx] = wNode.widgets_values[mappedWidgetIdx];
                                        }
                                    }
                                }
                            } else {
                                // Otherwise create an input proxy for top-level link resolution
                                const proxyKey = `${instanceId}:${l.origin_slot}`;
                                if (!inputProxies.has(proxyKey)) inputProxies.set(proxyKey, []);
                                inputProxies.get(proxyKey)!.push([`${subPrefix}${targetId}`, finalInputName]);
                            }
                        } else {
                            // Link interno-para-interno
                            const finalSourceId = `${subPrefix}${originId}`;
                            const finalTargetId = `${subPrefix}${targetId}`;
                            const targetNode = graph[finalTargetId];
                            if (targetNode) {
                                let inputName = l.input_name;
                                if (!inputName && typeof l.target_slot === 'number') {
                                    inputName = resolveInputNameBySlot(targetNode, l.target_slot);
                                }
                                if (inputName) {
                                    targetNode.inputs[inputName] = [finalSourceId, l.origin_slot];
                                }
                            }
                        }
                    }
                }
            } else {

                // Nó padrão (não é subgrafo)
                graph[instanceId] = {
                    id: instanceId,
                    class_type: wNode.type,
                    inputs: {},
                    widgets_values: wNode.widgets_values || [],
                    mode: wNode.mode || 0,
                    // Keep the node's own input definitions (name + slot order) so
                    // slot-based name resolution can fall back to them when the
                    // registry doesn't declare the full input list (e.g. custom
                    // nodes like TextGenerate with more inputs than registered).
                    _json_inputs: wNode.inputs || [],
                };
            }
        }
    };

    // Processa nós do workflow (incluindo expansão de subgrafos)
    if (workflow?.nodes) {
        processNodes(workflow.nodes);
    }

    // 2. Sobrepõe dados do prompt (dados de execução)
    // O prompt já pode conter IDs "achatados" (ex: "151:140") se foi gerado pelo ComfyUI backend
    for (const [id, pNode] of Object.entries(prompt || {})) {
        if (!graph[id]) {
            graph[id] = {
                id,
                class_type: (pNode as any).class_type,
                inputs: (pNode as any).inputs || {},
                widgets_values: (pNode as any).widgets_values || [],
                mode: 0,
            };
        } else {
            const node = graph[id];
            if ((pNode as any).inputs) Object.assign(node.inputs, (pNode as any).inputs);
            if ((pNode as any).class_type) node.class_type = (pNode as any).class_type;
            if ((pNode as any).widgets_values) {
                node.widgets_values = (pNode as any).widgets_values;
            } else {
                // Execution prompt carries its values in `inputs` (no widget list).
                // Rebuild widgets_values from them so widget-index-based extraction
                // sees what actually ran — the UI-template widget slots can be
                // misaligned by subgraph widget propagation (e.g. a VAE name landing
                // in a UNETLoader's slot 0). Holes are preserved to keep
                // widget_order alignment (e.g. KSampler's "__unknown__" placeholder).
                const nodeDef = NodeRegistry[node.class_type];
                if (nodeDef?.widget_order && (pNode as any).inputs) {
                    const rebuilt: any[] = [];
                    let hasValue = false;
                    for (let wi = 0; wi < nodeDef.widget_order.length; wi++) {
                        const key = nodeDef.widget_order[wi];
                        const value = (pNode as any).inputs[key];
                        if (value !== undefined && !Array.isArray(value)) {
                            rebuilt[wi] = value;
                            hasValue = true;
                        }
                    }
                    if (hasValue) node.widgets_values = rebuilt;
                }
            }
        }
    }

    // 3. Resolve links de nível superior (workflow.links) usando os mapas de proxies
    const resolveOutputProxy = (nodeId: string, slot: number): [string, number] => {
        const key = `${nodeId}:${slot}`;
        if (outputProxies.has(key)) {
            const [intId, intSlot] = outputProxies.get(key)!;
            return resolveOutputProxy(intId, intSlot); // Recursivo para subgrafos aninhados
        }
        return [nodeId, slot];
    };

    if (workflow?.links) {
        for (const link of workflow.links) {
            let [, sourceId, sourceSlot, targetId, targetSlot, , inputName] = link;
            sourceId = sourceId.toString();
            targetId = targetId.toString();

            // Resolve origem através de proxies de saída
            const [finalSourceId, finalSourceSlot] = resolveOutputProxy(sourceId, sourceSlot);

            // Resolve destino através de proxies de entrada
            const targetProxyKey = `${targetId}:${targetSlot}`;
            if (inputProxies.has(targetProxyKey)) {
                const entries = inputProxies.get(targetProxyKey)!;
                for (const [intTargetId, intTargetSlotOrName] of entries) {
                    const targetNode = graph[intTargetId];
                    if (targetNode) {
                        const finalInputName = typeof intTargetSlotOrName === 'string' ? intTargetSlotOrName : inputName;
                        targetNode.inputs[finalInputName] = [finalSourceId, finalSourceSlot];
                    }
                }
            } else {
                const targetNode = graph[targetId];
                if (targetNode) {
                    // Tenta resolver o nome do input a partir do slot se estiver faltando (comum em arquivos .json)
                    if (!inputName && typeof targetSlot === 'number') {
                        inputName = resolveInputNameBySlot(targetNode, targetSlot);
                    }
                    if (inputName) {
                        targetNode.inputs[inputName] = [finalSourceId, finalSourceSlot];
                    }
                }
            }
        }
    }

    return graph;
}




/** Input names that carry a LATENT upstream of a sampler. */
const LATENT_INPUT_NAMES = ['latent_image', 'latent', 'samples'];

/**
 * True when a sampler's latent input traces back (through bypassed/muted
 * nodes and regular latent transforms) to an EmptyLatent* source — i.e. the
 * pass that actually generated the image from noise, as opposed to a
 * post-processing pass (upscale/refine) that consumes an encoded image.
 */
function tracesToEmptyLatent(node: ParserNode, graph: Graph): boolean {
    const visited = new Set<string>();
    let current: ParserNode | undefined = node;

    for (let depth = 0; depth < 20 && current; depth++) {
        if (visited.has(current.id)) return false;
        visited.add(current.id);

        let next: ParserNode | undefined;
        for (const inputName of LATENT_INPUT_NAMES) {
            const link = current.inputs?.[inputName];
            if (Array.isArray(link) && link.length === 2) {
                next = graph[link[0]];
                break;
            }
        }
        if (!next) return false;
        if (/Empty.*Latent/i.test(next.class_type || '')) return true;
        // Another ACTIVE sampler upstream ends the search: a generation pass
        // starts from noise, not from another sampler's output. Bypassed (4)
        // and muted (2) samplers pass data through, so keep walking past them.
        if (next.mode !== 2 && next.mode !== 4 && /Sampler/i.test(next.class_type || '')) return false;
        current = next;
    }
    return false;
}

/**
 * Encontra o nó terminal do grafo, que serve como ponto de partida para a travessia.
 * Prioriza nós de geração (KSampler) sobre pós-processamento (UltimateSDUpscale).
 * Ignora nós silenciados (muted).
 */
function findTerminalNode(graph: Graph): ParserNode | null {
    let terminalNode: ParserNode | null = null;
    let kSamplerNode: ParserNode | null = null;
    let generationSamplerNode: ParserNode | null = null;

    for (const nodeId in graph) {
        const node = graph[nodeId];

        // Skip nodes without class_type or muted nodes (mode 2 or 4)
        if (!node.class_type || node.mode === 2 || node.mode === 4) {
            continue;
        }

        const nodeDef = NodeRegistry[node.class_type];

        if (nodeDef?.roles.includes('SINK')) {
            // Priority list for terminal nodes
            if (node.class_type === 'SaveImageWithMetaData') {
                return node; // Highest priority
            }

            // Prioritize KSampler variants and workflow sampler nodes
            if (node.class_type.includes('KSampler') || node.class_type.includes('Sampler') || node.class_type === 'FaceDetailer') {
              if (!kSamplerNode || node.class_type === 'KSampler (Efficient)') {
                kSamplerNode = node;
              }
              // Remember the first sampler fed from an EmptyLatent* source. A
              // workflow can hold several samplers (generation + upscale/refine
              // passes); insertion order alone would pick whichever subgraph
              // instance appears first in the .json nodes array.
              if (!generationSamplerNode && tracesToEmptyLatent(node, graph)) {
                generationSamplerNode = node;
              }
            } else if (!terminalNode || node.class_type === 'SaveImage' || node.class_type === 'UltimateSDUpscale') {
                terminalNode = node;
            }
        }
    }

    // Return the generation sampler if found, then any KSampler, then any SINK
    const result = generationSamplerNode || kSamplerNode || terminalNode;
    return result;
}

/**
 * Generic text-source node types — any node whose primary purpose is to hold/pass text.
 * Used by the global fallback scanner to identify nodes that may contain prompt text.
 */
const TEXT_SOURCE_NODE_TYPES = new Set([
  'ShowText', 'String Literal', 'PrimitiveString', 'PrimitiveStringMultiline',
  'SimpleText', 'Text Concatenate', 'String Concatenate', 'DF_Text_Box',
  'String', 'ACE_TextGoogleTranslate',
  // Video models that carry the prompt in an input (MiniMax H3 family) —
  // the execution value in `inputs.prompt` must be preferred over the
  // subgraph template default sitting in widgets_values.
  'MiniMaxH3ImageToVideo', 'MiniMaxH3TextToVideo',
  // LTX-Video: the LLM prompt generator feeds CLIPTextEncode via a link;
  // its `prompt` input carries the actual text.
  'TextGenerateLTX2Prompt',
]);

/**
 * Names of input fields that typically contain prompt text across all registered node types.
 */
const TEXT_INPUT_NAMES = new Set([
  'text', 'string', 'value', 'Text', 'String',
  'text1', 'text2', 'text3', 'text4',
  'string1', 'string2', 'string3', 'string4',
  'a', 'b', 'c', 'd',
  'clip_l', 't5xxl',
  // Execution prompt inputs (e.g. MiniMax H3 video nodes). These carry what
  // actually ran — they must win over widget values (template defaults).
  'prompt',
]);

/**
 * Recursively collects text from a node and, when a text input is a
 * link, follows it to the upstream node.  This is a best-effort
 * collector for the global fallback — it only follows links that
 * point into recognised text-source nodes so it doesn't wander
 * into unrelated parts of the graph.
 */
function collectTextFromNodeDeep(
  node: ParserNode,
  graph: Graph,
  visited: Set<string> = new Set(),
): string | null {
  if (!node || !node.class_type || node.mode === 2 || node.mode === 4) return null;
  if (visited.has(node.id)) return null;
  visited.add(node.id);

  // --- Catch-all for any node whose text sits directly in inputs ---
  for (const inputName of TEXT_INPUT_NAMES) {
    const raw = node.inputs?.[inputName];
    if (typeof raw === 'string' && raw.length > 3) return raw;
    // If the input is a link to another text-source node, follow it
    if (Array.isArray(raw) && raw.length === 2) {
      const [upstreamId] = raw;
      const upstream = graph[upstreamId];
      if (upstream) {
        const result = collectTextFromNodeDeep(upstream, graph, visited);
        if (result) return result;
      }
    }
  }

  // --- Check widgets_values for long-enough strings ---
  if (Array.isArray(node.widgets_values)) {
    for (const w of node.widgets_values) {
      if (typeof w === 'string' && w.length > 10) return w;
    }
  }

  return null;
}

/**
 * Fallback: Scans the entire graph for any nodes that might contain prompt text.
 * Used when standard graph traversal fails.
 *
 * This is now a three-tier scanner:
 *  Tier 1 — CLIPTextEncode* nodes (the canonical prompt carriers)
 *  Tier 2 — Known text-source node types with deep link following
 *  Tier 3 — Any other node whose widgets_values contain something prompt-shaped
 */
function collectAllPossiblePrompts(graph: Graph): { positive: string[]; negative: string[] } {
  // CLIPTextEncode is the canonical prompt carrier — its text is always the
  // intended generation prompt. Other text-source nodes (PrimitiveStringMultiline,
  // etc.) may contain system prompts, templates, or helper strings that are much
  // longer but are NOT the image prompt. Keep them in separate buckets so we can
  // prefer CLIPTextEncode results.
  const clipPositive: string[] = [];
  const clipNegative: string[] = [];
  const otherPositive: string[] = [];
  const otherNegative: string[] = [];

  for (const nodeId in graph) {
    const node = graph[nodeId];
    if (!node.class_type || node.mode === 2 || node.mode === 4) continue;

    // --- Tier 1: CLIPTextEncode / Flux nodes (HIGHEST PRIORITY) ---
    if (node.class_type.includes('CLIPTextEncode')) {
      // Try the text input first (may be a link)
      const textInput = node.inputs?.text;
      let text: string | null = null;

      if (Array.isArray(textInput) && textInput.length === 2) {
        const [upstreamId] = textInput;
        const upstream = graph[upstreamId];
        if (upstream) {
          text = collectTextFromNodeDeep(upstream, graph);
        }
      }
      if (!text) {
        text = typeof textInput === 'string' ? textInput : null;
      }
      if (!text) {
        text = node.inputs?.clip_l || node.inputs?.t5xxl || null;
      }
      if (!text && node.widgets_values?.length) {
        // Heuristic: the last string widget is often the prompt text
        for (let i = node.widgets_values.length - 1; i >= 0; i--) {
          if (typeof node.widgets_values[i] === 'string') {
            text = node.widgets_values[i];
            break;
          }
        }
      }

      if (text && typeof text === 'string' && text.length > 3) {
        const lower = text.toLowerCase();
        const isLikelyNegative = lower.includes('blurry') || lower.includes('bad quality') ||
          lower.includes('lowres') || lower.includes('watermark') ||
          lower.includes('bad anatomy') || lower.includes('worst quality');
        if (isLikelyNegative) clipNegative.push(text);
        else clipPositive.push(text);
      }
    }

    // --- Tier 2: Known text-source node types (LOWER PRIORITY) ---
    if (TEXT_SOURCE_NODE_TYPES.has(node.class_type)) {
      // Try deep collection (handles linked inputs through concat chains)
      const deepText = collectTextFromNodeDeep(node, graph);
      if (deepText && deepText.length > 3) {
        otherPositive.push(deepText);
        continue;
      }

      // Shallow fallback
      const shallow = node.widgets_values?.[0] || node.inputs?.text ||
        node.inputs?.string || node.inputs?.value;
      if (typeof shallow === 'string' && shallow.length > 5) {
        otherPositive.push(shallow);
      }
    }

    // --- Tier 3: Any unclassified node with prompt-shaped widgets ---
    // Exclude 'Note' and 'MarkdownNote' class types from being picked up as prompts
    if (node.class_type.toLowerCase().includes('note')) continue;

    if (Array.isArray(node.widgets_values)) {
      for (const w of node.widgets_values) {
        if (typeof w === 'string' && w.length > 40 && w.includes(',')) {
          otherPositive.push(w);
          break;
        }
      }
    }
  }

  // Prefer CLIPTextEncode results — they are the canonical prompt source.
  // Only fall back to other text sources (PrimitiveStringMultiline, etc.)
  // if no CLIPTextEncode text was found.
  return {
    positive: clipPositive.length > 0 ? clipPositive : otherPositive,
    negative: clipNegative.length > 0 ? clipNegative : otherNegative,
  };
}

function selectBestFallbackPrompt(candidates: string[]): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Prefer structured JSON prompts (e.g. Ideogram 4.0 captions) over
  // plain-text prompts — they're more specific and less likely to be
  // helper/template text that happened to end up in the candidate list.
  const jsonCandidate = candidates.find(c => {
    try { JSON.parse(c); return true; } catch { return false; }
  });
  if (jsonCandidate) return jsonCandidate;

  // Fall back to the longest candidate
  return candidates.sort((a, b) => b.length - a.length)[0];
}

/**
 * ─── DEEP PROMPT RECONSTRUCTOR ─────────────────────────────────────────
 * A purely topological walker that traces the positive‑conditioning path
 * from the terminal node backwards, collecting ALL text from ALL reachable
 * nodes.  It needs NO node‑registry entries — it works on graph structure
 * alone.  This is the last line of defence when every other strategy fails.
 *
 * Strategy:
 *  1. Find the conditioning link(s) from the terminal node.
 *  2. BFS backwards through the graph, following ALL links.
 *  3. At each visited node, harvest text from:
 *     a. Any input whose VALUE is a plain string ( ≥ 5 chars)
 *     b. Any widget_values entry that is a long string
 *  4. Also try to resolve texts from inputs that are LINKS by walking them.
 *  5. Return the longest candidate (heuristic).
 */
function deepPromptReconstructor(
  terminalNode: ParserNode | null,
  graph: Graph,
  param: 'prompt' | 'negativePrompt',
): string | null {
  // Names of conditioning inputs on terminal nodes (positive vs negative)
  const CONDITIONING_INPUTS: Record<string, string[]> = {
    prompt: ['positive', 'guider', 'conditioning'],
    negativePrompt: ['negative'],
  };

  const targetInputs = CONDITIONING_INPUTS[param] || [];
  const collectedTexts: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [];

  // Seed the queue with conditioning inputs from the terminal node
  if (terminalNode) {
    for (const inputName of targetInputs) {
      const link = terminalNode.inputs?.[inputName];
      if (Array.isArray(link) && link.length === 2) {
        queue.push(link[0]);
      }
    }
  }

  // BFS — follow ALL links to collect text from every reachable node
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    const node = graph[nodeId];
    if (!node || !node.class_type) continue;
    if (node.mode === 2 || node.mode === 4) continue; // muted
    // Skip loader/scaler/preview/note nodes — their widget strings are file
    // names (e.g. "Bana.jpg", "qwen_image_vae.safetensors"), not prompt text.
    if (/(?:Loader|Load|Scale|Preview|Note)/i.test(node.class_type)) continue;
    visited.add(nodeId);

    // Harvest text from this node's inputs
    if (node.inputs) {
      for (const [inputName, value] of Object.entries(node.inputs)) {
        if (typeof value === 'string' && value.length >= 5) {
          collectedTexts.push(value);
        } else if (Array.isArray(value) && value.length === 2) {
          // Follow every link — we're being exhaustive in fallback mode
          const linkId = value[0] as string;
          if (!visited.has(linkId)) {
            queue.push(linkId);
          }
        }
      }
    }

    // Harvest text from widget values
    if (Array.isArray(node.widgets_values)) {
      for (const w of node.widgets_values) {
        if (typeof w === 'string' && w.length >= 5) {
          collectedTexts.push(w);
        }
      }
    }
  }

  if (collectedTexts.length === 0) return null;

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique = collectedTexts.filter(t => {
    const normalized = t.trim();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });

  // Pick the longest as the primary candidate (heuristic that works well)
  return unique.sort((a, b) => b.length - a.length)[0];
}

/**
 * Detects the ComfyUI API/execution prompt format: a map of
 * nodeId → { class_type, inputs } (optionally with _meta). The UI workflow
 * format instead has `nodes`/`links` arrays at the top level.
 */
function isApiPromptFormat(value: any): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).some(
    (v: any) => v && typeof v === 'object' && typeof v.class_type === 'string'
  );
}

/**
 * Ponto de entrada principal. Resolve todos os parâmetros de metadados de um grafo.
 */
export function resolvePromptFromGraph(workflow: any, prompt: any): Record<string, any> {
  // Parse string inputs — ComfyUI PNG metadata stores workflow/prompt as
  // JSON strings inside the metadata object (same as resolveWorkflowFactsFromGraph).
  let parsedWorkflow = workflow;
  let parsedPrompt = prompt;
  if (typeof parsedWorkflow === 'string') {
    try { parsedWorkflow = JSON.parse(parsedWorkflow); } catch { /* keep as-is */ }
  }
  if (typeof parsedPrompt === 'string') {
    try { parsedPrompt = JSON.parse(parsedPrompt); } catch { /* keep as-is */ }
  }

  // ── FORMAT NORMALIZATION ─────────────────────────────────────────────
  // ComfyUI metadata arrives in two shapes:
  //   UI  format: { nodes: [...], links: [...], definitions: {...} }
  //   API format: { "<nodeId>": { class_type, inputs }, ... }
  // Various save/export paths store the API format under the "workflow"
  // key (no nodes/links arrays). Detect it and promote it to the prompt
  // slot — otherwise the graph builder sees an empty workflow and nothing
  // is extracted.
  if (!parsedPrompt && isApiPromptFormat(parsedWorkflow)) {
    parsedPrompt = parsedWorkflow;
    parsedWorkflow = undefined;
  }

  const telemetry = {
    detection_method: 'standard',
    unknown_nodes_count: 0,
    warnings: [] as string[],
  };

  const graph = createNodeMap(parsedWorkflow, parsedPrompt);

  // Count unknown nodes for telemetry
  for (const nodeId in graph) {
    const node = graph[nodeId];
    if (!node.class_type) continue; // Skip nodes without class_type
    if (!NodeRegistry[node.class_type]) {
      telemetry.unknown_nodes_count++;
      telemetry.warnings.push(`Unknown node type: ${node.class_type}`);
    }
  }

  const terminalNode = findTerminalNode(graph);

  // Check if terminal node was found
  if (!terminalNode) {
    telemetry.warnings.push('No terminal node found');
  }

  // Note: width/height are NOT extracted from workflow, they're read from actual image dimensions
  const results = resolveAll({
    startNode: terminalNode,
    graph: graph,
    params: ['prompt', 'negativePrompt', 'seed', 'steps', 'cfg', 'model', 'sampler_name', 'scheduler', 'lora', 'vae', 'denoise']
  });

  // --- TIER 2 FALLBACK: Global graph scanner ---
  // If standard traversal failed to find a prompt, use the global graph scanner
  if (!results.prompt || (typeof results.prompt === 'string' && results.prompt.length < 3)) {
    const fallback = collectAllPossiblePrompts(graph);
    const bestPositive = selectBestFallbackPrompt(fallback.positive);
    if (bestPositive) {
      results.prompt = bestPositive;
      telemetry.warnings.push('Prompt extracted via global graph fallback (standard traversal failed)');
    }

    if (!results.negativePrompt && fallback.negative.length > 0) {
      results.negativePrompt = selectBestFallbackPrompt(fallback.negative);
    }
  }

  // --- TIER 3 FALLBACK: Deep topological reconstructor ---
  // If STILL no prompt, try topology-only walking (works without any node definitions)
  if (!results.prompt || (typeof results.prompt === 'string' && results.prompt.length < 3)) {
    const reconstructed = deepPromptReconstructor(terminalNode, graph, 'prompt');
    if (reconstructed) {
      results.prompt = reconstructed;
      telemetry.warnings.push('Prompt extracted via deep topological reconstructor (last resort)');
    }
  }
  if (!results.negativePrompt || (typeof results.negativePrompt === 'string' && results.negativePrompt.length < 3)) {
    const reconstructedNeg = deepPromptReconstructor(terminalNode, graph, 'negativePrompt');
    if (reconstructedNeg) {
      results.negativePrompt = reconstructedNeg;
      telemetry.warnings.push('Negative prompt extracted via deep topological reconstructor (last resort)');
    }
  }

  // --- SAFEGUARD: If the prompt is not a string (e.g. the parser returned
  // the raw API prompt object), forcibly re-extract from CLIPTextEncode nodes.
  // This prevents the entire node graph from being serialized as the "prompt".
  if (results.prompt && typeof results.prompt !== 'string') {
    telemetry.warnings.push(
      `Prompt was non-string (${typeof results.prompt}) — forcibly re-extracting from CLIPTextEncode`,
    );
    const fallback = collectAllPossiblePrompts(graph);
    const bestPositive = selectBestFallbackPrompt(fallback.positive);
    results.prompt = bestPositive || '';
  }

  // Post-processing: deduplicate arrays BEFORE cleaning prompts
  if (results.lora && Array.isArray(results.lora)) {
    // Remove duplicates while preserving order of first appearance
    results.lora = Array.from(new Set(results.lora));
  }

  // Clean up extracted prompt text
  if (results.prompt && typeof results.prompt === 'string') {
    // Detect if the prompt is structured JSON (e.g. Ideogram 4.0 captions).
    // JSON prompts must be preserved as-is — collapsing whitespace would
    // destroy their syntax and make them unparseable.
    let isJsonPrompt = false;
    try {
      JSON.parse(results.prompt);
      isJsonPrompt = true;
    } catch {
      // Not JSON — apply normal natural-language cleanup below
    }

    if (isJsonPrompt) {
      // Preserve JSON structure; only trim surrounding whitespace
      results.prompt = results.prompt.trim();
    } else {
      // 1. Deduplicate comma-separated segments
      const segments = results.prompt.split(/,\s*/).filter(s => s.trim());
      const uniqueSegments = Array.from(new Set(segments));
      if (uniqueSegments.length < segments.length) {
        results.prompt = uniqueSegments.join(', ');
      }

      // 2. Normalize newlines and multiple spaces to a single space
      results.prompt = results.prompt.replace(/\n+/g, ' ').replace(/  +/g, ' ').replace(/\.$/, '').trim();

      // 3. Additional check: if the entire prompt is literally repeated (e.g., "abc abc")
      const words = results.prompt.split(/\s+/);
      const half = Math.floor(words.length / 2);
      if (words.length >= 4 && words.length % 2 === 0) {
        const firstHalf = words.slice(0, half).join(' ');
        const secondHalf = words.slice(half).join(' ');
        if (firstHalf === secondHalf && firstHalf.length > 0) {
          results.prompt = firstHalf;
        }
      }
    }
  }




  // Phase 2: Advanced extraction using terminal node
  const advancedSeed = extractAdvancedSeed(terminalNode, graph);
  if (advancedSeed.seed !== null) {
    results.seed = advancedSeed.seed;
    if (advancedSeed.approximateSeed) {
      results.approximateSeed = true;
      telemetry.warnings.push('Seed is approximate (derived from derived_seed or random_seed)');
    }
  }
  
  const advancedModel = extractAdvancedModel(terminalNode, graph);
  if (advancedModel) {
    results.model = advancedModel;
  }
  
  // Extract modifiers (ControlNet, LoRA, VAE)
  const modifiers = extractAdvancedModifiers(graph);
  if (modifiers.controlnets.length > 0) {
    results.controlnets = modifiers.controlnets;
  }
  if (modifiers.loras.length > 0) {
    // Merge with existing lora array from resolveAll
    const existingLoras = results.lora || [];
    results.loras = modifiers.loras; // Detailed lora info
    results.lora = Array.from(new Set([...existingLoras, ...modifiers.loras.map(l => l.name)])); // Backward compatibility
  }
  if (modifiers.vaes.length > 0) {
    results.vaes = modifiers.vaes;
  }
  
  // Extract edit history
  const editHistory = extractEditHistory(graph);
  if (editHistory.length > 0) {
    results.editHistory = editHistory;
  }
  
  // Extract ComfyUI version
  const comfyVersion = extractComfyVersion(workflow, prompt);
  if (comfyVersion) {
    results.comfyui_version = comfyVersion;
  }

  results.generator = 'ComfyUI';

  return { ...results, _telemetry: telemetry };
}

/**
 * Resolve structured workflow facts for ComfyUI graphs.
 * Uses the same graph construction as resolvePromptFromGraph.
 */
export function resolveWorkflowFactsFromGraph(
  workflow: any,
  prompt: any
): WorkflowFacts | null {
  try {
    let parsedWorkflow = workflow;
    let parsedPrompt = prompt;

    if (typeof parsedWorkflow === 'string') {
      parsedWorkflow = JSON.parse(parsedWorkflow);
    }
    if (typeof parsedPrompt === 'string') {
      parsedPrompt = JSON.parse(parsedPrompt);
    }

    if (!parsedWorkflow && !parsedPrompt) {
      return null;
    }

    const graph = createNodeMap(parsedWorkflow, parsedPrompt);
    const terminalNode = findTerminalNode(graph);
    if (!terminalNode) {
      return null;
    }

    return resolveFacts({ startNode: terminalNode, graph });
  } catch (error) {
    console.warn('[ComfyUI Parser] Failed to resolve workflow facts:', error);
    return null;
  }
}

/**
 * Extract metadata from MetaHub Save Node chunk (imagemetahub_data)
 * This chunk contains pre-extracted metadata, eliminating the need for graph traversal
 */
function extractFromMetaHubChunk(rawData: any): Record<string, any> | null {
  try {
    // Check if rawData is an object with imagemetahub_data field
    if (typeof rawData === 'object' && rawData !== null && rawData.imagemetahub_data) {
      const metahubData = rawData.imagemetahub_data;

      // Verify it's valid MetaHub data (must have generator: "ComfyUI")
      if (metahubData.generator === 'ComfyUI') {
        // Extract tags from imh_pro.user_tags (comma-separated string)
        const userTags = metahubData.imh_pro?.user_tags
          ? metahubData.imh_pro.user_tags.split(',').map((tag: string) => tag.trim()).filter((tag: string) => tag)
          : [];

        // Extract notes from imh_pro.notes
        const userNotes = metahubData.imh_pro?.notes || '';

        // Map MetaHub chunk fields to expected format
        return {
          prompt: metahubData.prompt,
          negativePrompt: metahubData.negativePrompt,
          seed: metahubData.seed,
          steps: metahubData.steps,
          cfg: metahubData.cfg,
          sampler_name: metahubData.sampler_name,
          scheduler: metahubData.scheduler,
          model: metahubData.model,
          model_hash: metahubData.model_hash,
          vae: metahubData.vae,
          denoise: metahubData.denoise,
          width: metahubData.width,
          height: metahubData.height,
          loras: metahubData.loras || [],
          lora: metahubData.loras?.map((l: any) => l.name) || [], // Backward compatibility
          tags: userTags,
          notes: userNotes,
          generator: 'ComfyUI',
          _detection_method: 'metahub_chunk',
          _metahub_pro: metahubData.imh_pro || null,
          _analytics: metahubData.analytics || null,
        };
      }
    }

    // Try parsing from string if rawData is a JSON string containing imagemetahub_data
    if (typeof rawData === 'string') {
      try {
        const parsed = JSON.parse(rawData);
        if (parsed.imagemetahub_data) {
          return extractFromMetaHubChunk(parsed);
        }
      } catch {
        // Not a JSON string, continue
      }
    }
  } catch (error) {
    console.warn('[ComfyUI Parser] Failed to extract from MetaHub chunk:', error);
  }

  return null;
}

/**
 * Enhanced parsing with aggressive payload detection and decompression
 * This is the new entry point that should be used for robust ComfyUI parsing
 *
 * Priority:
 * 1. MetaHub Save Node chunk (imagemetahub_data) - fastest, no graph traversal needed
 * 2. Graph traversal (workflow + prompt) - fallback for standard ComfyUI exports
 * 3. Regex extraction - last resort for corrupted/partial data
 */
export async function parseComfyUIMetadataEnhanced(rawData: any): Promise<Record<string, any>> {
  const telemetry = {
    detection_method: 'unknown',
    warnings: [] as string[],
  };

  try {
    // PRIORITY 1: Try MetaHub Save Node chunk first (fastest path)
    const metahubData = extractFromMetaHubChunk(rawData);
    if (metahubData) {
      telemetry.detection_method = 'metahub_chunk';
      return { ...metahubData, _parse_telemetry: telemetry };
    }

    // PRIORITY 2: If already an object, try to parse it directly via graph traversal
    if (typeof rawData === 'object' && rawData !== null) {
      const workflow = rawData.workflow;
      const prompt = rawData.prompt;
      return resolvePromptFromGraph(workflow, prompt);
    }

    // If string, try aggressive payload detection
    if (typeof rawData === 'string') {
      const parseResult = await tryParseComfyPayload(rawData);
      
      if (parseResult) {
        telemetry.detection_method = parseResult.detectionMethod;
        telemetry.warnings = parseResult.warnings;
        
        const data = parseResult.data;
        const workflow = data.workflow;
        const prompt = data.prompt;
        
        const results = resolvePromptFromGraph(workflow, prompt);
        return { ...results, _parse_telemetry: telemetry };
      }
    }

    // Fallback: try regex extraction if all else fails
    const textData = typeof rawData === 'string' ? rawData : JSON.stringify(rawData);
    const regexParams = extractParamsWithRegex(textData);
    
    if (Object.keys(regexParams).length > 1) {
      telemetry.detection_method = 'regex_only';
      return { ...regexParams, _parse_telemetry: telemetry };
    }

  } catch (error) {
    telemetry.warnings.push(`Parse error: ${error}`);
    console.error('[ComfyUI Parser Enhanced] Error:', error);
  }

  return { _parse_telemetry: telemetry };
}

