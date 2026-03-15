import fs from 'fs';
import { resolvePromptFromGraph } from './services/parsers/comfyUIParser';

async function run() {
  const jsonStr = fs.readFileSync('temp_user.json', 'utf8');
  let data = JSON.parse(jsonStr);
  
  const result = resolvePromptFromGraph(data, {});
  console.log('Result LORAS:', JSON.stringify(result.loras, null, 2));
  console.log('Result LORA (flat):', JSON.stringify(result.lora, null, 2));
  console.log('Result FULL:', JSON.stringify(result, null, 2));
}
run().catch(console.error);
