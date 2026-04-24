import { resolveAll, resolveFacts } from './comfyui/traversalEngine';
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
  const text = JSON.stringify(workflow) + JSON.stringify(prompt);
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
    const outputProxies = new Map<string, [string, number]>(); // "instanceId:slot" -> [internalNodeId, internalSlot]
    const inputProxies = new Map<string, [string, any]>();     // "instanceId:slot" -> [internalNodeId, internalSlotOrName]

    const subgraphs = new Map<string, any>(
        (workflow?.definitions?.subgraphs || []).map((s: any) => [s.id, s])
    );

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
                                const targetNode = graph[`${subPrefix}${targetId}`];
                                if (targetNode) {
                                    const nodeDef = NodeRegistry[targetNode.class_type];
                                    if (nodeDef) {
                                        targetParam = Object.keys(nodeDef.inputs)[l.target_slot];
                                    }
                                }
                            }
                            inputProxies.set(`${instanceId}:${l.origin_slot}`, [`${subPrefix}${targetId}`, targetParam || l.target_slot]);
                        } else {
                            // Link interno-para-interno
                            const finalSourceId = `${subPrefix}${originId}`;
                            const finalTargetId = `${subPrefix}${targetId}`;
                            const targetNode = graph[finalTargetId];
                            if (targetNode) {
                                let inputName = l.input_name;
                                if (!inputName && typeof l.target_slot === 'number') {
                                    const nodeDef = NodeRegistry[targetNode.class_type];
                                    if (nodeDef) {
                                        inputName = Object.keys(nodeDef.inputs)[l.target_slot];
                                    }
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
            if ((pNode as any).widgets_values) node.widgets_values = (pNode as any).widgets_values;
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
                const [intTargetId, intTargetSlotOrName] = inputProxies.get(targetProxyKey)!;
                const targetNode = graph[intTargetId];
                if (targetNode) {
                    const finalInputName = typeof intTargetSlotOrName === 'string' ? intTargetSlotOrName : inputName;
                    targetNode.inputs[finalInputName] = [finalSourceId, finalSourceSlot];
                }
            } else {
                const targetNode = graph[targetId];
                if (targetNode) {
                    // Tenta resolver o nome do input a partir do slot se estiver faltando (comum em arquivos .json)
                    if (!inputName && typeof targetSlot === 'number') {
                        const nodeDef = NodeRegistry[targetNode.class_type];
                        if (nodeDef) {
                            inputName = Object.keys(nodeDef.inputs)[targetSlot];
                        }
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




/**
 * Encontra o nó terminal do grafo, que serve como ponto de partida para a travessia.
 * Prioriza nós de geração (KSampler) sobre pós-processamento (UltimateSDUpscale).
 * Ignora nós silenciados (muted).
 */
function findTerminalNode(graph: Graph): ParserNode | null {
    let terminalNode: ParserNode | null = null;
    let kSamplerNode: ParserNode | null = null;

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
            } else if (!terminalNode || node.class_type === 'SaveImage' || node.class_type === 'UltimateSDUpscale') {
                terminalNode = node;
            }
        }
    }

    // Return KSampler if found, otherwise return any SINK node
    const result = kSamplerNode || terminalNode;
    return result;
}

/**
 * Fallback: Scans the entire graph for any nodes that might contain prompt text.
 * Used when standard graph traversal fails.
 */
function collectAllPossiblePrompts(graph: Graph): { positive: string[]; negative: string[] } {
  const positive: string[] = [];
  const negative: string[] = [];

  for (const nodeId in graph) {
    const node = graph[nodeId];
    if (!node.class_type || node.mode === 2 || node.mode === 4) continue;

    // 1. Check for CLIPTextEncode / Flux nodes
    if (node.class_type.includes('CLIPTextEncode')) {
      // Try to find the text widget/input
      const text = node.inputs?.text || node.inputs?.clip_l || node.inputs?.t5xxl || 
                   node.widgets_values?.[0] || node.widgets_values?.[node.widgets_values.length - 1];
      
      if (typeof text === 'string' && text.length > 3) {
        // Simple heuristic: if it contains words common in negative prompts, it might be negative
        const lower = text.toLowerCase();
        const isLikelyNegative = lower.includes('blurry') || lower.includes('bad quality') || lower.includes('lowres') || lower.includes('watermark');
        
        if (isLikelyNegative) negative.push(text);
        else positive.push(text);
      }
    }

    // 2. Check for specialized Text/String nodes
    if (['ShowText', 'String Literal', 'PrimitiveString', 'SimpleText', 'Text Concatenate'].includes(node.class_type)) {
      const text = node.widgets_values?.[0] || node.inputs?.text || node.inputs?.string || node.inputs?.value;
      if (typeof text === 'string' && text.length > 10) {
        positive.push(text);
      }
    }
  }

  return { positive, negative };
}

function selectBestFallbackPrompt(candidates: string[]): string | null {
  if (candidates.length === 0) return null;
  // Pick the longest string as it's likely the actual prompt
  return candidates.sort((a, b) => b.length - a.length)[0];
}

/**
 * Ponto de entrada principal. Resolve todos os parâmetros de metadados de um grafo.
 */
export function resolvePromptFromGraph(workflow: any, prompt: any): Record<string, any> {
  const telemetry = {
    detection_method: 'standard',
    unknown_nodes_count: 0,
    warnings: [] as string[],
  };
  
  const graph = createNodeMap(workflow, prompt);
  
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

  // --- GLOBAL FALLBACK ---
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

  // Post-processing: deduplicate arrays BEFORE cleaning prompts
  if (results.lora && Array.isArray(results.lora)) {
    // Remove duplicates while preserving order of first appearance
    results.lora = Array.from(new Set(results.lora));
  }

  // Fix duplicated prompts - check if prompt contains repeated segments
  if (results.prompt && typeof results.prompt === 'string') {
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

