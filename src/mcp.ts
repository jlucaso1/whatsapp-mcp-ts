import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { jidNormalizedUser } from "@whiskeysockets/baileys";

import {
  type Message as DbMessage,
  type Chat as DbChat,
  getMessages,
  getChats,
  getChat,
  getMessagesAround,
  searchDbForContacts,
  searchMessages,
} from "./database.ts";

import { sendWhatsAppMessage, type WhatsAppSocket } from "./whatsapp.ts";
import { type P } from "pino";

function formatDbMessageForJson(msg: DbMessage) {
  return {
    id: msg.id,
    chat_jid: msg.chat_jid,
    chat_name: msg.chat_name ?? "Unknown Chat",
    sender_jid: msg.sender ?? null,
    sender_display: msg.sender
      ? msg.sender.split("@")[0]
      : msg.is_from_me
        ? "Me"
        : "Unknown",
    content: msg.content,
    timestamp: msg.timestamp.toISOString(),
    is_from_me: msg.is_from_me,
  };
}

function formatDbChatForJson(chat: DbChat) {
  return {
    jid: chat.jid,
    name: chat.name ?? chat.jid.split("@")[0] ?? "Unknown Chat",
    is_group: chat.jid.endsWith("@g.us"),
    last_message_time: chat.last_message_time?.toISOString() ?? null,
    last_message_preview: chat.last_message ?? null,
    last_sender_jid: chat.last_sender ?? null,
    last_sender_display: chat.last_sender
      ? chat.last_sender.split("@")[0]
      : chat.last_is_from_me
        ? "Me"
        : null,
    last_is_from_me: chat.last_is_from_me ?? null,
  };
}

