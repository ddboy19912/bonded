import claude from "../assets/providers/claude.svg";
import deepseek from "../assets/providers/deepseek.svg";
import meta from "../assets/providers/meta.svg";
import qwen from "../assets/providers/qwen.svg";
import zai from "../assets/providers/zai.svg";

/**
 * Each model provider's mark (assets/providers/). Kept apart from the chart components so a page
 * can show the marks without loading the charting library.
 */
export const PROVIDER_LOGOS: Record<string, string> = {
  Meta: meta,
  DeepSeek: deepseek,
  "Z.ai": zai,
  Qwen: qwen,
  Anthropic: claude,
};
