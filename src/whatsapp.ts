import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  type WAMessage,
  type proto,
  isJidGroup,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import P from "pino";
import path from "node:path";
import open from "open";

import {
  initializeDatabase,
  storeMessage,
  storeChat,
  type Message as DbMessage,
} from "./database.ts";

const AUTH_DIR = path.join(import.meta.dirname, "..", "auth_info");

export type WhatsAppSocket = ReturnType<typeof makeWASocket>;

function parseMessageForDb(msg: WAMessage): DbMessage | null {
  if (!msg.message || !msg.key || !msg.key.remoteJid) {
    return null;
  }

  let content: string | null = null;
  const messageType = Object.keys(msg.message)[0];

  if (msg.message.conversation) {
    content = msg.message.conversation;
  } else if (msg.message.extendedTextMessage?.text) {
    content = msg.message.extendedTextMessage.text;
  } else if (msg.message.imageMessage?.caption) {
    content = `[Image] ${msg.message.imageMessage.caption}`;
  } else if (msg.message.videoMessage?.caption) {
    content = `[Video] ${msg.message.videoMessage.caption}`;
  } else if (msg.message.documentMessage?.caption) {
    content = `[Document] ${
      msg.message.documentMessage.caption ||
      msg.message.documentMessage.fileName ||
      ""
    }`;
  } else if (msg.message.audioMessage) {
    content = `[Audio]`;
  } else if (msg.message.stickerMessage) {
    content = `[Sticker]`;
  } else if (msg.message.locationMessage?.address) {
    content = `[Location] ${msg.message.locationMessage.address}`;
  } else if (msg.message.contactMessage?.displayName) {
    content = `[Contact] ${msg.message.contactMessage.displayName}`;
  } else if (msg.message.pollCreationMessage?.name) {
    content = `[Poll] ${msg.message.pollCreationMessage.name}`;
  }

  if (!content) {
    return null;
  }

  const timestampNum =
    typeof msg.messageTimestamp === "number"
      ? msg.messageTimestamp * 1000
      : typeof msg.messageTimestamp === "bigint"
      ? Number(msg.messageTimestamp) * 1000
      : Date.now();

  const timestamp = new Date(timestampNum);

  let senderJid: string | null | undefined = msg.key.participant;
  if (!msg.key.fromMe && !senderJid && !isJidGroup(msg.key.remoteJid)) {
    senderJid = msg.key.remoteJid;
  }
  if (msg.key.fromMe && !isJidGroup(msg.key.remoteJid)) {
    senderJid = null;
  }

  return {
    id: msg.key.id!,
    chat_jid: msg.key.remoteJid,
    sender: senderJid ? jidNormalizedUser(senderJid) : null,
    content: content,
    timestamp: timestamp,
    is_from_me: msg.key.fromMe ?? false,
  };
}

export async function startWhatsAppConnection(
  logger: P.Logger
): Promise<WhatsAppSocket> {
  initializeDatabase();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
    shouldIgnoreJid: (jid) => isJidGroup(jid),
  });

  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info(
          { qrCodeData: qr },
          "QR Code Received. Copy the qrCodeData string and use a QR code generator (e.g., online website) to display and scan it with your WhatsApp app."
        );
        // for now we roughly open the QR code in a browser
        await open(`https://quickchart.io/qr?text=${encodeURIComponent(qr)}`);
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        logger.warn(
          `Connection closed. Reason: ${
            DisconnectReason[statusCode as number] || "Unknown"
          }`,
          lastDisconnect?.error
        );
        if (statusCode !== DisconnectReason.loggedOut) {
          logger.info("Reconnecting...");
          startWhatsAppConnection(logger);
        } else {
          logger.error(
            "Connection closed: Logged Out. Please delete auth_info and restart."
          );
          process.exit(1);
        }
      } else if (connection === "open") {
        logger.info(`Connection opened. WA user: ${sock.user?.name}`);
        console.log("Logged as", sock.user?.name);
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
      logger.info("Credentials saved.");
    }

    if (events["messaging-history.set"]) {
      const { chats, contacts, messages, isLatest, progress, syncType } =
        events["messaging-history.set"];

      chats.forEach((chat) =>
        storeChat({
          jid: chat.id,
          name: chat.name,
          last_message_time: chat.conversationTimestamp
            ? new Date(Number(chat.conversationTimestamp) * 1000)
            : undefined,
        })
      );

      let storedCount = 0;
      messages.forEach((msg) => {
        const parsed = parseMessageForDb(msg);
        if (parsed) {
          storeMessage(parsed);
          storedCount++;
        }
      });
      logger.info(`Stored ${storedCount} messages from history sync.`);
    }

    if (events["messages.upsert"]) {
      const { messages, type } = events["messages.upsert"];
      logger.info(
        { type, count: messages.length },
        "Received messages.upsert event"
      );

      if (type === "notify" || type === "append") {
        for (const msg of messages) {
          const parsed = parseMessageForDb(msg);
          if (parsed) {
            logger.info(
              {
                msgId: parsed.id,
                chatId: parsed.chat_jid,
                fromMe: parsed.is_from_me,
                sender: parsed.sender,
              },
              `Storing message: ${parsed.content.substring(0, 50)}...`
            );
            storeMessage(parsed);
          } else {
            logger.warn(
              { msgId: msg.key?.id, chatId: msg.key?.remoteJid },
              "Skipped storing message (parsing failed or unsupported type)"
            );
          }
        }
      }
    }

    if (events["chats.update"]) {
      logger.info(
        { count: events["chats.update"].length },
        "Received chats.update event"
      );
      for (const chatUpdate of events["chats.update"]) {
        storeChat({
          jid: chatUpdate.id!,
          name: chatUpdate.name,
          last_message_time: chatUpdate.conversationTimestamp
            ? new Date(Number(chatUpdate.conversationTimestamp) * 1000)
            : undefined,
        });
      }
    }
  });

  return sock;
}

export async function sendWhatsAppMessage(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  recipientJid: string,
  text: string
): Promise<proto.WebMessageInfo | void> {
  if (!sock || !sock.user) {
    logger.error(
      "Cannot send message: WhatsApp socket not connected or initialized."
    );
    return;
  }
  if (!recipientJid) {
    logger.error("Cannot send message: Recipient JID is missing.");
    return;
  }
  if (!text) {
    logger.error("Cannot send message: Message text is empty.");
    return;
  }

  try {
    logger.info(
      `Sending message to ${recipientJid}: ${text.substring(0, 50)}...`
    );
    const normalizedJid = jidNormalizedUser(recipientJid);
    const result = await sock.sendMessage(normalizedJid, { text: text });
    logger.info({ msgId: result?.key.id }, "Message sent successfully");
    return result;
  } catch (error) {
    logger.error({ err: error, recipientJid }, "Failed to send message");
    return;
  }
}
