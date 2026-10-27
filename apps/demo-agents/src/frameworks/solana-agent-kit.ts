import { Keypair } from "@solana/web3.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type Action, createLangchainTools, KeypairWallet, SolanaAgentKit } from "solana-agent-kit";
import type { AgentRunSummary, AgentTask, AgentToolbox, ArenaAgent } from "@bondedhq/shared";
import { ArenaBridge, type Rail, railActions } from "./actions.js";
import { openRouterModel, runLangGraphAgent } from "./langgraph.js";

/**
 * The prompt of Solana Agent Kit's LangGraph example, word for word
 * (github.com/sendaifun/solana-agent-kit, examples/misc/agent-kit-langgraph/src/index.ts,
 * Apache-2.0).
 */
export const SOLANA_AGENT_KIT_TEMPLATE_PROMPT = `You are a helpful agent that can interact onchain using the Solana Agent Kit. You are
    empowered to interact onchain using your tools. If you need funds you can request it from the user and provide your wallet details. If there is a 5XX
    (internal) HTTP error code, ask the user to try again later. If someone asks you to do something you
    can't do with your currently available tools, you must say so, and encourage them to implement it
    themselves using the Solana Agent Kit, recommend they go to https://www.solanaagentkit.xyz for more information. Be
    concise and helpful with your responses. Refrain from restating your tools' descriptions unless it is explicitly requested.`;

/** No RPC is ever called: the Arena's actions don't touch Solana. */
const UNUSED_RPC = "http://127.0.0.1:1";

/**
 * Solana Agent Kit's LangGraph example as an Arena agent: the kit's Action interface and
 * LangChain tool conversion, the example's prompt and ReAct loop. The actions are the Arena's
 * tools, so the kit's own Solana actions are not exercised.
 */
export class SolanaAgentKitAgent implements ArenaAgent {
  readonly name: string;
  constructor(
    readonly model: string,
    private readonly llm: () => BaseChatModel = () => openRouterModel(model),
    /** The rail's tools the template gets: on-chain trading, or off-chain invoice payments. */
    readonly rail: Rail = "onchain",
  ) {
    this.name = `solana-agent-kit-langgraph/${model}`;
  }

  async run(task: AgentTask, tools: AgentToolbox): Promise<AgentRunSummary> {
    const bridge = new ArenaBridge(tools, task.maxSteps);
    const kit = new SolanaAgentKit(
      new KeypairWallet(Keypair.generate(), UNUSED_RPC),
      UNUSED_RPC,
      {},
    );
    // Typed at this boundary: the zod-3 schemas are too deep for TypeScript to infer here.
    const actions = railActions(this.rail, task.tools).map((a) => ({
      name: a.name,
      similes: [],
      description: a.description,
      examples: [],
      schema: a.schema,
      handler: async (_agent: unknown, input: Record<string, unknown>) => ({
        result: await bridge.call(a.name, input),
      }),
    })) as unknown as Action[];
    return runLangGraphAgent({
      model: this.llm(),
      tools: createLangchainTools(kit, actions),
      prompt: SOLANA_AGENT_KIT_TEMPLATE_PROMPT,
      task,
      steps: () => bridge.steps,
      ...(tools.signal ? { signal: tools.signal } : {}),
    });
  }
}
