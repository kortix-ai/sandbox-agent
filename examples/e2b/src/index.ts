import { SandboxAgent } from "sandbox-agent";
import { e2b } from "sandbox-agent/e2b";
import { detectAgent } from "@sandbox-agent/example-shared";

const envs: Record<string, string> = {};
if (process.env.ANTHROPIC_API_KEY) envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (process.env.OPENAI_API_KEY) envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = await SandboxAgent.start({
  sandbox: e2b({ create: { envs } }),
});

const session = await client.createSession({
  agent: detectAgent(),
  cwd: "/home/user",
});

session.onEvent((event) => {
  console.log(`[${event.sender}]`, JSON.stringify(event.payload));
});

session.prompt([{ type: "text", text: "Say hello from E2B in one sentence." }]);

process.once("SIGINT", async () => {
  await client.destroySandbox();
  process.exit(0);
});
