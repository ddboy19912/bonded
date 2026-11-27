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

/**
 * One colour per provider, as Artificial Analysis does: each brand's own shade, tuned to read on the
 * near-black page. Z.ai's mark is black, so it is drawn light here; Qwen's violet is lifted a step.
 * Meta and DeepSeek are both blue in their branding, so the logo and name under every bar still
 * say which model it is; colour alone doesn't. A provider not listed takes the neutral grey.
 */
export const PROVIDER_COLORS: Record<string, string> = {
  Anthropic: "#e07a5a",
  Meta: "#1a8cff",
  DeepSeek: "#5b78ff",
  Qwen: "#7c5cf0",
  "Z.ai": "#e4e6ea",
};

export const providerColor = (provider: string) => PROVIDER_COLORS[provider] ?? "#8a8f9a";
