/**
 * Second-pass repair when jsonrepair + JSON.parse still fail (common with nested quotes in LLM output).
 */

import { chatCompleteJsonPrefer } from "../../infrastructure/openai.js";

const MAX_IN = 16_000;

/**
 * Ask the model to emit a single valid JSON object fixing syntax errors in `broken`.
 */
export async function repairCalibrationJson(broken: string, logLabel: string): Promise<string> {
  const clipped =
    broken.length > MAX_IN ? `${broken.slice(0, MAX_IN)}\n… (truncated for repair)` : broken;
  const res = await chatCompleteJsonPrefer({
    logLabel: `repairCalibrationJson ${logLabel}`,
    messages: [
      {
        role: "user",
        content:
          "The following text was meant to be ONE JSON object but it is invalid JSON (often bad quotes or commas in arrays). " +
          "Fix it so JSON.parse succeeds. Rules: (1) Output ONLY the JSON object, no markdown, no code fences, no commentary. " +
          "(2) Every string value must escape internal double quotes as \\\". " +
          "(3) Arrays must have commas between elements. (4) Use JSON null where appropriate.\n\n" +
          clipped,
      },
    ],
    max_completion_tokens: 3_072,
    temperature: 0,
  });
  return res.choices[0]?.message?.content?.trim() ?? "";
}