export async function startMcpServer(
  sock: WhatsAppSocket | null,
  mcpLogger: P.Logger,
  waLogger: P.Logger,
): Promise<void> {
  mcpLogger.info("Initializing MCP server...");

  const server = new McpServer({
    name: "whatsapp-baileys-ts",
    version: "0.1.0",
    capabilities: {
      tools: {},
      resources: {},
    },
  });

  server.tool(
    "search_contacts",
    {
      query: z
        .string()
        .min(1)
        .describe("Search term for contact name or phone number part of JID"),
    },
    async ({ query }) => {
      mcpLogger.info(
        `[MCP Tool] Executing search_contacts with query: "${query}"`,
      );
      try {
        const contacts = searchDbForContacts(query, 20);
        const formattedContacts = contacts.map((c) => ({
          jid: c.jid,
          name: c.name ?? c.jid.split("@")[0],
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedContacts, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] search_contacts failed: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error searching contacts: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "list_messages",
    {
      chat_jid: z
        .string()
        .describe(
          "The JID of the chat (e.g., '123456@s.whatsapp.net' or 'group@g.us')",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(20)
        .describe("Max messages per page (default 20)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
    },
    async ({ chat_jid, limit, page }) => {
      mcpLogger.info(
        `[MCP Tool] Executing list_messages for chat ${chat_jid}, limit=${limit}, page=${page}`,
      );
      try {
        const messages = getMessages(chat_jid, limit, page);
        if (!messages.length && page === 0) {
          return {
            content: [
              { type: "text", text: `No messages found for chat ${chat_jid}.` },
            ],
          };
        } else if (!messages.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more messages found on page ${page} for chat ${chat_jid}.`,
              },
            ],
          };
        }
        const formattedMessages = messages.map(formatDbMessageForJson);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedMessages, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] list_messages failed for ${chat_jid}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error listing messages for ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "list_chats",
    {
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(20)
        .describe("Max chats per page (default 20)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
      sort_by: z
        .enum(["last_active", "name"])
        .optional()
        .default("last_active")
        .describe("Sort order: 'last_active' (default) or 'name'"),
      query: z
        .string()
        .optional()
        .describe("Optional filter by chat name or JID"),
      include_last_message: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include last message details (default true)"),
    },
    async ({ limit, page, sort_by, query, include_last_message }) => {
      mcpLogger.info(
        `[MCP Tool] Executing list_chats: limit=${limit}, page=${page}, sort=${sort_by}, query=${query}, lastMsg=${include_last_message}`,
      );
      try {
        const chats = getChats(
          limit,
          page,
          sort_by,
          query ?? null,
          include_last_message,
        );
        if (!chats.length && page === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No chats found${query ? ` matching "${query}"` : ""}.`,
              },
            ],
          };
        } else if (!chats.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more chats found on page ${page}${
                  query ? ` matching "${query}"` : ""
                }.`,
              },
            ],
          };
        }
        const formattedChats = chats.map(formatDbChatForJson);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedChats, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(`[MCP Tool Error] list_chats failed: ${error.message}`);
        return {
          isError: true,
          content: [
            { type: "text", text: `Error listing chats: ${error.message}` },
          ],
        };
      }
    },
  );

  server.tool(
    "get_chat",
    {
      chat_jid: z.string().describe("The JID of the chat to retrieve"),
      include_last_message: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include last message details (default true)"),
    },
    async ({ chat_jid, include_last_message }) => {
      mcpLogger.info(
        `[MCP Tool] Executing get_chat for ${chat_jid}, lastMsg=${include_last_message}`,
      );
      try {
        const chat = getChat(chat_jid, include_last_message);
        if (!chat) {
          return {
            isError: true,
            content: [
              { type: "text", text: `Chat with JID ${chat_jid} not found.` },
            ],
          };
        }
        const formattedChat = formatDbChatForJson(chat);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedChat, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] get_chat failed for ${chat_jid}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error retrieving chat ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "get_message_context",
    {
      message_id: z
        .string()
        .describe("The ID of the target message to get context around"),
      before: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(5)
        .describe("Number of messages before (default 5)"),
      after: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(5)
        .describe("Number of messages after (default 5)"),
    },
    async ({ message_id, before, after }) => {
      mcpLogger.info(
        `[MCP Tool] Executing get_message_context for msg ${message_id}, before=${before}, after=${after}`,
      );
      try {
        const context = getMessagesAround(message_id, before, after);
        if (!context.target) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Message with ID ${message_id} not found.`,
              },
            ],
          };
        }
        const formattedContext = {
          target: formatDbMessageForJson(context.target),
          before: context.before.map(formatDbMessageForJson),
          after: context.after.map(formatDbMessageForJson),
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedContext, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] get_message_context failed for ${message_id}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error retrieving context for message ${message_id}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "send_message",
    {
      recipient: z
        .string()
        .describe(
          "Recipient JID (user or group, e.g., '12345@s.whatsapp.net' or 'group123@g.us')",
        ),
      message: z.string().min(1).describe("The text message to send"),
    },
    async ({ recipient, message }) => {
      mcpLogger.info(`[MCP Tool] Executing send_message to ${recipient}`);
      if (!sock) {
        mcpLogger.error(
          "[MCP Tool Error] send_message failed: WhatsApp socket is not available.",
        );
        return {
          isError: true,
          content: [
            { type: "text", text: "Error: WhatsApp connection is not active." },
          ],
        };
      }

      let normalizedRecipient: string;
      try {
        normalizedRecipient = jidNormalizedUser(recipient);
        if (!normalizedRecipient.includes("@")) {
          throw new Error('JID must contain "@" symbol');
        }
      } catch (normError: any) {
        mcpLogger.error(
          `[MCP Tool Error] Invalid recipient JID format: ${recipient}. Error: ${normError.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Invalid recipient format: "${recipient}". Please provide a valid JID (e.g., number@s.whatsapp.net or group@g.us).`,
            },
          ],
        };
      }

      try {
        const result = await sendWhatsAppMessage(
          waLogger,
          sock,
          normalizedRecipient,
          message,
        );

        if (result && result.key && result.key.id) {
          return {
            content: [
              {
                type: "text",
                text: `Message sent successfully to ${normalizedRecipient} (ID: ${result.key.id}).`,
              },
            ],
          };
        } else {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed to send message to ${normalizedRecipient}. See server logs for details.`,
              },
            ],
          };
        }
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] send_message failed for ${recipient}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            { type: "text", text: `Error sending message: ${error.message}` },
          ],
        };
      }
    },
  );

  server.tool(
    "search_messages",
    {
      query: z
        .string()
        .min(1)
        .describe("The text content to search for within messages"),
      chat_jid: z
        .string()
        .optional()
        .describe(
          "Optional: The JID of a specific chat to search within (e.g., '123...net' or 'group@g.us'). If omitted, searches all chats.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(10)
        .describe("Max messages per page (default 10)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
    },
    async ({ chat_jid, query, limit, page }) => {
      const searchScope = chat_jid ? `in chat ${chat_jid}` : "across all chats";
      mcpLogger.info(
        `[MCP Tool] Executing search_messages ${searchScope}, query="${query}", limit=${limit}, page=${page}`,
      );
      try {
        const messages = searchMessages(query, chat_jid, limit, page);

        if (!messages.length && page === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No messages found containing "${query}" in chat ${chat_jid}.`,
              },
            ],
          };
        } else if (!messages.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more messages found containing "${query}" on page ${page} for chat ${chat_jid}.`,
              },
            ],
          };
        }

        const formattedMessages = messages.map(formatDbMessageForJson);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedMessages, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] search_messages_in_chat failed for ${chat_jid} / "${query}": ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error searching messages in chat ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.resource("db_schema", "schema://whatsapp/main", async (uri) => {
    mcpLogger.info(`[MCP Resource] Request for ${uri.href}`);
    const schemaText = `
TABLE chats (jid TEXT PK, name TEXT, last_message_time TIMESTAMP)
TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN, PK(id, chat_jid), FK(chat_jid) REFERENCES chats(jid))
            `.trim();
    return {
      contents: [
        {
          uri: uri.href,
          text: schemaText,
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  mcpLogger.info("MCP server configured. Connecting stdio transport...");

  try {
    await server.connect(transport);
    mcpLogger.info(
      "MCP transport connected. Server is ready and listening via stdio.",
    );
  } catch (error: any) {
    mcpLogger.error(
      `[FATAL] Failed to connect MCP transport: ${error.message}`,
      error,
    );
    process.exit(1);
  }

  mcpLogger.info(
    "MCP Server setup complete. Waiting for requests from client...",
  );
}
