#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { telegramMessageInputSchema, sendTelegramMessage } from "@ferfarbader/sendkit-core";

const server = new McpServer({
  name: "sendkit-local",
  version: "0.0.0",
});

function getTelegramToken() {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_TOKEN environment variable is not set");
  }
  return token;
}
server.registerTool(
  "telegram",
  {
    title: "Telegram",
    description: "Send a telegram message",
    inputSchema: telegramMessageInputSchema.shape,
  },
  async (input) => {
    const result = await sendTelegramMessage({
      ...input,
      botToken: getTelegramToken(),
    });
    return {
      content: [
        {
          type: "text",
          text: `Message sent to ${input.chatId} with messageId ${result.messageId}`,
        },
      ],
      structuredContent: result,
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
